const express = require('express');
const router = express.Router();

const userStore = require('../services/userStore');
const { collectUsageStats, describeApiError } = require('../../src/util.cjs');
const rep4repApi = require('../../src/api.cjs');
const runQueue = require('../../src/runQueue.cjs');

function extractAuth(req) {
  const authHeader = req.header('authorization');
  const bearerToken = authHeader && authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  const userId =
    req.header('x-user-id') ||
    req.body?.userId ||
    req.query?.userId ||
    null;
  const token =
    bearerToken ||

    req.header('x-user-token') ||
    req.body?.token ||
    req.body?.apiToken ||
    req.query?.token ||
    null;
  return { userId: userId ? String(userId) : null, token: token ? String(token) : null };
}

router.post('/register', async (req, res) => {
  try {
    const user = await userStore.registerUser(req.body || {});
    res.status(201).json({
      success: true,
      message: 'Cadastro enviado. Ative o cliente atribuindo créditos e status ativo.',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/login', async (req, res) => {
  const { identifier, email, username, password } = req.body || {};
  const loginIdentifier = identifier || email || username;
  try {
    const user = await userStore.loginUser({ identifier: loginIdentifier, password });
    res.json({
      success: true,
      token: user.apiToken,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        credits: user.credits,
        status: user.status,
        role: user.role,
        discordId: user.discordId,
        rep4repId: user.rep4repId,
        rep4repKey: user.rep4repKey,
        phoneNumber: user.phoneNumber,
        dateOfBirth: user.dateOfBirth,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.use(async (req, res, next) => {
  try {
    const { userId, token } = extractAuth(req);
    const user = await userStore.authenticateUser({ userId, token });
    if (!user) {
      return res.status(401).json({ success: false, error: 'Credenciais inválidas ou conta inativa.' });
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
});

router.get('/me', async (req, res) => {
  const { user } = req;
  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      displayName: user.displayName,
      email: user.email,
      credits: user.credits,
      status: user.status,
      role: user.role,
      discordId: user.discordId,
      rep4repId: user.rep4repId,
      rep4repKey: user.rep4repKey,
      phoneNumber: user.phoneNumber,
      dateOfBirth: user.dateOfBirth,
      lastLoginAt: user.lastLoginAt,
    },
  });
});

router.patch('/me', async (req, res) => {
  const { rep4repKey } = req.body || {};
  if (rep4repKey === undefined) {
    return res.status(400).json({ success: false, error: 'Nada para atualizar.' });
  }

  try {
    const updated = await userStore.updateRep4repKey(req.user.id, rep4repKey);
    res.json({ success: true, user: { ...updated, apiToken: undefined } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/run', async (req, res) => {
  const { command = 'autoRun' } = req.body || {};
  const allowedCommands = new Set(['autoRun', 'stats']);
  if (!allowedCommands.has(command)) {
    return res.status(400).json({ success: false, error: 'Comando não permitido para usuários.' });
  }

  if (command === 'stats') {
    try {
      const stats = await collectUsageStats();
      return res.json({ success: true, stats });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  const isAdmin = req.user.role === 'admin';

  if (req.user.status !== 'active') {
    return res.status(403).json({ success: false, error: 'Conta ainda não ativada. Aguarde a liberação pelo administrador.' });
  }

  if (!isAdmin && req.user.credits <= 0) {
    return res.status(402).json({ success: false, error: 'Créditos insuficientes.' });
  }

  if (!req.user.rep4repKey) {
    return res.status(400).json({ success: false, error: 'Defina a chave Rep4Rep antes de executar comandos.' });
  }

  let remoteProfiles;
  try {
    remoteProfiles = await rep4repApi.getSteamProfiles({ token: req.user.rep4repKey });
  } catch (error) {
    return res.status(502).json({ success: false, error: describeApiError(error) });
  }

  if (!Array.isArray(remoteProfiles) || remoteProfiles.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Nenhum perfil Rep4Rep encontrado. Adicione contas antes de executar o comando.',
    });
  }

  try {
    const enqueue = await runQueue.enqueueJob({
      userId: req.user.id,
      command: 'autoRun',
      maxCommentsPerAccount: 1000,
      accountLimit: 100,
    });

    const queueStatus = await runQueue.getUserQueueStatus(req.user.id);
    res.json({
      success: true,
      message: enqueue.alreadyQueued
        ? 'Você já possui uma execução aguardando processamento. Acompanhe sua posição na fila.'
        : 'Pedido adicionado à fila com sucesso. Aguarde a sua vez para começar.',
      queue: queueStatus,
    });
  } catch (error) {
    console.error('[API usuário] Falha ao enfileirar execução:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/queue', async (req, res) => {
  try {
    const queueStatus = await runQueue.getUserQueueStatus(req.user.id);
    res.json({ success: true, queue: queueStatus });
  } catch (error) {
    console.error('[API usuário] Falha ao consultar fila:', error);
    res.status(500).json({ success: false, error: 'Não foi possível obter o status da fila.' });
  }
});

module.exports = router;
