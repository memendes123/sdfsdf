const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const auth = require('../auth');
const userStore = require('../services/userStore');
const {
  prioritizedAutoRun,
  collectUsageStats,
  backupDatabase,
  queueAutomaticBackup,
  startKeepAliveLoop,
  stopKeepAliveLoop,
  getKeepAliveStatus,
  describeApiError,
  announceQueueEvent,
  getEnvRep4RepKey,
  resolveApiToken,
  markQueueRunnerStart,
  markQueueRunnerProgress,
  markQueueRunnerFinish,
  requestQueueRunnerStop,
  getQueueRunnerStatus,
  isQueueRunnerStopRequested,
} = require('../../src/util.cjs');
const runQueue = require('../../src/runQueue.cjs');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const ENV_REP4REP_KEY = getEnvRep4RepKey();

function resolveOwnerCredentials(adminUser) {
  const adminToken =
    resolveApiToken(adminUser?.rep4repKey, { fallbackToEnv: false }) || '';
  const token = adminToken || ENV_REP4REP_KEY || '';
  return {
    token,
    webhookUrl: adminUser?.discordWebhookUrl || '',
    user: adminUser || null,
  };
}

function sanitizeAdminLimit(value, fallback, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(num)));
}

userStore.ensureDataFile().catch((error) => {
  console.error('[Painel] Falha ao preparar storage de usuários:', error);
});

function extractBasicAuth(req) {
  const header = req.headers?.authorization;
  if (!header || typeof header !== 'string') {
    return null;
  }

  const prefix = 'basic ';
  if (!header.toLowerCase().startsWith(prefix)) {
    return null;
  }

  const base64Credentials = header.slice(prefix.length).trim();
  if (!base64Credentials) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(base64Credentials, 'base64').toString();
  } catch (error) {
    console.warn('[Painel] Cabeçalho Basic Auth inválido recebido:', error.message);
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  const name = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);

  return {
    name,
    pass,
  };
}

router.use((req, res, next) => {
  const user = extractBasicAuth(req);
  if (!auth(user)) {
    res.set('WWW-Authenticate', 'Basic realm="Painel Rep4Rep"');
    return res.status(401).send('Auth required.');
  }
  req.adminUser = user;
  res.locals.baseUrl = req.baseUrl || '';
  next();
});

router.get('/', async (req, res) => {
  try {
    const [stats, users, queue] = await Promise.all([
      collectUsageStats().catch((error) => {
        console.error('[Painel] Falha ao coletar estatísticas:', describeApiError(error));
        return null;
      }),
      userStore.listUsers().catch((error) => {
        console.error('[Painel] Falha ao obter usuários:', error);
        return [];
      }),
      runQueue.getQueueSnapshot().catch((error) => {
        console.error('[Painel] Falha ao obter fila:', error);
        return { jobs: [], history: [], averageDurationMs: 0, queueLength: 0 };
      }),
    ]);

    res.render('dashboard', {
      title: 'Painel',
      page: 'dashboard',
      initialStats: stats,
      initialUsers: users,
      initialQueue: queue,
      initialRunner: getQueueRunnerStatus(),
    });
  } catch (error) {
    console.error('[Painel] Erro ao renderizar dashboard:', error);
    res.status(500).send('Erro ao carregar painel.');
  }
});

