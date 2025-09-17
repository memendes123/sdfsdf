(function () {
  const loginForm = document.querySelector('[data-login-form]');
  const registerForm = document.querySelector('[data-register-form]');
  const authSection = document.querySelector('[data-auth-section]');
  const dashboardSection = document.querySelector('[data-dashboard]');
  const runButton = document.querySelector('[data-run-button]');
  const runOutput = document.querySelector('[data-run-output]');
  const keyForm = document.querySelector('[data-key-form]');
  const statusBadge = document.querySelector('[data-client-status]');
  const creditsEl = document.querySelector('[data-client-credits]');
  const nameEl = document.querySelector('[data-client-name]');
  const emailEl = document.querySelector('[data-client-email]');
  const discordEl = document.querySelector('[data-client-discord]');
  const rep4repEl = document.querySelector('[data-client-rep4rep]');
  const phoneEl = document.querySelector('[data-client-phone]');
  const webhookEl = document.querySelector('[data-client-webhook]');
  const statusHintEl = document.querySelector('[data-client-status-hint]');
  const logoutButton = document.querySelector('[data-logout]');
  const toastEl = document.querySelector('[data-client-toast]');
  const tabs = document.querySelectorAll('[data-tab]');
  const queueCard = document.querySelector('[data-client-queue]');
  const queueMessageEl = document.querySelector('[data-client-queue-message]');
  const queuePositionEl = document.querySelector('[data-client-queue-position]');
  const queueAheadEl = document.querySelector('[data-client-queue-ahead]');
  const queueEstimateEl = document.querySelector('[data-client-queue-estimate]');
  const queueTotalEl = document.querySelector('[data-client-queue-total]');
  const queueRefreshButton = document.querySelector('[data-client-queue-refresh]');

  const storageKeys = {
    userId: 'rep4repUserId',
    token: 'rep4repToken',
  };

  const state = {
    userId: window.localStorage.getItem(storageKeys.userId) || null,
    token: window.localStorage.getItem(storageKeys.token) || null,
    user: null,
    queue: null,
  };

  let toastTimeout = null;

  function showToast(message, variant = 'success') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.remove('is-visible', 'is-error', 'is-success');
    toastEl.classList.add(variant === 'error' ? 'is-error' : 'is-success');
    void toastEl.offsetWidth;
    toastEl.hidden = false;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastEl.classList.remove('is-visible', 'is-error', 'is-success');
      toastEl.hidden = true;
    }, 4000);
  }

  function switchTab(target) {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.tab === target;
      tab.classList.toggle('is-active', isActive);
    });
    if (!loginForm || !registerForm) return;
    if (target === 'register') {
      loginForm.classList.add('is-hidden');
      registerForm.classList.remove('is-hidden');
    } else {
      registerForm.classList.add('is-hidden');
      loginForm.classList.remove('is-hidden');
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  function setSession({ id, token, user }) {
    state.userId = id;
    state.token = token;
    state.user = user || null;
    if (id && token) {
      window.localStorage.setItem(storageKeys.userId, id);
      window.localStorage.setItem(storageKeys.token, token);
      if (logoutButton) {
        logoutButton.hidden = false;
      }
    }
  }

  function clearSession() {
    state.userId = null;
    state.token = null;
    state.user = null;
    state.queue = null;
    window.localStorage.removeItem(storageKeys.userId);
    window.localStorage.removeItem(storageKeys.token);
    if (logoutButton) {
      logoutButton.hidden = true;
    }
    if (authSection) authSection.classList.remove('is-hidden');
    if (dashboardSection) dashboardSection.classList.add('is-hidden');
    if (runOutput) {
      runOutput.textContent = 'Faça login e cadastre sua key para executar.';
    }
    if (queueCard) {
      queueCard.hidden = true;
    }
  }

  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.userId && state.token) {
      headers.set('x-user-id', state.userId);
      headers.set('x-user-token', state.token);
      headers.set('Authorization', `Bearer ${state.token}`);
    }
    const response = await fetch(path, {
      ...options,
      headers,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok || (data && data.success === false)) {
      const message = data?.error || `Falha ao comunicar com o servidor (${response.status})`;
      throw new Error(message);
    }
    return data;
  }

  function updateStatusBadge(status) {
    if (!statusBadge) return;
    const normalized = ['active', 'blocked', 'pending'].includes(status) ? status : 'pending';
    statusBadge.textContent = status || '--';
    statusBadge.className = `badge badge--status badge--${normalized}`;
  }

  function updateDashboard(user) {
    if (!user) return;
    state.user = user;
    if (nameEl) nameEl.textContent = user.fullName || user.username || '--';
    if (emailEl) emailEl.textContent = user.email || '--';
    if (discordEl) discordEl.textContent = user.discordId || '--';
    if (rep4repEl) rep4repEl.textContent = user.rep4repId || '--';
    if (phoneEl) phoneEl.textContent = user.phoneNumber || '--';
    if (webhookEl) webhookEl.textContent = user.discordWebhookUrl ? 'Configurado' : '—';
    if (creditsEl) creditsEl.textContent = Number.isFinite(user.credits) ? user.credits : 0;
    updateStatusBadge(user.status);
    if (keyForm) {
      const input = keyForm.querySelector('input[name="rep4repKey"]');
      if (input) {
        input.value = user.rep4repKey || '';
      }
      const webhookInput = keyForm.querySelector('input[name="discordWebhookUrl"]');
      if (webhookInput) {
        webhookInput.value = user.discordWebhookUrl || '';
      }
    }

    if (statusHintEl) {
      if (user.status === 'pending') {
        statusHintEl.textContent = 'Conta pendente de aprovação. Aguarde o administrador liberar os créditos.';
      } else if (user.status === 'blocked') {
        statusHintEl.textContent = 'Conta bloqueada. Entre em contato com o administrador para mais detalhes.';
      } else {
        statusHintEl.textContent = 'Você pode executar tarefas sempre que houver créditos disponíveis e uma key válida.';
      }
    }

    if (authSection) authSection.classList.add('is-hidden');
    if (dashboardSection) dashboardSection.classList.remove('is-hidden');
    if (logoutButton) logoutButton.hidden = false;
    refreshRunButton();
    loadQueueStatus();
  }

  function refreshRunButton() {
    if (!runButton) return;
    if (!state.user) {
      runButton.disabled = true;
      runButton.textContent = '▶️ Rodar tarefas';
      return;
    }

    const hasCredits = Number(state.user.credits) > 0;
    const hasKey = Boolean(state.user.rep4repKey);
    const active = state.user.status === 'active';

    runButton.disabled = !(hasCredits && hasKey && active);
    if (!active) {
      runButton.textContent = 'Aguardando aprovação';
    } else if (!hasCredits) {
      runButton.textContent = 'Créditos indisponíveis';
    } else if (!hasKey) {
      runButton.textContent = 'Informe a key primeiro';
    } else {
      runButton.textContent = '▶️ Rodar tarefas';
    }

    if (state.queue && state.queue.queued) {
      runButton.disabled = true;
      const position = Number(state.queue.position);
      const label = Number.isFinite(position) ? `#${position}` : '#?';
      runButton.textContent = `Em fila (${label})`;
    }
  }

  function formatQueueWait(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) {
      return '--';
    }
    const minutes = Math.round(value / 60000);
    if (minutes < 60) {
      return `${minutes} min`;
    }
    const hours = minutes / 60;
    return `${hours.toFixed(hours >= 10 ? 0 : 1)} h`;
  }

  function renderQueueStatus(queue) {
    if (!queueCard) {
      return;
    }

    if (queue && queue.queued) {
      state.queue = queue;
      queueCard.hidden = false;
      const position = Number(queue.position);
      const jobsAhead = Number(queue.jobsAhead);
      if (queueMessageEl) {
        if (queue.job && queue.job.status === 'running') {
          queueMessageEl.textContent = 'Sua ordem está em execução.';
        } else {
          const aheadLabel = Number.isFinite(jobsAhead) ? jobsAhead : Math.max((Number.isFinite(position) ? position - 1 : 0), 0);
          queueMessageEl.textContent = `Sua ordem está na posição ${Number.isFinite(position) ? position : '?'} com ${aheadLabel} pedido(s) antes.`;
        }
      }
      if (queuePositionEl) {
        queuePositionEl.textContent = Number.isFinite(position) ? position : '--';
      }
      if (queueAheadEl) {
        queueAheadEl.textContent = Number.isFinite(jobsAhead)
          ? jobsAhead
          : Math.max((Number.isFinite(position) ? position - 1 : 0), 0);
      }
      if (queueEstimateEl) {
        queueEstimateEl.textContent = queue.estimatedStartAt
          ? new Date(queue.estimatedStartAt).toLocaleString()
          : formatQueueWait(queue.estimatedWaitMs);
      }
      if (queueTotalEl) {
        const total = Number(queue.queueLength);
        queueTotalEl.textContent = Number.isFinite(total) ? total : '--';
      }
    } else {
      state.queue = null;
      if (queueMessageEl) {
        queueMessageEl.textContent = 'Nenhuma ordem aguardando processamento.';
      }
      queueCard.hidden = true;
    }

    refreshRunButton();
  }

  async function loadQueueStatus() {
    if (!state.userId || !state.token) {
      renderQueueStatus(null);
      return;
    }
    try {
      const data = await apiFetch('/api/user/queue');
      if (data?.queue) {
        renderQueueStatus(data.queue);
      } else {
        renderQueueStatus(null);
      }
    } catch (error) {
      console.warn('[Client] Falha ao consultar fila:', error);
    }
  }

  async function loadProfile() {
    if (!state.userId || !state.token) {
      return;
    }
    try {
      const data = await apiFetch('/api/user/me');
      updateDashboard(data.user);
    } catch (error) {
      console.error('[Client] Falha ao carregar perfil:', error);
      showToast(error.message || 'Sessão expirada. Faça login novamente.', 'error');
      clearSession();
    }
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      clearSession();
      switchTab('login');
      showToast('Sessão encerrada. Até logo!');
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(loginForm);
      const payload = Object.fromEntries(formData.entries());
      loginForm.querySelector('button[type="submit"]').disabled = true;
      try {
        const res = await fetch('/api/user/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.success === false) {
          throw new Error(data.error || 'Falha no login.');
        }
        setSession({ id: data.user.id, token: data.token, user: data.user });
        updateDashboard(data.user);
        loginForm.reset();
        showToast('Login realizado com sucesso.');
      } catch (error) {
        showToast(error.message || 'Não foi possível entrar.', 'error');
      } finally {
        loginForm.querySelector('button[type="submit"]').disabled = false;
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(registerForm);
      const payload = Object.fromEntries(formData.entries());
      registerForm.querySelector('button[type="submit"]').disabled = true;
      try {
        const res = await fetch('/api/user/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.success === false) {
          throw new Error(data.error || 'Não foi possível completar o cadastro.');
        }
        registerForm.reset();
        switchTab('login');
        showToast('Cadastro enviado! Aguarde o administrador liberar sua conta.');
      } catch (error) {
        showToast(error.message || 'Erro ao cadastrar.', 'error');
      } finally {
        registerForm.querySelector('button[type="submit"]').disabled = false;
      }
    });
  }

  if (keyForm) {
    keyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.user) {
        showToast('Faça login antes de salvar a key.', 'error');
        return;
      }
      const formData = new FormData(keyForm);
      const payload = Object.fromEntries(formData.entries());
      try {
        keyForm.querySelector('button[type="submit"]').disabled = true;
        const data = await apiFetch('/api/user/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data?.user) {
          updateDashboard({ ...state.user, ...data.user });
        }
        showToast('Configurações salvas com sucesso.');
      } catch (error) {
        showToast(error.message || 'Não foi possível salvar a key.', 'error');
      } finally {
        keyForm.querySelector('button[type="submit"]').disabled = false;
      }
    });
  }

  if (runButton) {
    runButton.addEventListener('click', async () => {
      if (!state.user) {
        showToast('Faça login antes de executar.', 'error');
        return;
      }
      runButton.disabled = true;
      runOutput.textContent = 'Enviando pedido... aguarde a confirmação.';
      try {
        const data = await apiFetch('/api/user/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'autoRun' }),
        });
        if (data?.queue) {
          const lines = [
            data.message || 'Pedido enfileirado.',
          ];
          const position = Number(data.queue.position);
          const ahead = Number(data.queue.jobsAhead);
          const total = Number(data.queue.queueLength);
          lines.push(`Posição atual: ${Number.isFinite(position) ? position : '--'}`);
          lines.push(`Pedidos à frente: ${Number.isFinite(ahead) ? ahead : Math.max((Number.isFinite(position) ? position - 1 : 0), 0)}`);
          const estimate = data.queue.estimatedStartAt
            ? new Date(data.queue.estimatedStartAt).toLocaleString()
            : formatQueueWait(data.queue.estimatedWaitMs);
          lines.push(`Estimativa para iniciar: ${estimate}`);
          if (Number.isFinite(total)) {
            lines.push(`Pedidos na fila: ${total}`);
          }
          runOutput.textContent = lines.join('\n');
          renderQueueStatus(data.queue);
        } else {
          runOutput.textContent = data.message || 'Pedido registrado.';
          renderQueueStatus(null);
        }
        showToast(data.message || 'Pedido enviado.');
      } catch (error) {
        runOutput.textContent = `❌ ${error.message}`;
        showToast(error.message || 'Falha ao executar.', 'error');
        loadQueueStatus();
      } finally {
        runButton.disabled = false;
        refreshRunButton();
      }
    });
  }

  if (queueRefreshButton) {
    queueRefreshButton.addEventListener('click', () => {
      loadQueueStatus();
    });
  }

  if (state.userId && state.token) {
    loadProfile();
  }
})();
