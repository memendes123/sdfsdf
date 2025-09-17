const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { table } = require('table');
const readline = require('readline');

require('dotenv').config();

const db = require('./db.cjs');
const apiModule = require('./api.cjs');
const api = apiModule;
const { ApiError } = apiModule;
const createSteamBot = require('./steamBot.cjs');

const ROOT_DIR = path.join(__dirname, '..');
const ACCOUNTS_PATH = path.join(ROOT_DIR, 'accounts.txt');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');

const DEFAULT_LOGIN_DELAY = 30000;
const DEFAULT_COMMENT_DELAY = 15000;
const MAX_COMMENTS_PER_RUN = sanitizePositiveInteger(
  process.env.MAX_COMMENTS_PER_RUN ??
    process.env.COMMENT_LIMIT ??
    process.env.MAX_COMMENTS,
  10
);

let rl = null;

const statusMessage = {
  inactive: 0,
  steamGuardRequired: 1,
  steamGuardMobileRequired: 2,
  captchaRequired: 3,
  loggedIn: 4,
  throttled: 5,
};

function sanitizeDelay(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function sanitizePositiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
  if (!fs.existsSync(ACCOUNTS_PATH)) return;
  const lines = fs.readFileSync(ACCOUNTS_PATH, 'utf-8').split(/\r?\n/);
  const filtered = lines.filter((line) => line && !line.startsWith(`${username}:`));
  fs.writeFileSync(ACCOUNTS_PATH, filtered.join('\n'));
}

function readAccountsFile({ silent = false } = {}) {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    if (!silent) {
      log(`Arquivo accounts.txt não encontrado em ${ACCOUNTS_PATH}.`, true);
    }
    return [];
  }

  return fs
    .readFileSync(ACCOUNTS_PATH, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
        log(`[${username}] Falha ao ler cookies salvos. Ignorando.`);
      }
      return [];
    }
  }

  return Array.isArray(rawCookies) ? rawCookies : [];
}

