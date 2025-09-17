const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { table } = require('table');
const readline = require('readline');

require('dotenv').config();

const db = require('./db.cjs');
const api = require('./api.cjs');
const { ApiError } = require('./api.cjs');
const createSteamBot = require('./steamBot.cjs');
const userStore = require('../web/services/userStore');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ACCOUNTS_PATH = path.join(ROOT_DIR, 'accounts.txt');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');

const DEFAULT_LOGIN_DELAY = 30_000;
const DEFAULT_COMMENT_DELAY = 15_000;
const configuredMaxComments = sanitizePositiveInteger(
  process.env.MAX_COMMENTS_PER_RUN ??
    process.env.COMMENT_LIMIT ??
    process.env.MAX_COMMENTS,
  10,
);
const MAX_COMMENTS_PER_RUN = Math.min(1000, configuredMaxComments);

let rl = null;

const statusMessage = {
  inactive: 0,
  steamGuardRequired: 1,
  steamGuardMobileRequired: 2,
  captchaRequired: 3,
  loggedIn: 4,
  throttled: 5,
};

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeDelay(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function sanitizePositiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function log(message, emptyLine = false) {
  console.log(`[rep4rep-bot] ${message}`);
  if (emptyLine) {
    console.log();
  }
}

function logToFile(username, success = 0, fail = 0) {
  ensureDirectory(LOGS_DIR);
  const date = new Date().toISOString().split('T')[0];
  const logFile = path.join(LOGS_DIR, `${date}.log`);
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${username} - Success: ${success} | Fail: ${fail}\n`;
  fs.appendFileSync(logFile, line);
}

function logInvalidAccount(username, reason) {
  ensureDirectory(LOGS_DIR);
  const date = new Date().toISOString().split('T')[0];
  const logFile = path.join(LOGS_DIR, `invalid-${date}.log`);
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${username} - ${reason}\n`;
  fs.appendFileSync(logFile, line);
}

function removeFromAccountsFile(username) {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    return;
  }

  const lines = fs.readFileSync(ACCOUNTS_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  const filtered = lines.filter((line) => !line.startsWith(`${username}:`));
  const output = filtered.join('\n');
  fs.writeFileSync(ACCOUNTS_PATH, output ? `${output}\n` : '');
}

function readAccountsFile({ silent = false } = {}) {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    if (!silent) {
      log(`Arquivo accounts.txt não encontrado em ${ACCOUNTS_PATH}.`, true);
    }
    return [];
  }

  return fs
    .readFileSync(ACCOUNTS_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseAccountLine(line) {
  const [username, password, sharedSecret] = line.split(':');
  if (!username || !password || !sharedSecret) {
    throw new Error(`Formato inválido de conta: ${line}`);
  }
  return { username, password, sharedSecret };
}

function getReadline() {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function describeApiError(error) {
  if (error instanceof ApiError) {
    const detail = error.payload?.message || error.payload?.error;
    const suffix = detail && detail !== error.message ? ` (${detail})` : '';
    const status = error.status ? ` [status ${error.status}]` : '';
    return `${error.message}${suffix}${status}`;
  }
  return error?.message || String(error);
}

function parseStoredCookies(rawCookies, username) {
  if (!rawCookies) {
    return [];
  }

  if (typeof rawCookies === 'string') {
    try {
      const parsed = JSON.parse(rawCookies);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (username) {
        log(`[${username}] Falha ao interpretar cookies salvos. Ignorando.`);
      }
      return [];
    }
  }

  return Array.isArray(rawCookies) ? rawCookies : [];
}

async function sleep(millis) {
  const ms = Number(millis) || 0;
  if (ms <= 0) {
    return;
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginWithRetries(client, profileOrUsername, password, sharedSecret, cookies, options = {}) {
  const { maxRetries = 3, waitOnThrottle = 30_000 } = options;

  let username;
  let pass;
  let secret;
  let storedCookies;

  if (profileOrUsername && typeof profileOrUsername === 'object' && !Array.isArray(profileOrUsername)) {
    ({ username, password: pass, sharedSecret: secret, cookies: storedCookies } = profileOrUsername);
    if (
      typeof password !== 'undefined' ||
      typeof sharedSecret !== 'undefined' ||
      typeof cookies !== 'undefined'
    ) {
      log('loginWithRetries recebeu objeto de perfil e parâmetros adicionais. Ignorando extras.');
    }
  } else {
    username = profileOrUsername;
    pass = password;
    secret = sharedSecret;
    storedCookies = cookies;
  }

  if (!username || !pass) {
    throw new Error('Credenciais inválidas: username e password são obrigatórios.');
  }

  const parsedCookies = parseStoredCookies(storedCookies, username);
  let fatalMessage = null;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const cookiePayload = attempt === 0 && parsedCookies.length > 0 ? parsedCookies : null;

    try {
      await client.steamLogin(username, pass, null, secret, null, cookiePayload);
      const loggedIn = client.status === statusMessage.loggedIn || (await client.isLoggedIn());
      if (loggedIn) {
        log(`[${username}] login bem-sucedido.`);
        try {
          const freshCookies = await client.getCookies();
          if (freshCookies && freshCookies.length) {
            await db.updateCookies(username, freshCookies);
          }
        } catch (cookieError) {
          log(`[${username}] Não foi possível atualizar cookies: ${cookieError.message}`);
        }
        return { success: true, status: client.status };
      }

      if (
        [
          statusMessage.steamGuardRequired,
          statusMessage.steamGuardMobileRequired,
          statusMessage.captchaRequired,
        ].includes(client.status)
      ) {
        log(`[${username}] login requer ação manual (status: ${client.status}).`);
        return { success: false, requiresAction: true, status: client.status };
      }

      if (client.status === statusMessage.throttled) {
        log(`[${username}] tentativa bloqueada temporariamente. Aguardando para tentar novamente...`);
        await sleep(waitOnThrottle);
        continue;
      }

      lastError = new Error(`Status de login inesperado (${client.status}).`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message || '';

      if (/password|credentials|denied|banned|disabled|vac/i.test(message)) {
        fatalMessage = message;
        break;
      }

      if (/AccountLoginDeniedThrottle|RateLimit|Throttle|too many|temporarily|timeout/i.test(message)) {
        log(`[${username}] aguardando devido ao limite temporário (${message}).`);
        await sleep(waitOnThrottle);
        continue;
      }

      if (attempt < maxRetries - 1) {
        await sleep(5000);
      }
    }
  }

  if (fatalMessage) {
    log(`[${username}] credenciais marcadas como inválidas: ${fatalMessage}`);
    logInvalidAccount(username, fatalMessage);
    try {
      await db.removeProfile(username);
    } catch (error) {
      log(`[${username}] Falha ao remover perfil do banco: ${error.message}`);
    }
    removeFromAccountsFile(username);
    return { success: false, fatal: true, reason: fatalMessage };
  }

  throw lastError || new Error(`[${username}] login falhou após múltiplas tentativas.`);
}

async function removeFromRep4Rep(steamId, options = {}) {
  if (!steamId) {
    return { removed: false };
  }

  try {
    await api.removeSteamProfile(steamId, { token: options.apiToken });
    log(`[Rep4Rep] Removido steamId: ${steamId}`);
    return { removed: true };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || /não encontrado/i.test(error.message))) {
      return { removed: false };
    }
    log(`[Rep4Rep] Falha ao remover ${steamId}: ${describeApiError(error)}`);
    return { removed: false, error };
  }
}

function extractSteamIdsFromSummary(summary) {
  if (!summary || !Array.isArray(summary.perAccount)) {
    return [];
  }

  const ids = summary.perAccount
    .map((item) => (item && item.steamId ? String(item.steamId) : null))
    .filter(Boolean);
  return [...new Set(ids)];
}

async function removeRemoteProfiles(summary, options = {}) {
  const { apiClient = api, apiToken = null } = options;
  const steamIds = extractSteamIdsFromSummary(summary);
  if (!steamIds.length) {
    return { attempted: 0, removed: 0 };
  }

  let removed = 0;
  for (const steamId of steamIds) {
    try {
      await apiClient.removeSteamProfile(steamId, { token: apiToken });
      removed += 1;
    } catch (error) {
      log(`[Rep4Rep] Falha ao remover ${steamId} após execução: ${describeApiError(error)}`);
    }
  }

  return { attempted: steamIds.length, removed };
}

async function showAllProfiles() {
  const profiles = await db.getAllProfiles();
  if (!profiles.length) {
    log('Nenhum perfil cadastrado.');
    return;
  }

  const rows = [['Usuário', 'SteamID', 'Último comentário', 'Comentários (24h)']];
  for (const profile of profiles) {
    const lastComment = profile.lastComment
      ? moment(profile.lastComment).format('YYYY-MM-DD HH:mm')
      : 'nunca';
    const count24h = await db.getCommentsInLast24Hours(profile.steamId);
    rows.push([profile.username, profile.steamId ?? '-', lastComment, String(count24h)]);
  }

  console.log(table(rows));
}

async function addProfilesFromFile(options = {}) {
  const accounts = readAccountsFile();
  if (!accounts.length) {
    log('Nenhuma conta encontrada em accounts.txt.');
    return { added: 0, total: 0 };
  }

  const limit = Number.isFinite(options.limitAccounts)
    ? Math.max(1, Math.floor(options.limitAccounts))
    : null;
  const selectedAccounts = limit ? accounts.slice(0, limit) : accounts;
  if (!selectedAccounts.length) {
    log('Nenhuma conta disponível após aplicar o limite configurado.');
    return { added: 0, total: 0 };
  }

  const existingProfiles = await db.getAllProfiles();
  const knownUsers = new Set(existingProfiles.map((profile) => profile.username));

  let added = 0;

  for (const line of selectedAccounts) {
    let account;
    try {
      account = parseAccountLine(line);
    } catch (error) {
      log(error.message);
      continue;
    }

    if (knownUsers.has(account.username)) {
      log(`[${account.username}] já cadastrado. Pulando.`);
      continue;
    }

    const client = createSteamBot();
    let loginResult;
    try {
      loginResult = await loginWithRetries(client, account, null, null, null, options.loginOptions);
    } catch (error) {
      log(`[${account.username}] Falha ao autenticar: ${error.message}`);
      continue;
    }

    if (!loginResult?.success) {
      if (loginResult?.requiresAction) {
        log(`[${account.username}] requer verificação manual (Steam Guard/CAPTCHA).`);
      }
      continue;
    }

    try {
      const steamId = await client.getSteamId();
      if (!steamId) {
        log(`[${account.username}] SteamID não disponível após login.`);
      } else {
        try {
          await api.addSteamProfile(steamId, { token: options.apiToken });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409)) {
            throw error;
          }
        }
      }
      added += 1;
      knownUsers.add(account.username);
      log(`[${account.username}] perfil adicionado com sucesso.`);
    } catch (error) {
      log(`[${account.username}] Falha ao sincronizar com Rep4Rep: ${describeApiError(error)}`);
    }
  }

  log(`Processo concluído. ${added} novo(s) perfil(is) adicionados.`);
  return { added, total: selectedAccounts.length };
}

async function addProfilesAndRun(options = {}) {
  await addProfilesFromFile(options);
  return autoRun(options);
}

async function runFullCycle(options = {}) {
  const maxAccounts = Number.isFinite(options.maxAccounts)
    ? Math.min(100, Math.max(1, Math.floor(options.maxAccounts)))
    : 100;
  const maxComments = Math.min(
    1000,
    Math.max(1, options.maxCommentsPerAccount ?? MAX_COMMENTS_PER_RUN),
  );
  const apiClient = options.apiClient || api;
  const apiToken = options.apiToken ?? null;

  log(
    `Iniciando fluxo completo com até ${maxAccounts} contas e ${maxComments} comentários por conta.`,
  );

  const addResult = await addProfilesFromFile({
    ...options,
    limitAccounts: maxAccounts,
    apiClient,
    apiToken,
  });

  const summary = await autoRun({
    ...options,
    apiClient,
    apiToken,
    maxCommentsPerAccount: maxComments,
    accountLimit: maxAccounts,
  });

  const cleanup = await removeRemoteProfiles(summary, { apiClient, apiToken });
  return { addResult, summary, cleanup };
}

function resolveRemoteProfileId(remoteProfile) {
  return (
    remoteProfile?.id ??
    remoteProfile?.steamProfileId ??
    remoteProfile?.steamId ??
    null
  );
}

async function runTasksForProfile({
  profile,
  client,
  remoteProfileId,
  apiClient,
  apiToken,
  maxComments,
  commentDelay,
  onTaskComplete,
}) {
  let commentsPosted = 0;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 3;
  const completedTasks = new Set();
  let shouldStop = false;

  const fetchTasks = async () => {
    const payload = await apiClient.getTasks(remoteProfileId, { token: apiToken });
    return Array.isArray(payload) ? payload : [];
  };

  while (commentsPosted < maxComments && consecutiveFailures < maxConsecutiveFailures) {
    const tasks = await fetchTasks();
    const task = tasks.find(
      (item) =>
        item &&
        !completedTasks.has(item.taskId) &&
        item.requiredCommentText &&
        item.targetSteamProfileId,
    );

    if (!task) {
      log(`[${profile.username}] Nenhuma tarefa disponível no momento.`);
      break;
    }

    completedTasks.add(task.taskId);
    log(`[${profile.username}] Comentando em ${task.targetSteamProfileName || task.targetSteamProfileId}`);

    try {
      await client.postComment(task.targetSteamProfileId, task.requiredCommentText);
      commentsPosted += 1;
      consecutiveFailures = 0;

      try {
        await apiClient.completeTask(task.taskId, task.requiredCommentId, remoteProfileId, {
          token: apiToken,
        });
      } catch (error) {
        log(`[${profile.username}] Falha ao confirmar tarefa: ${describeApiError(error)}`);
      }

      try {
        await db.updateLastComment(profile.steamId);
      } catch (error) {
        log(`[${profile.username}] Falha ao atualizar banco: ${error.message}`);
      }

      if (typeof onTaskComplete === 'function') {
        try {
          const result = await onTaskComplete({ profile, task });
          if (result === false) {
            shouldStop = true;
          }
        } catch (callbackError) {
          log(`[${profile.username}] Callback de task falhou: ${callbackError.message}`);
        }
      }

      if (commentsPosted < maxComments) {
        await sleep(commentDelay);
      }
    } catch (error) {
      consecutiveFailures += 1;
      log(`[${profile.username}] Falha ao comentar: ${error.message}`);
      await sleep(commentDelay);
    }

    if (shouldStop) {
      break;
    }
  }

  if (commentsPosted === 0) {
    log(`[${profile.username}] Nenhum comentário enviado.`);
  } else {
    log(`[${profile.username}] Total de comentários enviados: ${commentsPosted}`);
  }

  return { commentsPosted, stoppedEarly: shouldStop };
}

async function autoRun(options = {}) {
  const {
    apiClient = api,
    apiToken = null,
    maxCommentsPerAccount = MAX_COMMENTS_PER_RUN,
    commentDelay = sanitizeDelay(process.env.COMMENT_DELAY, DEFAULT_COMMENT_DELAY),
    loginDelay = sanitizeDelay(process.env.LOGIN_DELAY, DEFAULT_LOGIN_DELAY),
    onTaskComplete,
    filterProfiles,
    accountLimit = null,
    onFinish,
  } = options;

  const accounts = readAccountsFile();
  if (!accounts.length) {
    log('Nenhuma conta configurada no accounts.txt. Adicione contas antes de executar o autoRun.', true);
    return { totalComments: 0, perAccount: [] };
  }

  const limit = Number.isFinite(accountLimit) ? Math.max(1, Math.floor(accountLimit)) : null;
  const selectedAccounts = limit ? accounts.slice(0, limit) : accounts;
  if (!selectedAccounts.length) {
    log('Nenhuma conta disponível para execução após aplicar o limite configurado.', true);
    return { totalComments: 0, perAccount: [] };
  }

  let profiles;
  try {
    profiles = await db.getAllProfiles();
  } catch (error) {
    log(`❌ Falha ao carregar perfis do banco de dados: ${error.message}`, true);
    return { totalComments: 0, perAccount: [] };
  }

  let remoteProfiles;
  try {
    remoteProfiles = await apiClient.getSteamProfiles({ token: apiToken });
  } catch (error) {
    log(`[API] Não foi possível obter os perfis do Rep4Rep: ${describeApiError(error)}`, true);
    return { totalComments: 0, perAccount: [] };
  }

  if (!Array.isArray(remoteProfiles) || remoteProfiles.length === 0) {
    log('[API] Nenhum perfil Rep4Rep encontrado. Execute a sincronização antes do autoRun.', true);
    return { totalComments: 0, perAccount: [] };
  }

  const remoteMap = new Map(remoteProfiles.map((remote) => [String(remote.steamId), remote]));
  const summary = { totalComments: 0, perAccount: [] };

  for (const [index, accountLine] of selectedAccounts.entries()) {
    let account;
    try {
      account = parseAccountLine(accountLine);
    } catch (error) {
      log(error.message);
      continue;
    }

    const profile = profiles.find((item) => item.username === account.username);
    if (!profile) {
      log(`[${account.username}] Perfil não encontrado no banco de dados.`);
      continue;
    }

    if (typeof filterProfiles === 'function' && !filterProfiles(profile)) {
      log(`[${account.username}] Ignorado pelo filtro.`);
      continue;
    }

    const hoursSinceLastComment = profile.lastComment
      ? moment().diff(moment(profile.lastComment), 'hours', true)
      : Infinity;

    if (hoursSinceLastComment < 24) {
      const remaining = Math.max(0, Math.round(24 - hoursSinceLastComment));
      log(`[${account.username}] ainda está em cooldown. Tente novamente em ${remaining}h.`);
      continue;
    }

    let remoteProfile = remoteMap.get(String(profile.steamId));
    if (!remoteProfile) {
      log(`[${account.username}] perfil não sincronizado com Rep4Rep. Tentando adicionar...`);
      try {
        await apiClient.addSteamProfile(profile.steamId, { token: apiToken });
        remoteProfiles = await apiClient.getSteamProfiles({ token: apiToken });
        remoteProfile = remoteProfiles.find((item) => String(item.steamId) === String(profile.steamId));
        if (remoteProfile) {
          remoteMap.set(String(profile.steamId), remoteProfile);
        }
      } catch (error) {
        log(`[${account.username}] Falha ao sincronizar perfil: ${describeApiError(error)}`);
        continue;
      }
    }

    const remoteProfileId = resolveRemoteProfileId(remoteProfile);
    if (!remoteProfileId) {
      log(`[${account.username}] Não foi possível determinar o ID remoto do perfil.`);
      continue;
    }

    const client = createSteamBot();
    let loginResult;
    try {
      loginResult = await loginWithRetries(
        client,
        {
          username: account.username,
          password: account.password,
          sharedSecret: account.sharedSecret,
          cookies: profile.cookies,
        },
        null,
        null,
        null,
        options.loginOptions,
      );
    } catch (error) {
      log(`[${account.username}] Falha ao autenticar: ${error.message}`);
      continue;
    }

    if (!loginResult?.success) {
      if (loginResult?.requiresAction) {
        log(`[${account.username}] requer autenticação manual para atualizar cookies.`);
      }
      continue;
    }

    let comments = 0;
    let stoppedEarly = false;
    try {
      const result = await runTasksForProfile({
        profile,
        client,
        remoteProfileId,
        apiClient,
        apiToken,
        maxComments: Math.max(1, maxCommentsPerAccount),
        commentDelay,
        onTaskComplete,
      });
      comments = result?.commentsPosted ?? 0;
      stoppedEarly = Boolean(result?.stoppedEarly);
    } catch (error) {
      log(`[${account.username}] Falha ao processar tarefas: ${error.message}`);
    }

    summary.perAccount.push({
      username: account.username,
      steamId: profile.steamId,
      comments,
      stoppedEarly,
    });
    summary.totalComments += comments;

    if (stoppedEarly) {
      log('Limite de execução atingido. Encerrando autoRun.');
      break;
    }

    if (index < selectedAccounts.length - 1) {
      await sleep(loginDelay);
    }
  }

  log(`✅ autoRun concluído. Total de comentários enviados: ${summary.totalComments}`);
  if (typeof onFinish === 'function') {
    try {
      await onFinish(summary);
    } catch (error) {
      log(`⚠️ Callback onFinish falhou: ${error.message}`);
    }
  }
  return summary;
}

async function authAllProfiles(options = {}) {
  const profiles = await db.getAllProfiles();
  if (!profiles.length) {
    log('Nenhum perfil cadastrado.');
    return;
  }

  for (const profile of profiles) {
    const client = createSteamBot();
    let loginResult;
    try {
      loginResult = await loginWithRetries(client, profile, null, null, null, options.loginOptions);
    } catch (error) {
      log(`[${profile.username}] Falha ao autenticar: ${error.message}`);
      continue;
    }

    if (!loginResult?.success) {
      if (loginResult?.requiresAction) {
        log(`[${profile.username}] requer autenticação manual.`);
      }
      continue;
    }

    try {
      const cookies = await client.getCookies();
      if (cookies?.length) {
        await db.updateCookies(profile.username, cookies);
      }
      log(`[${profile.username}] autenticado com sucesso.`);
    } catch (error) {
      log(`[${profile.username}] Falha ao atualizar cookies: ${error.message}`);
    }
  }
}

async function removeProfile(username, options = {}) {
  const user = String(username || '').trim();
  if (!user) {
    throw new Error('Informe o username a remover.');
  }

  const profiles = await db.getAllProfiles();
  const profile = profiles.find((item) => item.username === user);
  if (!profile) {
    log(`[${user}] Perfil não encontrado.`);
  } else if (profile.steamId) {
    await removeFromRep4Rep(profile.steamId, { apiToken: options.apiToken });
  }

  await db.removeProfile(user);
  removeFromAccountsFile(user);
  log(`[${user}] Removido do sistema.`);
}

async function prioritizedAutoRun(options = {}) {
  const {
    ownerToken = process.env.REP4REP_KEY ?? null,
    maxCommentsPerAccount = MAX_COMMENTS_PER_RUN,
    accountLimit = 100,
    clientFilter,
    onClientProcessed,
    ...runOverrides
  } = options;

  const maxComments = Math.min(1000, Math.max(1, maxCommentsPerAccount));
  const baseRunOptions = {
    ...runOverrides,
    maxCommentsPerAccount: maxComments,
    accountLimit,
  };

  const result = { owner: null, clients: [] };

  if (ownerToken) {
    log('🚀 Executando lote prioritário do proprietário...');
    try {
      const summary = await autoRun({ ...baseRunOptions, apiToken: ownerToken });
      result.owner = summary;
      if (summary.totalComments > 0) {
        log('Pedidos do proprietário atendidos. Clientes serão processados posteriormente.');
        return result;
      }
    } catch (error) {
      log(`❌ Falha ao executar autoRun prioritário: ${error.message}`);
    }
  } else {
    log('⚠️ Nenhum token do proprietário configurado. Pulando etapa prioritária.');
  }

  let users = [];
  try {
    users = await userStore.listUsers();
  } catch (error) {
    log(`❌ Falha ao carregar usuários para fila de clientes: ${error.message}`);
    return result;
  }

  const eligibleClients = users.filter((user) => {
    if (typeof clientFilter === 'function' && !clientFilter(user)) {
      return false;
    }
    if (!user.rep4repKey) {
      return false;
    }
    if (user.status !== 'active') {
      return false;
    }
    if (user.role === 'admin') {
      return true;
    }
    return user.credits > 0;
  });

  for (const client of eligibleClients) {
    const isAdmin = client.role === 'admin';
    const creditLimit = isAdmin ? Infinity : client.credits;
    let usedCredits = 0;

    log(`🧾 Processando cliente ${client.username} (${client.id}).`);
    try {
      const summary = await autoRun({
        ...baseRunOptions,
        apiToken: client.rep4repKey,
        onTaskComplete: () => {
          if (isAdmin) {
            return true;
          }
          usedCredits += 1;
          return usedCredits < creditLimit;
        },
      });

      const consumed = isAdmin
        ? summary.totalComments
        : Math.min(summary.totalComments ?? usedCredits, creditLimit);

      if (!isAdmin && consumed > 0) {
        try {
          await userStore.consumeCredits(client.id, consumed);
        } catch (creditError) {
          log(`⚠️ Falha ao debitar créditos de ${client.username}: ${creditError.message}`);
        }
      }

      const cleanup = await removeRemoteProfiles(summary, {
        apiToken: client.rep4repKey,
        apiClient: baseRunOptions.apiClient || api,
      });

      const clientResult = { client, summary, creditsConsumed: isAdmin ? 0 : consumed, cleanup };
      result.clients.push(clientResult);
      if (typeof onClientProcessed === 'function') {
        try {
          await onClientProcessed(clientResult);
        } catch (callbackError) {
          log(`⚠️ onClientProcessed falhou: ${callbackError.message}`);
        }
      }

      if (summary.totalComments > 0) {
        log(`✅ Execução concluída para ${client.username}.`);
        break;
      }
    } catch (error) {
      log(`❌ Falha ao processar ${client.username}: ${error.message}`);
    }
  }

  if (!result.clients.length) {
    log('Nenhum cliente elegível para processamento neste ciclo.');
  }

  return result;
}

async function checkAndSyncProfiles(options = {}) {
  const { apiClient = api, apiToken = null } = options;
  const profiles = await db.getAllProfiles();
  if (!profiles.length) {
    log('Nenhum perfil cadastrado.');
    return;
  }

  let remoteProfiles;
  try {
    remoteProfiles = await apiClient.getSteamProfiles({ token: apiToken });
  } catch (error) {
    log(`[API] Falha ao obter perfis: ${describeApiError(error)}`);
    return;
  }

  const remoteMap = new Map(remoteProfiles.map((item) => [String(item.steamId), item]));

  for (const profile of profiles) {
    if (!remoteMap.has(String(profile.steamId))) {
      log(`[${profile.username}] não encontrado no Rep4Rep. Tentando sincronizar.`);
      try {
        await apiClient.addSteamProfile(profile.steamId, { token: apiToken });
        log(`[${profile.username}] sincronizado com sucesso.`);
      } catch (error) {
        log(`[${profile.username}] Falha ao sincronizar: ${describeApiError(error)}`);
      }
    }
  }
}

async function checkCommentAvailability() {
  const profiles = await db.getAllProfiles();
  if (!profiles.length) {
    log('Nenhum perfil cadastrado.');
    return;
  }

  const rows = [['Usuário', 'Horas desde último comentário', 'Status']];
  for (const profile of profiles) {
    const hours = profile.lastComment
      ? moment().diff(moment(profile.lastComment), 'hours', true)
      : Infinity;
    const status = hours >= 24 ? 'Pronto' : 'Cooldown';
    rows.push([
      profile.username,
      Number.isFinite(hours) ? hours.toFixed(1) : '∞',
      status,
    ]);
  }

  console.log(table(rows));
}

async function verifyProfileStatus(options = {}) {
  const profiles = await db.getAllProfiles();
  if (!profiles.length) {
    log('Nenhum perfil cadastrado.');
    return;
  }

  const rows = [['Usuário', 'Status']];
  for (const profile of profiles) {
    const client = createSteamBot();
    try {
      const loginResult = await loginWithRetries(client, profile, null, null, null, {
        maxRetries: 1,
        ...(options.loginOptions || {}),
      });
      if (loginResult?.success) {
        rows.push([profile.username, 'OK']);
      } else if (loginResult?.requiresAction) {
        rows.push([profile.username, 'Ação manual']);
      } else if (loginResult?.fatal) {
        rows.push([profile.username, `Inválido: ${loginResult.reason}`]);
      } else {
        rows.push([profile.username, 'Falha desconhecida']);
      }
    } catch (error) {
      rows.push([profile.username, `Erro: ${error.message}`]);
    }
  }

  console.log(table(rows));
}

async function exportProfilesToCSV() {
  const profiles = await db.getAllProfiles();
  if (!profiles.length) {
    log('Nenhum perfil cadastrado para exportar.');
    return null;
  }

  ensureDirectory(EXPORTS_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(EXPORTS_DIR, `profiles-${timestamp}.csv`);
  const lines = ['username,steamId,lastComment,commentsLast24h'];

  for (const profile of profiles) {
    const count24h = await db.getCommentsInLast24Hours(profile.steamId);
    const lastComment = profile.lastComment ? new Date(profile.lastComment).toISOString() : '';
    const row = [
      JSON.stringify(profile.username ?? ''),
      JSON.stringify(profile.steamId ?? ''),
      JSON.stringify(lastComment),
      JSON.stringify(count24h),
    ].join(',');
    lines.push(row);
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  log(`📄 Exportação concluída em ${filePath}`);
  return filePath;
}

async function clearInvalidAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    log('accounts.txt não encontrado.');
    return { removed: 0, total: 0 };
  }

  const lines = fs.readFileSync(ACCOUNTS_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  const valid = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const account = parseAccountLine(line);
      if (seen.has(account.username)) {
        removed += 1;
        continue;
      }
      seen.add(account.username);
      valid.push(`${account.username}:${account.password}:${account.sharedSecret}`);
    } catch (error) {
      removed += 1;
    }
  }

  fs.writeFileSync(ACCOUNTS_PATH, valid.length ? `${valid.join('\n')}\n` : '');
  log(`Limpeza concluída. ${removed} linha(s) removida(s).`);
  return { removed, total: lines.length };
}

