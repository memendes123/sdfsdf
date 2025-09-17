(function () {
  const panelBase = window.__PANEL_BASE__ || '';
  const buildUrl = (path) => `${panelBase}${path}`;

  const outputEl = document.querySelector('[data-command-output]');
  const toastEl = document.querySelector('[data-toast]');
  const userTableBody = document.querySelector('[data-users-body]');
  const userForm = document.querySelector('[data-user-form]');
  const statEls = {
    total: document.querySelector('[data-stat-total]'),
    ready: document.querySelector('[data-stat-ready]'),
    cooling: document.querySelector('[data-stat-cooling]'),
    comments: document.querySelector('[data-stat-comments]'),
  };
  const watchdogStateEls = document.querySelectorAll('[data-watchdog-state]');
  const watchdogIntervalEls = document.querySelectorAll('[data-watchdog-interval]');
  const watchdogLastRunEls = document.querySelectorAll('[data-watchdog-last-run]');
  const watchdogErrorEl = document.querySelector('[data-watchdog-error]');
  const userEditor = document.querySelector('[data-user-editor]');
  const userEditorForm = document.querySelector('[data-user-editor-form]');
  const userEditorCloseButtons = document.querySelectorAll('[data-user-editor-close]');
  const userEditorTitle = document.querySelector('[data-user-editor-title]');
  const queueLengthEl = document.querySelector('[data-queue-length]');
  const queueAverageEl = document.querySelector('[data-queue-average]');
  const queueBody = document.querySelector('[data-queue-body]');
  const queueHistoryContainer = document.querySelector('[data-queue-history-container]');
  const queueHistoryList = document.querySelector('[data-queue-history]');
  const queueRefreshButton = document.querySelector('[data-queue-refresh]');

  let toastTimeout = null;
  let cachedUsers = [];
  let cachedQueue = window.__INITIAL_QUEUE__ || null;

  function showToast(message, variant = 'success') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.remove('is-visible', 'is-error', 'is-success');
    toastEl.classList.add(variant === 'error' ? 'is-error' : 'is-success');
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toastEl.classList.remove('is-visible', 'is-error', 'is-success');
    }, 4000);
  }

  function renderStats(stats) {
    if (!stats) return;
    if (statEls.total) statEls.total.textContent = stats.total ?? '--';
    if (statEls.ready) statEls.ready.textContent = stats.ready ?? '--';
    if (statEls.cooling) statEls.cooling.textContent = stats.coolingDown ?? '--';
    if (statEls.comments) statEls.comments.textContent = stats.commentsLast24h ?? '--';
  }

  function statusLabel(status) {
    switch (status) {
      case 'active':
        return 'ativo';
      case 'blocked':
        return 'bloqueado';
      case 'pending':
        return 'pendente';
      default:
        return status || 'indefinido';
    }
  }

  function renderUsers(users) {
    if (!userTableBody) return;
    cachedUsers = Array.isArray(users) ? users : [];
    userTableBody.innerHTML = '';

    if (!Array.isArray(users) || users.length === 0) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'is-center is-muted';
      cell.textContent = 'Nenhum cliente cadastrado ainda.';
      emptyRow.appendChild(cell);
      userTableBody.appendChild(emptyRow);
      return;
    }

    users.forEach((user) => {
      const row = document.createElement('tr');
      row.dataset.userId = user.id;

      const nameCell = document.createElement('td');
      const identification = document.createElement('div');
      identification.className = 'user-identification';
      const strong = document.createElement('strong');
      strong.textContent = user.fullName || user.displayName || user.username || 'Cliente';
      const email = document.createElement('span');
      email.textContent = user.email;
      identification.appendChild(strong);
      identification.appendChild(email);

      const meta = document.createElement('div');
      meta.className = 'user-meta';

      const statusBadge = document.createElement('span');
      const normalizedStatus = ['active', 'blocked', 'pending'].includes(user.status)
        ? user.status
        : 'muted';
      statusBadge.className = `badge badge--status badge--${normalizedStatus}`;
      statusBadge.textContent = statusLabel(user.status);
      meta.appendChild(statusBadge);

      if (user.username) {
        const usernameBadge = document.createElement('span');
        usernameBadge.className = 'badge badge--muted';
        usernameBadge.textContent = `@${user.username}`;
        meta.appendChild(usernameBadge);
      }

      if (user.discordId) {
        const discordBadge = document.createElement('span');
        discordBadge.className = 'badge badge--muted';
        discordBadge.textContent = `Discord: ${user.discordId}`;
        meta.appendChild(discordBadge);
      }

      if (user.rep4repId) {
        const repBadge = document.createElement('span');
        repBadge.className = 'badge badge--muted';
        repBadge.textContent = `Rep4Rep ID: ${user.rep4repId}`;
        meta.appendChild(repBadge);
      }

      const keyBadge = document.createElement('span');
      if (user.rep4repKey) {
        keyBadge.className = 'badge';
        keyBadge.textContent = 'Key definida';
      } else {
        keyBadge.className = 'badge badge--muted';
        keyBadge.textContent = 'Key pendente';
      }
      meta.appendChild(keyBadge);

      if (user.phoneNumber) {
        const phoneBadge = document.createElement('span');
        phoneBadge.className = 'badge badge--muted';
        phoneBadge.textContent = user.phoneNumber;
        meta.appendChild(phoneBadge);
      }

      nameCell.appendChild(identification);
      nameCell.appendChild(meta);

      const creditsCell = document.createElement('td');
      creditsCell.className = 'is-center';
      const creditsValue = document.createElement('span');
      creditsValue.className = 'credit-count';
      creditsValue.dataset.userCredits = '';
      creditsValue.textContent = Number.isFinite(user.credits) ? user.credits : 0;
      creditsCell.appendChild(creditsValue);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'is-right';
      const actions = document.createElement('div');
      actions.className = 'credit-actions';

      [-1, 1, 10].forEach((delta) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn--pill';
        button.dataset.creditDelta = String(delta);
        button.textContent = delta > 0 ? `+${delta}` : `${delta}`;
        actions.appendChild(button);
      });

      const manageButton = document.createElement('button');
      manageButton.type = 'button';
      manageButton.className = 'btn btn--pill btn--ghost';
      manageButton.dataset.userManage = user.id;
      manageButton.textContent = 'Gerenciar';
      actions.appendChild(manageButton);

      actionsCell.appendChild(actions);

      row.appendChild(nameCell);
      row.appendChild(creditsCell);
      row.appendChild(actionsCell);

      userTableBody.appendChild(row);
    });
  }

  function formatQueueDuration(ms) {
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

  function renderQueue(queue) {
    if (!queueBody) {
      return;
    }

    const jobs = Array.isArray(queue?.jobs) ? queue.jobs : [];
    queueBody.innerHTML = '';

    if (jobs.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.className = 'is-center is-muted';
      cell.textContent = 'Nenhum pedido aguardando processamento.';
      row.appendChild(cell);
      queueBody.appendChild(row);
    } else {
      jobs.forEach((job, index) => {
        const row = document.createElement('tr');
        if (job.id) {
          row.dataset.queueJobId = job.id;
        }

        const positionCell = document.createElement('td');
        positionCell.textContent = job.position != null ? job.position : index + 1;
        row.appendChild(positionCell);

        const clientCell = document.createElement('td');
        const strong = document.createElement('strong');
        const user = job.user || {};
        strong.textContent = user.fullName || user.username || user.id || 'Cliente';
        const meta = document.createElement('span');
        meta.className = 'queue-table__meta';
        meta.textContent = user.username ? `@${user.username}` : user.id || '';
        clientCell.appendChild(strong);
        if (meta.textContent) {
          clientCell.appendChild(meta);
        }
        row.appendChild(clientCell);

        const statusCell = document.createElement('td');
        const statusBadge = document.createElement('span');
        const normalizedStatus = job.status === 'running' ? 'active' : 'pending';
        statusBadge.className = `badge badge--status badge--${normalizedStatus}`;
        statusBadge.textContent = job.status || 'pending';
        statusCell.appendChild(statusBadge);
        row.appendChild(statusCell);

        const enqueueCell = document.createElement('td');
        enqueueCell.textContent = job.enqueuedAt
          ? new Date(job.enqueuedAt).toLocaleString()
          : '—';
        row.appendChild(enqueueCell);

        const limitCell = document.createElement('td');
        const maxComments = Number(job.maxCommentsPerAccount);
        const accountLimit = Number(job.accountLimit);
        const maxText = Number.isFinite(maxComments) ? `${maxComments} c/conta` : '—';
        const accountText = Number.isFinite(accountLimit) ? `${accountLimit} contas` : '—';
        limitCell.textContent = `${maxText} · ${accountText}`;
        row.appendChild(limitCell);

        const commentsCell = document.createElement('td');
        const comments = Number(job.totalComments);
        commentsCell.textContent = Number.isFinite(comments) && comments > 0 ? comments : '—';
        row.appendChild(commentsCell);

        const actionsCell = document.createElement('td');
        if (job.status === 'pending') {
          const cancelButton = document.createElement('button');
          cancelButton.type = 'button';
          cancelButton.className = 'btn btn--ghost btn--pill';
          cancelButton.dataset.queueCancel = job.id;
          cancelButton.textContent = 'Cancelar';
          actionsCell.appendChild(cancelButton);
        } else {
          const badge = document.createElement('span');
          badge.className = 'badge badge--muted';
          badge.textContent = 'Em execução';
          actionsCell.appendChild(badge);
        }
        row.appendChild(actionsCell);

        queueBody.appendChild(row);
      });
    }

    if (queueLengthEl) {
      const lengthValue = Number(queue?.queueLength);
      queueLengthEl.textContent = Number.isFinite(lengthValue) ? lengthValue : jobs.length;
    }
    if (queueAverageEl) {
      queueAverageEl.textContent = formatQueueDuration(queue?.averageDurationMs);
    }

    if (queueHistoryContainer && queueHistoryList) {
      const history = Array.isArray(queue?.history) ? queue.history : [];
      queueHistoryContainer.hidden = history.length === 0;
      queueHistoryList.innerHTML = '';
      history.forEach((item) => {
        const li = document.createElement('li');
        const strong = document.createElement('strong');
        const user = item.user || {};
        strong.textContent = user.fullName || user.username || user.id || 'Cliente';
        const span = document.createElement('span');
        const finishedText = item.finishedAt
          ? new Date(item.finishedAt).toLocaleString()
          : '—';
        span.textContent = ` — ${item.status} em ${finishedText}`;
        li.appendChild(strong);
        li.appendChild(span);
        queueHistoryList.appendChild(li);
      });
    }
  }

  function renderWatchdog(status) {
    if (!status) {
      watchdogStateEls.forEach((el) => {
        el.textContent = 'desligado';
        el.dataset.state = 'off';
      });
      watchdogIntervalEls.forEach((el) => {
        el.textContent = '--';
      });
      watchdogLastRunEls.forEach((el) => {
        el.textContent = '—';
      });
      if (watchdogErrorEl) watchdogErrorEl.textContent = '';
      return;
    }

    watchdogStateEls.forEach((el) => {
      el.textContent = status.running ? 'ativo' : 'desligado';
      el.dataset.state = status.running ? 'on' : 'off';
    });
    watchdogIntervalEls.forEach((el) => {
      el.textContent = status.intervalMinutes
        ? `${status.intervalMinutes} min`
        : '--';
    });
    watchdogLastRunEls.forEach((el) => {
      el.textContent = status.lastRunAt
        ? new Date(status.lastRunAt).toLocaleString()
        : '—';
    });
    if (watchdogErrorEl) {
      watchdogErrorEl.textContent = status.lastError ? `⚠️ ${status.lastError}` : '';
    }
  }

  async function refreshStats() {
    try {
      const res = await fetch(buildUrl('/api/stats'));
      if (!res.ok) throw new Error('Falha ao atualizar estatísticas.');
      const data = await res.json();
      if (data?.stats) {
        renderStats(data.stats);
      }
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Erro ao atualizar estatísticas.', 'error');
    }
  }

  async function refreshUsers() {
    if (!userTableBody) return;
    try {
      const res = await fetch(buildUrl('/api/users'));
      if (!res.ok) throw new Error('Falha ao carregar usuários.');
      const data = await res.json();
      renderUsers(data.users || []);
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Erro ao carregar usuários.', 'error');
    }
  }

  async function refreshWatchdog() {
    try {
      const res = await fetch(buildUrl('/api/watchdog'));
      if (!res.ok) return;
      const data = await res.json();
      if (data?.watchdog) {
        renderWatchdog(data.watchdog);
      }
    } catch (error) {
      console.error('Falha ao obter status do vigia:', error);
    }
  }

  async function refreshQueue() {
    try {
      const res = await fetch(buildUrl('/api/queue'));
      if (!res.ok) {
        throw new Error('Falha ao obter fila.');
      }
      const data = await res.json();
      if (data?.queue) {
        cachedQueue = data.queue;
        renderQueue(cachedQueue);
      }
    } catch (error) {
      console.error('[Painel] Falha ao atualizar fila:', error);
      showToast(error.message || 'Erro ao atualizar fila.', 'error');
    }
  }

  async function cancelQueueJob(jobId, button) {
    if (!jobId) {
      return;
    }

    try {
      if (button) {
        button.disabled = true;
      }
      const res = await fetch(buildUrl(`/api/queue/${encodeURIComponent(jobId)}/cancel`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Cancelado via painel' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Não foi possível cancelar o pedido.');
      }
      if (data.queue) {
        cachedQueue = data.queue;
        renderQueue(cachedQueue);
      }
      showToast(data.message || 'Pedido cancelado com sucesso.', 'success');
    } catch (error) {
      showToast(error.message || 'Erro ao cancelar pedido.', 'error');
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  async function runCommand(command, button) {
    if (!command) return;
    const payload = { command };
    try {
      if (button) button.disabled = true;
      const res = await fetch(buildUrl('/api/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Erro ao executar comando.');
      }

      const message = data.message || 'Comando concluído.';
      if (outputEl) {
        if (data.stats) {
          outputEl.textContent = `${message}\n\n${JSON.stringify(data.stats, null, 2)}`;
        } else if (data.filePath) {
          outputEl.textContent = `${message}\nArquivo salvo em: ${data.filePath}`;
        } else if (data.summary) {
          const perAccount = Array.isArray(data.summary.perAccount)
            ? data.summary.perAccount
            : [];
          const lines = [
            message,
            '',
            `Total de comentários: ${data.summary.totalComments ?? 0}`,
          ];
          perAccount.forEach((item) => {
            const suffix = item.stoppedEarly ? ' (limite atingido)' : '';
            lines.push(`- ${item.username || 'desconhecido'}: ${item.comments ?? 0}${suffix}`);
          });
          outputEl.textContent = lines.join('\n');
        } else if (!['watchdogStart', 'watchdogStop', 'watchdogStatus'].includes(command)) {
          outputEl.textContent = message;
        }
      }

      if (data.stats) {
        renderStats(data.stats);
      }
      if (data.watchdog) {
        renderWatchdog(data.watchdog);
      }
      if (data.queue) {
        cachedQueue = data.queue;
        renderQueue(cachedQueue);
      }

      showToast(message, 'success');
      if (command === 'autoRun' || command === 'stats') {
        refreshStats();
      }
      if (command === 'autoRun') {
        refreshUsers();
        refreshQueue();
      }
    } catch (error) {
      if (outputEl) {
        outputEl.textContent = `❌ ${error.message}`;
      }
      showToast(error.message || 'Erro ao executar comando.', 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function populateUserEditor(user) {
    if (!userEditor || !userEditorForm || !user) return;
    userEditor.classList.add('is-visible');
    userEditorForm.dataset.userId = user.id;
    userEditorForm.reset();
    if (userEditorTitle) {
      userEditorTitle.textContent = user.fullName || user.username || user.email;
    }

    const field = (name) => userEditorForm.querySelector(`[name="${name}"]`);
    const setValue = (name, value = '') => {
      const input = field(name);
      if (input) {
        input.value = value ?? '';
      }
    };

    setValue('fullName', user.fullName || '');
    setValue('username', user.username || '');
    setValue('email', user.email || '');
    setValue('phoneNumber', user.phoneNumber || '');
    setValue('discordId', user.discordId || '');
    setValue('rep4repId', user.rep4repId || '');
    setValue('rep4repKey', user.rep4repKey || '');
    setValue('dateOfBirth', user.dateOfBirth || '');
    setValue('credits', Number.isFinite(user.credits) ? user.credits : 0);
    setValue('status', user.status || 'pending');
    setValue('role', user.role || 'customer');
    setValue('password', '');
  }

  function closeEditor() {
    if (!userEditor || !userEditorForm) return;
    userEditor.classList.remove('is-visible');
    userEditorForm.dataset.userId = '';
    userEditorForm.reset();
  }

  document.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => {
      const command = button.getAttribute('data-command');
      runCommand(command, button);
    });
  });

  document.querySelectorAll('[data-watchdog-refresh]').forEach((button) => {
    button.addEventListener('click', () => {
      refreshWatchdog();
    });
  });

  if (queueRefreshButton) {
    queueRefreshButton.addEventListener('click', () => {
      refreshQueue();
    });
  }

  if (queueBody) {
    queueBody.addEventListener('click', (event) => {
      const cancelButton = event.target.closest('[data-queue-cancel]');
      if (cancelButton) {
        event.preventDefault();
        const jobId = cancelButton.dataset.queueCancel;
        cancelQueueJob(jobId, cancelButton);
      }
    });
  }

  if (userForm) {
    userForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(userForm);
      const payload = Object.fromEntries(formData.entries());
      if (payload.credits !== undefined) {
        payload.credits = Number(payload.credits);
      }
      try {
        const submitButton = userForm.querySelector('button[type="submit"]');
        if (submitButton) submitButton.disabled = true;
        const res = await fetch(buildUrl('/api/users'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
          throw new Error(data.error || 'Erro ao cadastrar cliente.');
        }
        userForm.reset();
        showToast('Cliente cadastrado com sucesso.', 'success');
        refreshUsers();
      } catch (error) {
        showToast(error.message || 'Erro ao cadastrar cliente.', 'error');
      } finally {
        const submitButton = userForm.querySelector('button[type="submit"]');
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  if (userTableBody) {
    userTableBody.addEventListener('click', async (event) => {
      const creditButton = event.target.closest('[data-credit-delta]');
      if (creditButton) {
        const delta = Number(creditButton.dataset.creditDelta);
        if (!Number.isFinite(delta)) return;
        const row = creditButton.closest('tr');
        const userId = row?.dataset.userId;
        if (!userId) return;

        try {
          creditButton.disabled = true;
          const res = await fetch(buildUrl(`/api/users/${encodeURIComponent(userId)}/credits`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delta }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.success === false) {
            throw new Error(data.error || 'Falha ao ajustar créditos.');
          }

          const creditEl = row.querySelector('[data-user-credits]');
          if (creditEl) {
            creditEl.textContent = data.user?.credits ?? '0';
          }

          row.classList.add('is-updated');
          setTimeout(() => row.classList.remove('is-updated'), 800);
          showToast('Créditos atualizados com sucesso.', 'success');
        } catch (error) {
          showToast(error.message || 'Erro ao ajustar créditos.', 'error');
        } finally {
          creditButton.disabled = false;
        }
        return;
      }

      const manageButton = event.target.closest('[data-user-manage]');
      if (manageButton) {
        const userId = manageButton.dataset.userManage;
        const user = cachedUsers.find((item) => String(item.id) === String(userId));
        if (user) {
          populateUserEditor(user);
        }
      }
    });
  }

  userEditorCloseButtons.forEach((button) => {
    button.addEventListener('click', () => {
      closeEditor();
    });
  });

  if (userEditorForm) {
    userEditorForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const userId = userEditorForm.dataset.userId;
      if (!userId) return;

      const formData = new FormData(userEditorForm);
      const payload = Object.fromEntries(formData.entries());
      if (payload.credits !== undefined) {
        payload.credits = Number(payload.credits);
      }
      if (!payload.password) {
        delete payload.password;
      }

      try {
        const res = await fetch(buildUrl(`/api/users/${encodeURIComponent(userId)}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
          throw new Error(data.error || 'Não foi possível atualizar o usuário.');
        }
        showToast('Usuário atualizado com sucesso.', 'success');
        closeEditor();
        refreshUsers();
      } catch (error) {
        showToast(error.message || 'Erro ao atualizar usuário.', 'error');
      }
    });
  }

  if (cachedQueue) {
    renderQueue(cachedQueue);
  } else {
    refreshQueue();
  }
  refreshStats();
  refreshUsers();
  refreshWatchdog();
})();
