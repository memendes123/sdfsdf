const express = require('express');
const router = express.Router();

const userStore = require('../services/userStore');
const {
  autoRun,
  collectUsageStats,
  removeRemoteProfiles,
  describeApiError,
} = require('../../src/util.cjs');
const rep4repApi = require('../../src/api.cjs');

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
      return res.status(401).json({ success: false, error: 'Credenciais inválidas.' });
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

  const creditLimit = isAdmin ? Infinity : req.user.credits;
  let usedCredits = 0;

  try {
    const summary = await autoRun({
      apiToken: req.user.rep4repKey,
      maxCommentsPerAccount: 1000,
      accountLimit: 100,
      onTaskComplete: () => {
        if (isAdmin) {
          return true;
        }
        usedCredits += 1;
        return usedCredits < creditLimit;
      },
    });

    const consumed = isAdmin
      ? summary.totalComments ?? 0
      : Math.min(summary.totalComments ?? usedCredits, creditLimit);
    let updatedUser = req.user;
    if (!isAdmin && consumed > 0) {
      updatedUser = await userStore.consumeCredits(req.user.id, consumed);
    }

    const cleanup = await removeRemoteProfiles(summary, {
      apiToken: req.user.rep4repKey,
    });

    res.json({
      success: true,
      message: 'Execução concluída.',
      summary,
      creditsConsumed: consumed,
      remainingCredits: updatedUser.credits,
      cleanup,
    });
  } catch (error) {
    if (/Créditos insuficientes/.test(error.message)) {
      return res.status(402).json({ success: false, error: error.message });
    }
    console.error('[API usuário] Falha ao executar comando:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