async function collectUsageStats() {
  const profiles = await db.getAllProfiles();
  const totals = {
    total: profiles.length,
    ready: 0,
    coolingDown: 0,
    commentsLast24h: 0,
  };

  for (const profile of profiles) {
    const hours = profile.lastComment
      ? moment().diff(moment(profile.lastComment), 'hours', true)
      : Infinity;
    if (hours >= 24) {
      totals.ready += 1;
    } else {
      totals.coolingDown += 1;
    }
    const count = await db.getCommentsInLast24Hours(profile.steamId);
    totals.commentsLast24h += count;
  }

  return totals;
}

async function usageStats() {
  const stats = await collectUsageStats();
  log('📊 Estatísticas de Uso:');
  log(`Total perfis: ${stats.total}`);
  log(`Perfis ativos (prontos para comentar): ${stats.ready}`);
  log(`Perfis aguardando cooldown: ${stats.coolingDown}`);
  log(`Total de comentários nas últimas 24h: ${stats.commentsLast24h}`);
}

async function resetProfileCookies(options = {}) {
  const profiles = await db.getAllProfiles();
  for (const profile of profiles) {
    const client = createSteamBot();
    try {
      const loginResult = await loginWithRetries(client, profile, null, null, null, options.loginOptions);
      if (!loginResult?.success) {
        if (loginResult?.requiresAction) {
          log(`[${profile.username}] requer autenticação manual para atualizar cookies.`);
        }
        continue;
      }

      const cookies = await client.getCookies();
      if (cookies?.length) {
        await db.updateCookies(profile.username, cookies);
        log(`[${profile.username}] Cookies atualizados.`);
      }
    } catch (error) {
      log(`[${profile.username}] Falha ao resetar cookies: ${error.message}`);
    }
  }
}

