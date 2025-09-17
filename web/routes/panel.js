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
} = require('../../src/util.cjs');
const runQueue = require('../../src/runQueue.cjs');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const ENV_REP4REP_KEY = (process.env.REP4REP_KEY || '').trim();

function resolveOwnerCredentials(adminUser) {
  const adminToken = adminUser?.rep4repKey ? adminUser.rep4repKey.trim() : '';
  const token = adminToken || ENV_REP4REP_KEY || '';
  return {
    token,
    webhookUrl: adminUser?.discordWebhookUrl || '',
    user: adminUser || null,
  };
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
      const adminUser = await userStore.findActiveAdmin();
      const { token, webhookUrl, user } = resolveOwnerCredentials(adminUser);
      if (!token) {
        throw new Error('Configure a chave Rep4Rep no perfil admin ou defina REP4REP_KEY no ambiente antes de executar.');
      }

      const summary = await prioritizedAutoRun({
        ownerToken: token,
        ownerWebhookUrl: webhookUrl,
        ownerUser: user,
        accountLimit: 100,
        maxCommentsPerAccount: 1000,
        clientFilter: (user) => user.role !== 'admin',
      });
      const queue = await runQueue.getQueueSnapshot();
      return { message: '✅ Execução concluída com prioridade.', summary, queue };
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
    res.json({ success: true, ...payload });
  } catch (error) {
    console.error(`[Painel] Falha ao executar comando ${command}:`, error);
    res.status(500).json({ success: false, error: error.message });
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
    res.json({ success: true, queue });
  } catch (error) {
    console.error('[Painel] Falha ao consultar fila:', error);
    res.status(500).json({ success: false, error: 'Não foi possível obter a fila.' });
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