async function sleep(millis, { announce = false } = {}) {
  const ms = Number(millis) || 0;
  if (ms <= 0) return;
  if (announce) {
    const sec = Math.round(ms / 1000);
    log(`[ pausa de ${sec}s ]`);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAccountLine(line) {
  const [username, password, sharedSecret] = line.split(':');
  if (!username || !password || !sharedSecret) {
    throw new Error(`Formato inválido de conta: ${line}`);
  }
  return { username, password, sharedSecret };
}

async function removeFromRep4Rep(steamId) {
  if (!steamId) return { removed: false };
  try {
    await api.removeSteamProfile(steamId);
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

async function loginWithRetries(client, profileOrUsername, password, sharedSecret, cookies, options = {}) {
  const { maxRetries = 3, waitOnThrottle = 30000 } = options;

  let username;
  let pass;
  let secret;
  let storedCookies;

  if (profileOrUsername && typeof profileOrUsername === 'object') {
    ({ username, password: pass, sharedSecret: secret, cookies: storedCookies } = profileOrUsername);
    if (password || sharedSecret || cookies) {
      log('loginWithRetries recebeu objeto de perfil e parâmetros extras. Ignorando parâmetros adicionais.');
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
  let lastError = null;
  let fatalError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const useCookies = attempt === 0 && parsedCookies.length > 0 ? parsedCookies : null;

    try {
      await client.steamLogin(username, pass, null, secret, null, useCookies);
      const status = client.status;
      const isLoggedIn = status === statusMessage.loggedIn || (await client.isLoggedIn());

      if (isLoggedIn) {
        log(`[${username}] login efetuado com sucesso.`);
        return { success: true, status };
      }

      if (
        status === statusMessage.steamGuardRequired ||
        status === statusMessage.steamGuardMobileRequired ||
        status === statusMessage.captchaRequired
      ) {
        log(`[${username}] login requer verificação manual (status ${status}).`);
        return { success: false, requiresAction: true, status };
      }

      if (status === statusMessage.throttled) {
        log(`[${username}] tentativa bloqueada temporariamente. Aguardando para tentar novamente...`);
        await sleep(waitOnThrottle, { announce: true });
        continue;
      }

      lastError = new Error(`Status de login inesperado (${status}).`);
    } catch (error) {
      const message = error?.message || '';

      if (/AccountLoginDeniedThrottle/i.test(message)) {
        log(`[${username}] login bloqueado temporariamente pelo Steam (${message}).`);
        await sleep(waitOnThrottle, { announce: true });
        lastError = error;
        continue;
      }

      if (/RateLimit|Throttle|too many|temporarily|timeout/i.test(message)) {
        log(`[${username}] aguardando devido a limite temporário (${message}).`);
        await sleep(waitOnThrottle, { announce: true });
        lastError = error;
        continue;
      }

      if (/password|credentials|denied|banned|disabled|vac/i.test(message)) {
        fatalError = message;
        break;
      }

      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries - 1) {
        await sleep(5000);
      }
    }
  }

  if (fatalError) {
    log(`[${username}] login marcado como inválido: ${fatalError}`);
    logInvalidAccount(username, fatalError);

    try {
      const profiles = await db.getAllProfiles();
      const profile = profiles.find((p) => p.username === username);
      if (profile?.steamId) {
        await removeFromRep4Rep(profile.steamId);
      }
    } catch (error) {
      log(`[${username}] Falha ao localizar perfil para limpeza: ${error.message}`);
    }

    await db.removeProfile(username);
    removeFromAccountsFile(username);

    return { success: false, fatal: true, reason: fatalError };
  }

  throw lastError || new Error(`[${username}] login falhou após ${maxRetries} tentativas.`);
}

async function syncWithRep4rep(client) {
  let steamId = await client.getSteamId();
  if (!steamId) {
    return 'Não foi possível obter o SteamID do cliente.';
  }

  let steamProfiles;
  try {
    steamProfiles = await api.getSteamProfiles();
  } catch (error) {
    const message = describeApiError(error);
    log(`Erro ao obter steamProfiles: ${message}`);
    return `Erro ao obter steamProfiles: ${message}`;
  }

  if (!Array.isArray(steamProfiles)) {
    return 'Resposta inválida ao obter perfis Rep4Rep.';
  }

  const exists = steamProfiles.some((steamProfile) => String(steamProfile.steamId) === String(steamId));

  if (!exists) {
    try {
      const res = await api.addSteamProfile(steamId);
      if (res?.error) {
        return res.error;
      }
    } catch (error) {
      const message = describeApiError(error);
      log(`Erro ao adicionar steamProfile: ${message}`);
      return `Erro ao adicionar steamProfile: ${message}`;
    }
  }

  return true;
}

async function promptForCode(username, client) {
  switch (client.status) {
    case statusMessage.steamGuardRequired:
      log(`[${username}] Código Steam Guard por email necessário (${client.emailDomain || 'email desconhecido'}).`);
      break;
    case statusMessage.steamGuardMobileRequired:
      log(`[${username}] Código do Steam Guard Mobile necessário.`);
      break;
    case statusMessage.captchaRequired:
      log(`[${username}] CAPTCHA necessário. URL: ${client.captchaUrl}`);
      break;
    default:
      log(`[${username}] Código adicional requerido.`);
  }

  return new Promise((resolve) => {
    getReadline().question('>> ', (answer) => {
      resolve(answer.trim());
    });
  });
}

async function addProfileSetup(accountName, password, sharedSecret) {
  const client = createSteamBot();

  const maxAttempts = 5;
  let attempts = 0;
  let success = false;

  while (attempts < maxAttempts && !success) {
    attempts += 1;
    try {
      await client.steamLogin(accountName, password, null, sharedSecret, null);
      let loggedIn = client.status === statusMessage.loggedIn || (await client.isLoggedIn());

      if (!loggedIn) {
        if (
          client.status === statusMessage.steamGuardRequired ||
          client.status === statusMessage.steamGuardMobileRequired ||
          client.status === statusMessage.captchaRequired
        ) {
          const code = await promptForCode(accountName, client);
          if (!code) {
            throw new Error('Código obrigatório não fornecido.');
          }
          const captcha = client.status === statusMessage.captchaRequired ? code : null;
          const guardCode = client.status !== statusMessage.captchaRequired ? code : null;
          await client.steamLogin(accountName, password, guardCode, sharedSecret, captcha);
          loggedIn = client.status === statusMessage.loggedIn || (await client.isLoggedIn());
        } else if (client.status === statusMessage.throttled) {
          log(`[${accountName}] tentativa temporariamente bloqueada. Aguardando antes de tentar novamente.`);
          await sleep(30000, { announce: true });
          continue;
        }
      }

      if (!loggedIn) {
        throw new Error('Não foi possível autenticar o perfil.');
      }

      const res = await syncWithRep4rep(client);
      if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
        log(`[${accountName}] sincronizado com Rep4Rep`, true);
      } else {
        log(`[${accountName}] falha ao sincronizar: ${res}`, true);
      }

      log(`[${accountName}] Perfil adicionado com sucesso.`);
      success = true;
    } catch (error) {
      const message = error?.message || String(error);
      log(`Erro ao adicionar perfil ${accountName}: ${message}`);
      if (message.includes('RateLimitExceeded')) {
        await sleep(60000, { announce: true });
      } else if (attempts < maxAttempts) {
        await sleep(5000);
      }
    }
  }

  if (!success) {
    log(`Falha ao adicionar perfil ${accountName} após ${maxAttempts} tentativas.`);
  }
}

async function autoRunComments({ profile, client, tasks, remoteProfileId, maxComments, commentDelay }) {
  let commentsPosted = 0;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 3;
  const completedTasks = new Set();

  const ensureTasks = async () => {
    if (Array.isArray(tasks) && tasks.length) {
      return tasks;
    }
    const freshTasks = await api.getTasks(remoteProfileId);
    tasks = Array.isArray(freshTasks) ? freshTasks : [];
    return tasks;
  };

  while (commentsPosted < maxComments && consecutiveFailures < maxConsecutiveFailures) {
    const availableTasks = (await ensureTasks()).filter(
      (task) => task && !completedTasks.has(task.taskId) && task.requiredCommentText && task.targetSteamProfileId
    );

    if (availableTasks.length === 0) {
      log(`[${profile.username}] nenhuma tarefa válida disponível no momento.`);
      break;
    }

    const task = availableTasks.shift();
    completedTasks.add(task.taskId);

    log(`[${profile.username}] Comentando em ${task.targetSteamProfileName || task.targetSteamProfileId}`);
    log(task.requiredCommentText);

    try {
      await client.postComment(task.targetSteamProfileId, task.requiredCommentText);
      commentsPosted += 1;
      consecutiveFailures = 0;

      try {
        await api.completeTask(task.taskId, task.requiredCommentId, remoteProfileId);
      } catch (error) {
        log(`[${profile.username}] falha ao confirmar tarefa: ${describeApiError(error)}`);
      }

      try {
        await db.updateLastComment(profile.steamId);
      } catch (error) {
        log(`[${profile.username}] falha ao atualizar banco: ${error.message}`);
      }

      if (commentsPosted < maxComments) {
        await sleep(commentDelay);
      }
    } catch (error) {
      consecutiveFailures += 1;
      log(`[${profile.username}] falha ao comentar: ${error.message}`);
      await sleep(commentDelay);
    }
  }

  if (commentsPosted === 0) {
    log(`[${profile.username}] nenhum comentário enviado.`);
  } else {
    log(`[${profile.username}] total de comentários enviados: ${commentsPosted}`);
  }

  return commentsPosted;
}

async function autoRun() {
  const accounts = readAccountsFile();
  if (!accounts.length) {
    log('Nenhuma conta configurada no accounts.txt. Adicione contas antes de executar o autoRun.', true);
    return;
  }

  let profiles;
  try {
    profiles = await db.getAllProfiles();
  } catch (error) {
    log(`❌ Falha ao carregar perfis do banco de dados: ${error.message}`, true);
    return;
  }

  let remoteProfiles;
  try {
    remoteProfiles = await api.getSteamProfiles();
  } catch (error) {
    log(`[API] Não foi possível obter os perfis do Rep4Rep: ${describeApiError(error)}`, true);
    return;
  }

  if (!Array.isArray(remoteProfiles) || remoteProfiles.length === 0) {
    log('[API] Nenhum perfil Rep4Rep encontrado. Execute a sincronização (--auth-profiles) antes do autoRun.', true);
    return;
  }

  const profileMap = new Map(profiles.map((profile) => [profile.username, profile]));
  const remoteMap = new Map(remoteProfiles.map((remote) => [String(remote.steamId), remote]));

  const loginDelay = sanitizeDelay(process.env.LOGIN_DELAY, DEFAULT_LOGIN_DELAY);
  const commentDelay = sanitizeDelay(process.env.COMMENT_DELAY, DEFAULT_COMMENT_DELAY);
  const maxComments = Math.max(1, MAX_COMMENTS_PER_RUN);

  for (const [index, accountLine] of accounts.entries()) {
    let account;
    try {
      account = parseAccountLine(accountLine);
    } catch (error) {
      log(error.message);
      continue;
    }

    const { username, password, sharedSecret } = account;
    log(`Processando ${username} (${index + 1}/${accounts.length})`);

    const profile = profileMap.get(username);
    if (!profile) {
      log(`Perfil local não encontrado para ${username}. Execute addProfileSetup primeiro.`);
      continue;
    }

    const remoteProfile = remoteMap.get(String(profile.steamId));
    if (!remoteProfile) {
      log(`[${username}] perfil não sincronizado no Rep4Rep.`);
      log('Sincronize os perfis com --auth-profiles e tente novamente.', true);
      continue;
    }

    const hoursSinceLastComment = profile.lastComment ? moment().diff(moment(profile.lastComment), 'hours') : Infinity;
    if (Number.isFinite(hoursSinceLastComment) && hoursSinceLastComment < 24) {
      const remaining = Math.max(0, Math.ceil(24 - hoursSinceLastComment));
      log(`[${username}] ainda em cooldown. Tente novamente em aproximadamente ${remaining}h.`);
      continue;
    }

    const client = createSteamBot();
    let loginResult;
    try {
      loginResult = await loginWithRetries(client, username, password, sharedSecret, profile.cookies);
    } catch (error) {
      log(`[${username}] falha ao autenticar: ${error.message}`, true);
      continue;
    }

    if (!loginResult.success) {
      if (loginResult.requiresAction) {
        log(`[${username}] requer verificação manual. Pule para o próximo perfil.`, true);
      } else if (loginResult.fatal) {
        log(`[${username}] marcado como inválido. Perfil removido das filas.`, true);
      } else {
        log(`[${username}] não conseguiu autenticar automaticamente.`, true);
      }
      continue;
    }

    let tasks;
    try {
      tasks = await api.getTasks(remoteProfile.id);
    } catch (error) {
      log(`[${username}] falha ao obter tarefas: ${describeApiError(error)}`, true);
      continue;
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      log(`[${username}] nenhuma tarefa disponível.`, true);
      continue;
    }

    await autoRunComments({
      profile,
      client,
      tasks,
      remoteProfileId: remoteProfile.id,
      maxComments,
      commentDelay,
    });

    if (index !== accounts.length - 1) {
      await sleep(loginDelay);
    }
  }

  log('autoRun concluído.');
}

async function showAllProfiles() {
  const profiles = await db.getAllProfiles();
  const data = [['steamId', 'username', 'lastComment']];
  profiles.forEach((profile) => {
    data.push([profile.steamId, profile.username, profile.lastComment]);
  });
  console.log(table(data));
}

async function authAllProfiles() {
  const profiles = await db.getAllProfiles();
  const loginDelay = sanitizeDelay(process.env.LOGIN_DELAY, DEFAULT_LOGIN_DELAY);

  for (const [index, profile] of profiles.entries()) {
    log(`Autenticando ${profile.username} (${profile.steamId})`);
    const client = createSteamBot();

    let loginResult;
    try {
      loginResult = await loginWithRetries(client, profile);
    } catch (error) {
      log(`[${profile.username}] Falha ao autenticar: ${error.message}`, true);
      continue;
    }

    if (!loginResult.success) {
      if (loginResult.requiresAction) {
        log(`[${profile.username}] requer verificação manual. Pulando.`, true);
      } else if (loginResult.fatal) {
        log(`[${profile.username}] credenciais inválidas. Perfil removido.`, true);
      }
      continue;
    }

    log(`[${profile.username}] autenticado.`);

    try {
      const res = await syncWithRep4rep(client);
      if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
        log(`[${profile.username}] sincronizado com Rep4Rep`, true);
      } else {
        log(`[${profile.username}] falhou ao sincronizar: ${res}`, true);
      }
    } catch (error) {
      log(`[${profile.username}] erro ao sincronizar: ${describeApiError(error)}`, true);
    }

    if (index !== profiles.length - 1) {
      await sleep(loginDelay);
    }
  }

  log('authProfiles concluído.');
}

async function removeProfile(username, { skipRemote = false } = {}) {
  const target = typeof username === 'string' ? username.trim() : '';
  if (!target) {
    const message = 'Informe o usuário a remover.';
    log(message, true);
    return { success: false, message };
  }

  let profile;
  try {
    const profiles = await db.getAllProfiles();
    profile = profiles.find((p) => p.username === target);
  } catch (error) {
    const message = `❌ Falha ao carregar perfis: ${error.message}`;
    log(message, true);
    return { success: false, message };
  }

  if (!profile) {
    const message = `⚠️ Perfil '${target}' não encontrado.`;
    log(message, true);
    return { success: false, message };
  }

  let remoteRemoved = false;
  if (!skipRemote && profile.steamId) {
    const result = await removeFromRep4Rep(profile.steamId);
    remoteRemoved = Boolean(result.removed);
  }

  try {
    const result = await db.removeProfile(target);
    if (!result || result.changes === 0) {
      const message = `⚠️ Nenhuma entrada removida para '${target}'.`;
      log(message, true);
      return { success: false, message, remoteRemoved };
    }
  } catch (error) {
    const message = `❌ Erro ao remover '${target}' do banco: ${error.message}`;
    log(message, true);
    return { success: false, message, remoteRemoved };
  }

  removeFromAccountsFile(target);
  const message = `✅ Remoção local concluída para '${target}'.`;
  log(message, true);
  return { success: true, message, remoteRemoved };
}

async function addProfilesFromFile() {
  const accounts = readAccountsFile();
  if (!accounts.length) {
    log('Nenhuma conta encontrada para adicionar.', true);
    return;
  }

  for (const [index, line] of accounts.entries()) {
    try {
      const { username, password, sharedSecret } = parseAccountLine(line);
      log(`Adicionando perfil ${index + 1} de ${accounts.length}: ${username}`);
      await addProfileSetup(username, password, sharedSecret);
    } catch (error) {
      log(`Erro ao adicionar perfil: ${error.message}`);
    }

    if (index !== accounts.length - 1) {
      await sleep(30000, { announce: true });
    }
  }

  log('Todos os perfis foram processados.');
}

async function addProfilesAndRun() {
  const accounts = readAccountsFile();
  if (!accounts.length) {
    log('Nenhuma conta encontrada para adicionar e executar.', true);
    return;
  }

  for (const [index, line] of accounts.entries()) {
    try {
      const { username, password, sharedSecret } = parseAccountLine(line);
      log(`Adicionando e executando perfil ${index + 1} de ${accounts.length}: ${username}`);
      await addProfileSetup(username, password, sharedSecret);
      await autoRun();
    } catch (error) {
      log(`Erro ao processar perfil: ${error.message}`);
    }

    if (index !== accounts.length - 1) {
      await sleep(30000, { announce: true });
    }
  }

  log('Processo de adicionar e executar concluído.');
}

async function checkAndSyncProfiles() {
  const profiles = await db.getAllProfiles();

  for (const profile of profiles) {
    log(`Verificando ${profile.username} (${profile.steamId})`);
    const client = createSteamBot();

    try {
      const loginResult = await loginWithRetries(client, profile);
      if (!loginResult.success) {
        if (loginResult.requiresAction) {
          log(`[${profile.username}] requer ação manual antes da sincronização.`);
        } else if (loginResult.fatal) {
          log(`[${profile.username}] removido por credenciais inválidas.`);
        }
        continue;
      }

      const res = await syncWithRep4rep(client);
      if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
        log(`[${profile.username}] sincronizado com sucesso.`);
      } else {
        log(`[${profile.username}] falhou ao sincronizar: ${res}`);
      }
    } catch (error) {
      log(`[${profile.username}] Erro ao sincronizar: ${describeApiError(error)}`);
    }
  }

  log('Sincronização concluída.');
}

async function checkCommentAvailability() {
  const profiles = await db.getAllProfiles();
  for (const profile of profiles) {
    const commentsInLast24Hours = await db.getCommentsInLast24Hours(profile.steamId);
    const commentsAvailable = Math.max(10 - commentsInLast24Hours, 0);
    log(`[${profile.username}] pode fazer mais ${commentsAvailable} comentários nas próximas 24 horas.`);
  }
  log('Verificação de disponibilidade concluída.');
}

async function verifyProfileStatus() {
  const profiles = await db.getAllProfiles();
  for (const profile of profiles) {
    const client = createSteamBot();
    try {
      const cookies = parseStoredCookies(profile.cookies, profile.username);
      await client.steamLogin(
        profile.username,
        profile.password,
        null,
        profile.sharedSecret,
        null,
        cookies.length ? cookies : null
      );
      const isLoggedIn = client.status === statusMessage.loggedIn || (await client.isLoggedIn());
      log(`[${profile.username}] ${isLoggedIn ? '✅ Logado' : '❌ Não logado'}`);
    } catch (error) {
      log(`[${profile.username}] ❌ Erro ao verificar login: ${error.message}`);
    }
  }
}

async function exportProfilesToCSV() {
  const profiles = await db.getAllProfiles();
  const lines = ['steamId,username,lastComment'];
  profiles.forEach((profile) => lines.push(`${profile.steamId},${profile.username},${profile.lastComment ?? ''}`));
  const filePath = path.join(ROOT_DIR, 'exported_profiles.csv');
  fs.writeFileSync(filePath, lines.join('\n'));
  log(`Perfis exportados para: ${filePath}`);
}

async function clearInvalidAccounts() {
  const date = new Date().toISOString().split('T')[0];
  const logFile = path.join(LOGS_DIR, `invalid-${date}.log`);
  if (!fs.existsSync(logFile)) {
    log('Nenhum arquivo de inválidos encontrado.');
    return;
  }
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    const [, userWithReason] = line.split(']');
    const username = userWithReason ? userWithReason.split(' - ')[0].trim() : null;
    if (!username) continue;
    await db.removeProfile(username);
    removeFromAccountsFile(username);
    log(`Removido inválido: ${username}`);
  }
  log('Perfis inválidos removidos.');
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
    const lastCommentMoment = profile.lastComment ? moment(profile.lastComment) : null;
    const diff = lastCommentMoment ? moment().diff(lastCommentMoment, 'hours') : Infinity;
    if (!lastCommentMoment || diff >= 24) {
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

async function resetProfileCookies() {
  const profiles = await db.getAllProfiles();
  for (const profile of profiles) {
    const client = createSteamBot();
    try {
      const loginResult = await loginWithRetries(client, profile);
      if (!loginResult.success) {
        if (loginResult.requiresAction) {
          log(`[${profile.username}] requer autenticação manual para atualizar cookies.`);
        } else if (loginResult.fatal) {
          log(`[${profile.username}] removido por credenciais inválidas.`);
        }
        continue;
      }

      const cookies = await client.getCookies();
      await db.updateCookies(profile.username, cookies);
      log(`[${profile.username}] Cookies atualizados.`);
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
  const timestamp = new Date().toISOString().replace(/:/g, '-');
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
  loginWithRetries,
  statusMessage,
  showAllProfiles,
  addProfileSetup,
  authAllProfiles,
  removeProfile,
  autoRun,
  addProfilesFromFile,
  addProfilesAndRun,
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