async function backupDatabase() {
  try {
    await db.init();
  } catch (error) {
    log(`❌ Falha ao preparar o banco para backup: ${error.message}`, true);
    return null;
  }

  const src = db.getDatabasePath();
  if (!fs.existsSync(src)) {
    log('⚠️ Nenhum banco de dados encontrado para backup.', true);
    return null;
  }

  ensureDirectory(BACKUPS_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUPS_DIR, `db-${timestamp}.sqlite`);

  try {
    fs.copyFileSync(src, dest);
  } catch (error) {
    log(`❌ Falha ao criar backup: ${error.message}`, true);
    return null;
  }

  log(`📦 Backup criado em: ${dest}`);
  return dest;
}

module.exports = {
  log,
  logToFile,
  logInvalidAccount,
  removeFromAccountsFile,
  removeFromRep4Rep,
  removeRemoteProfiles,
  loginWithRetries,
  statusMessage,
  showAllProfiles,
  addProfileSetup: addProfilesFromFile,
  authAllProfiles,
  removeProfile,
  autoRun,
  addProfilesFromFile,
  addProfilesAndRun,
  runFullCycle,
  prioritizedAutoRun,
  checkAndSyncProfiles,
  checkCommentAvailability,
  verifyProfileStatus,
  exportProfilesToCSV,
  clearInvalidAccounts,
  usageStats,
  collectUsageStats,
  resetProfileCookies,
  backupDatabase,
  describeApiError,
  readAccountsFile,
  parseStoredCookies,
  closeReadline,
};
