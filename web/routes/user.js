const express = require('express');
const router = express.Router();

const userStore = require('../services/userStore');
const { autoRun, collectUsageStats } = require('../../src/util.cjs');

function extractAuth(req) {
  const userId =
    req.header('x-user-id') ||
    req.body?.userId ||
    req.query?.userId ||
    null;
  const token =
    req.header('x-user-token') ||
    req.body?.token ||
    req.body?.apiToken ||
    req.query?.token ||
    null;
  return { userId: userId ? String(userId) : null, token: token ? String(token) : null };
}

router.use(async (req, res, next) => {
  try {
    const { userId, token } = extractAuth(req);
    const user = await userStore.authenticateUser({ userId, token });
    if (!user) {
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
      displayName: user.displayName,
      email: user.email,
      credits: user.credits,
      status: user.status,
      role: user.role,
      rep4repKey: user.rep4repKey,
    },
  });
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

  if (req.user.credits <= 0) {
    return res.status(402).json({ success: false, error: 'Créditos insuficientes.' });
  }

  if (!req.user.rep4repKey) {
    return res.status(400).json({ success: false, error: 'Defina a chave Rep4Rep antes de executar comandos.' });
  }

  const creditLimit = req.user.credits;
  let usedCredits = 0;

  try {
    const summary = await autoRun({
      apiToken: req.user.rep4repKey,
      onTaskComplete: () => {
        usedCredits += 1;
        if (usedCredits >= creditLimit) {
          return false;
        }
        return true;
      },
    });

    const consumed = Math.min(summary.totalComments ?? usedCredits, creditLimit);
    let updatedUser = req.user;
    if (consumed > 0) {
      updatedUser = await userStore.consumeCredits(req.user.id, consumed);
    }

    res.json({
      success: true,
      message: 'Execução concluída.',
      summary,
      creditsConsumed: consumed,
      remainingCredits: updatedUser.credits,
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