router.get('/logs', (req, res) => {
  const logs = [];

  if (fs.existsSync(LOGS_DIR)) {
    const files = fs
      .readdirSync(LOGS_DIR)
      .filter((file) => file.endsWith('.log'))
      .sort((a, b) => b.localeCompare(a));

    for (const file of files) {
      const filePath = path.join(LOGS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const { mtime } = fs.statSync(filePath);
      logs.push({
        name: file,
        content,
        updatedAt: mtime,
      });
    }
  }

  res.render('logs', {
    title: 'Logs',
    page: 'logs',
    logs,
  });
});

router.post('/api/run', async (req, res) => {
  const { command } = req.body || {};

  if (!command) {
    return res.status(400).json({ success: false, error: 'Comando não informado.' });
  }

  const handlers = {
    autoRun: async () => {
      const {
        maxCommentsPerAccount: requestedMax,
        accountLimit: requestedAccounts,
        totalComments: requestedTotal,
        apiToken: providedToken,
      } = req.body || {};

      const adminUser = await userStore.findActiveAdmin();
      const { token: fallbackToken, webhookUrl, user } = resolveOwnerCredentials(adminUser);

      const explicitToken = resolveApiToken(providedToken, { fallbackToEnv: false });
      const effectiveToken = explicitToken || fallbackToken;
      if (!effectiveToken) {
        throw new Error('Configure a chave Rep4Rep no perfil admin ou defina REP4REP_KEY no ambiente antes de executar.');
      }

      const sanitizedMax = sanitizeAdminLimit(requestedMax, 1000, 1000);
      const sanitizedAccounts = sanitizeAdminLimit(requestedAccounts, 100, 100);
      const sanitizedTotal = sanitizeAdminLimit(requestedTotal, 0, 1000);
      const effectiveTotal = sanitizedTotal > 0 ? sanitizedTotal : null;

      const currentStatus = getQueueRunnerStatus();
      if (currentStatus.running) {
        return {
          message: '⚠️ Já existe uma execução em andamento. Use “Parar autoRun” para interromper.',
          runner: currentStatus,
          applied: {
            maxCommentsPerAccount: sanitizedMax,
            accountLimit: sanitizedAccounts,
            requestedComments: effectiveTotal,
            apiTokenProvided: Boolean(explicitToken),
          },
        };
      }

      markQueueRunnerStart({
        startedBy: req.adminUser?.name || null,
        options: {
          maxCommentsPerAccount: sanitizedMax,
          accountLimit: sanitizedAccounts,
          requestedComments: effectiveTotal,
          apiTokenProvided: Boolean(explicitToken),
        },
      });

      try {
        const summary = await prioritizedAutoRun({
          ownerToken: effectiveToken,
          ownerWebhookUrl: webhookUrl,
          ownerUser: user,
          accountLimit: sanitizedAccounts,
          maxCommentsPerAccount: sanitizedMax,
          targetTotalComments: effectiveTotal,
          clientFilter: (user) => user.role !== 'admin',
          shouldAbort: isQueueRunnerStopRequested,
          onQueueStart: () => markQueueRunnerProgress({ message: 'Processando fila de clientes...' }),
          onJobStart: (job) => markQueueRunnerProgress({ currentJob: job }),
          onJobFinish: (outcome) =>
            markQueueRunnerProgress({ currentJob: null, lastOutcome: outcome }),
          onQueueFinish: (result) =>
            markQueueRunnerProgress({
              currentJob: null,
              lastOutcome: null,
              message: result.stopped ? 'Execução interrompida.' : 'Execução concluída.',
            }),
        });
        markQueueRunnerFinish({ result: summary });
        const queue = await runQueue.getQueueSnapshot();
        const runner = getQueueRunnerStatus();
        const message = summary.stopped
          ? '⏹️ Execução interrompida a pedido do operador.'
          : '✅ Execução concluída com prioridade.';
        return {
          message,
          summary,
          queue,
          runner,
          applied: {
            maxCommentsPerAccount: sanitizedMax,
            accountLimit: sanitizedAccounts,
            requestedComments: effectiveTotal,
            apiTokenProvided: Boolean(explicitToken),
          },
        };
      } catch (error) {
        markQueueRunnerFinish({ error });
        throw error;
      }
    },
    autoRunStop: async () => {
      const status = getQueueRunnerStatus();
      if (!status.running) {
        return {
          message: '⚠️ Nenhuma execução em andamento no momento.',
          runner: status,
        };
      }
      const updated = requestQueueRunnerStop();
      return {
        message: '⏹️ Parada solicitada. Aguarde a finalização do ciclo atual.',
        runner: updated,
      };
    },
    stats: async () => {
      const stats = await collectUsageStats();
      return { message: '📊 Estatísticas atualizadas.', stats };
    },
    backup: async () => {
      const filePath = await backupDatabase();
      if (!filePath) {
        return { message: '⚠️ Nenhum banco de dados encontrado para backup.' };
      }
      return { message: `📦 Backup criado em: ${filePath}`, filePath };
    },
    watchdogStart: async () => {
      const adminUser = await userStore.findActiveAdmin();
      const { token, webhookUrl, user } = resolveOwnerCredentials(adminUser);
      if (!token) {
        throw new Error('Defina a chave Rep4Rep na conta admin ou configure REP4REP_KEY para iniciar o vigia.');
      }
      const result = await startKeepAliveLoop({
        ownerToken: token,
        ownerWebhookUrl: webhookUrl,
        ownerUser: user,
      });
      const status = getKeepAliveStatus();
      const message = result.alreadyRunning
        ? '⚠️ O modo vigia já está ativo.'
        : '🛡️ Modo vigia ativado. Executará automaticamente no intervalo configurado.';
      return { message, watchdog: status };
    },
    watchdogStop: async () => {
      const result = await stopKeepAliveLoop();
      const status = getKeepAliveStatus();
      const message = result.stopped
        ? '⏹️ Modo vigia encerrado.'
        : '⚠️ O modo vigia já estava inativo.';
      return { message, watchdog: status };
    },
    watchdogStatus: async () => {
      return { message: 'Status do vigia atualizado.', watchdog: getKeepAliveStatus() };
    },
  };

  const handler = handlers[command];
  if (!handler) {
    return res.status(400).json({ success: false, error: 'Comando inválido.' });
  }

  try {
    const payload = await handler();
    const runner = payload && Object.prototype.hasOwnProperty.call(payload, 'runner')
      ? payload.runner
      : getQueueRunnerStatus();
    res.json({ success: true, ...payload, runner });
  } catch (error) {
    console.error(`[Painel] Falha ao executar comando ${command}:`, error);
    res.status(500).json({ success: false, error: error.message, runner: getQueueRunnerStatus() });
  }
});

router.get('/api/stats', async (req, res) => {
  try {
    const stats = await collectUsageStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('[Painel] Falha ao obter estatísticas:', error);
    res.status(500).json({ success: false, error: 'Não foi possível obter as estatísticas.' });
  }
});

router.get('/api/users', async (req, res) => {
  try {
    const users = await userStore.listUsers();
    res.json({ success: true, users });
  } catch (error) {
    console.error('[Painel] Falha ao listar usuários:', error);
    res.status(500).json({ success: false, error: 'Não foi possível carregar os usuários.' });
  }
});

router.get('/api/watchdog', (req, res) => {
  res.json({ success: true, watchdog: getKeepAliveStatus() });
});

router.get('/api/queue', async (req, res) => {
  try {
    const queue = await runQueue.getQueueSnapshot();
    res.json({ success: true, queue, runner: getQueueRunnerStatus() });
  } catch (error) {
    console.error('[Painel] Falha ao consultar fila:', error);
    res.status(500).json({ success: false, error: 'Não foi possível obter a fila.' });
  }
});

router.post('/api/queue/clear', async (req, res) => {
  const { reason } = req.body || {};
  const effectiveReason = typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : 'Cancelado em massa (painel)';

  try {
    const result = await runQueue.cancelAllPendingJobs({ reason: effectiveReason });

    if (Array.isArray(result.jobs) && result.jobs.length) {
      const payload = {
        type: 'job.cancelled',
        reason: effectiveReason,
        cancelledBy: req.adminUser?.name || null,
      };

      await Promise.all(
        result.jobs.map(async (job) => {
          try {
            await announceQueueEvent({ ...payload, job });
          } catch (notifyError) {
            console.warn('[Painel] Falha ao enviar webhook de cancelamento em massa:', notifyError.message);
          }
        }),
      );
    }

    const queue = await runQueue.getQueueSnapshot();
    res.json({
      success: true,
      message: result.cancelledCount > 0
        ? `${result.cancelledCount} pedido(s) removido(s) da fila.`
        : 'Nenhum pedido pendente para remover.',
      cancelled: result,
      queue,
      runner: getQueueRunnerStatus(),
    });
  } catch (error) {
    console.error('[Painel] Falha ao limpar fila:', error);
    res.status(500).json({ success: false, error: 'Não foi possível limpar a fila.' });
  }
});

router.post('/api/queue/:id/cancel', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};

  if (!id) {
    return res.status(400).json({ success: false, error: 'Identificador do pedido obrigatório.' });
  }

  try {
    const result = await runQueue.cancelJob(id, { reason });
    if (!result.cancelled) {
      return res.status(409).json({
        success: false,
        error: 'O pedido já foi processado ou não está mais pendente.',
        job: result.job,
      });
    }

    try {
      await announceQueueEvent({
        type: 'job.cancelled',
        job: result.job,
        reason: reason || 'Cancelado manualmente',
        cancelledBy: req.adminUser?.name || null,
      });
    } catch (notifyError) {
      console.warn('[Painel] Falha ao enviar webhook de cancelamento:', notifyError);
    }

    const queue = await runQueue.getQueueSnapshot();
    res.json({
      success: true,
      message: 'Pedido cancelado com sucesso.',
      job: result.job,
      queue,
      runner: getQueueRunnerStatus(),
    });
  } catch (error) {
    console.error('[Painel] Falha ao cancelar pedido:', error);
    const message = error?.message || 'Não foi possível cancelar o pedido.';
    const status = /não encontrado/i.test(message)
      ? 404
      : /execu[cç][aã]o/i.test(message)
      ? 409
      : 500;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/api/queue/:id/reorder', async (req, res) => {
  const { id } = req.params;
  const { position } = req.body || {};

  if (!id) {
    return res.status(400).json({ success: false, error: 'Identificador do pedido obrigatório.' });
  }

  try {
    await runQueue.reorderJob(id, { position });
    const queue = await runQueue.getQueueSnapshot();
    res.json({
      success: true,
      message: 'Ordem do pedido atualizada.',
      queue,
      runner: getQueueRunnerStatus(),
    });
  } catch (error) {
    console.error('[Painel] Falha ao reordenar pedido:', error);
    res.status(400).json({ success: false, error: error.message || 'Não foi possível reordenar o pedido.' });
  }
});

router.post('/api/users', async (req, res) => {
  try {
    const user = await userStore.createUser(req.body || {});
    queueAutomaticBackup({ reason: 'novo usuário (painel)' }).catch((error) => {
      console.warn('[Painel] Falha ao criar backup automático após cadastro:', error.message);
    });
    res.status(201).json({ success: true, user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.patch('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const user = await userStore.updateUser(id, req.body || {});
    res.json({ success: true, user });
  } catch (error) {
    const status = error.message.includes('não encontrado') ? 404 : 400;
    res.status(status).json({ success: false, error: error.message });
  }
});

router.post('/api/users/:id/credits', async (req, res) => {
  const { id } = req.params;
  const { delta } = req.body || {};

  try {
    const user = await userStore.adjustCredits(id, delta);
    res.json({ success: true, user });
  } catch (error) {
    const status = error.message.includes('não encontrado') ? 404 : 400;
    res.status(status).json({ success: false, error: error.message });
  }
});

module.exports = router;
