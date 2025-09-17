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
  const statusHintEl = document.querySelector('[data-client-status-hint]');
  const logoutButton = document.querySelector('[data-logout]');
  const toastEl = document.querySelector('[data-client-toast]');
  const tabs = document.querySelectorAll('[data-tab]');

  const storageKeys = {
    userId: 'rep4repUserId',
    token: 'rep4repToken',
  };

  const state = {
    userId: window.localStorage.getItem(storageKeys.userId) || null,
    token: window.localStorage.getItem(storageKeys.token) || null,
    user: null,
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
    if (creditsEl) creditsEl.textContent = Number.isFinite(user.credits) ? user.credits : 0;
    updateStatusBadge(user.status);
    if (keyForm) {
      const input = keyForm.querySelector('input[name="rep4repKey"]');
      if (input) {
        input.value = user.rep4repKey || '';
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
        showToast('Key atualizada com sucesso.');
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
      runOutput.textContent = 'Executando tarefas... aguarde o resumo.';
      try {
        const data = await apiFetch('/api/user/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'autoRun' }),
        });
        if (data?.summary) {
          const perAccount = Array.isArray(data.summary.perAccount) ? data.summary.perAccount : [];
          const lines = [
            data.message || 'Execução concluída.',
            '',
            `Total de comentários: ${data.summary.totalComments ?? 0}`,
            `Créditos consumidos: ${data.creditsConsumed ?? 0}`,
            `Créditos restantes: ${data.remainingCredits ?? state.user.credits}`,
          ];
          perAccount.forEach((item) => {
            const suffix = item.stoppedEarly ? ' (limite atingido)' : '';
            lines.push(`- ${item.username || 'conta'}: ${item.comments ?? 0}${suffix}`);
          });
          runOutput.textContent = lines.join('\n');
        } else {
          runOutput.textContent = data.message || 'Execução finalizada.';
        }
        const newCredits = Number.isFinite(data.remainingCredits) ? data.remainingCredits : state.user.credits;
        updateDashboard({ ...state.user, credits: newCredits });
        showToast('Execução concluída.');
      } catch (error) {
        runOutput.textContent = `❌ ${error.message}`;
        showToast(error.message || 'Falha ao executar.', 'error');
      } finally {
        runButton.disabled = false;
        refreshRunButton();
      }
    });
  }

  if (state.userId && state.token) {
    loadProfile();
  }
})();
