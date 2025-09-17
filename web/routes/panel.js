const express = require('express');
const router = express.Router();
const basicAuth = require('basic-auth');
const fs = require('fs');
const path = require('path');

const auth = require('../auth');
const userStore = require('../services/userStore');
const {
  prioritizedAutoRun,
  collectUsageStats,
  backupDatabase,
  describeApiError,
} = require('../../src/util.cjs');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

userStore.ensureDataFile().catch((error) => {
  console.error('[Painel] Falha ao preparar storage de usuários:', error);
});

router.use((req, res, next) => {
  const user = basicAuth(req);
  if (!auth(user)) {
    res.set('WWW-Authenticate', 'Basic realm="Painel Rep4Rep"');
    return res.status(401).send('Auth required.');
  }
  res.locals.baseUrl = req.baseUrl || '';
  next();
});

router.get('/', async (req, res) => {
  try {
    const [stats, users] = await Promise.all([
      collectUsageStats().catch((error) => {
        console.error('[Painel] Falha ao coletar estatísticas:', describeApiError(error));
        return null;
      }),
      userStore.listUsers().catch((error) => {
        console.error('[Painel] Falha ao obter usuários:', error);
        return [];
      }),
    ]);

    res.render('dashboard', {
      title: 'Painel',
      page: 'dashboard',
      initialStats: stats,
      initialUsers: users,
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
      if (!adminUser || !adminUser.rep4repKey) {
        throw new Error('Configure a chave Rep4Rep no perfil admin antes de executar.');
      }

      const summary = await prioritizedAutoRun({
        ownerToken: adminUser.rep4repKey,
        accountLimit: 100,
        maxCommentsPerAccount: 1000,
        clientFilter: (user) => user.role !== 'admin',
      });
      return { message: '✅ Execução concluída com prioridade.', summary };
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

router.post('/api/users', async (req, res) => {
  try {
    const user = await userStore.createUser(req.body || {});
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
