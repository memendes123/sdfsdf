const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { table } = require('table');
const readline = require('readline');
const dotenv = require('dotenv');

const ROOT_DIR = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const db = require('./db.cjs');
const api = require('./api.cjs');
const { ApiError } = require('./api.cjs');
const createSteamBot = require('./steamBot.cjs');
const userStore = require('../web/services/userStore');
const runQueue = require('./runQueue.cjs');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const ACCOUNTS_PATH = path.join(ROOT_DIR, 'accounts.txt');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const MAINTENANCE_STATE_FILE = path.join(DATA_DIR, 'maintenance-state.json');
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
const KEEPALIVE_INTERVAL_MINUTES = Math.max(5, sanitizePositiveInteger(
  process.env.KEEPALIVE_INTERVAL_MINUTES,
  15,
));
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const BACKUP_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || '').trim();
const DISCORD_WEBHOOK_USERNAME = process.env.DISCORD_WEBHOOK_USERNAME || 'Rep4Rep Bot';
const DISCORD_WEBHOOK_AVATAR_URL = (process.env.DISCORD_WEBHOOK_AVATAR_URL || '').trim();

function normalizeApiToken(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getEnvRep4RepKey() {
  return normalizeApiToken(process.env.REP4REP_KEY) || '';
}

function resolveApiToken(token, { fallbackToEnv = true } = {}) {
  if (token === false) {
  if (token === '' || token === false) {
    return null;
  }
  const direct = normalizeApiToken(token);
  if (direct) {
    return direct;
  }
  if (!fallbackToEnv) {
    return null;
  }
  const envToken = normalizeApiToken(process.env.REP4REP_KEY);
  return envToken || null;
}

const normalizedEnvToken = normalizeApiToken(process.env.REP4REP_KEY);
if (normalizedEnvToken) {
  process.env.REP4REP_KEY = normalizedEnvToken;
}

let fetchModulePromise = null;

async function resolveFetch() {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }

  if (!fetchModulePromise) {
    fetchModulePromise = import('node-fetch').then(({ default: fetch }) => fetch);
  }

  return fetchModulePromise;
}

let rl = null;

const maintenanceState = {
  backupTimer: null,
  initialized: false,
  lastAutomaticBackup: null,
};

const IMMEDIATE_BACKUP_DEBOUNCE_MS = 1500;
let scheduledBackupTimer = null;
let scheduledBackupPromise = null;
let scheduledBackupReason = 'alteração';
let scheduledBackupResolve = null;
let scheduledBackupReject = null;

const keepAliveState = {
  running: false,
  stopRequested: false,
  promise: null,
  intervalMs: KEEPALIVE_INTERVAL_MINUTES * 60 * 1000,
  lastRunAt: null,
  startedAt: null,
  lastError: null,
  runs: 0,
  ownerToken: null,
  ownerWebhookUrl: null,
};

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

async function sendDiscordWebhook(payload = {}, options = {}) {
  const overrideUrl = (options.overrideUrl || options.webhookUrl || '').trim();
  const targetUrl = overrideUrl || DISCORD_WEBHOOK_URL;
  if (!targetUrl) {
    return false;
  }

  try {
    const fetch = await resolveFetch();
    const username = options.username || DISCORD_WEBHOOK_USERNAME;
    const avatarUrl =
      options.avatarUrl === null
        ? undefined
        : options.avatarUrl || DISCORD_WEBHOOK_AVATAR_URL || undefined;
    const body = {
      username,
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      ...payload,
    };

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const targetLabel = overrideUrl ? ' (customizado)' : '';

    if (!response.ok) {
      let details = '';
      try {
        details = await response.text();
      } catch (error) {
        details = '';
      }
      const snippet = details ? details.slice(0, 140) : '';
      log(
        `⚠️ Webhook do Discord${targetLabel} respondeu com status ${response.status}${
          snippet ? ` – ${snippet}` : ''
        }`,
      );
      return false;
    }

    return true;
  } catch (error) {
    const targetLabel = overrideUrl ? ' (customizado)' : '';
    log(`⚠️ Falha ao enviar webhook do Discord${targetLabel}: ${error.message}`);
    return false;
  }
}

function formatClientLabel(client) {
  if (!client) {
    return 'Cliente';
  }
  return (
    client.fullName ||
    client.displayName ||
    client.username ||
    client.id ||
    (typeof client === 'string' ? client : 'Cliente')
  );
}

function buildLimitLabel(job) {
  if (!job) {
    return '--';
  }
  const maxComments = Number(job.maxCommentsPerAccount);
  const accountLimit = Number(job.accountLimit);
  const commentsText = Number.isFinite(maxComments) ? `${maxComments} comentários/conta` : '—';
  const accountsText = Number.isFinite(accountLimit) ? `${accountLimit} contas` : '—';
  return `${commentsText} · ${accountsText}`;
}

function summarizePerAccount(perAccount = []) {
  if (!Array.isArray(perAccount) || perAccount.length === 0) {
    return null;
  }

  const topEntries = perAccount.slice(0, 5).map((item) => {
    const username = item?.username || item?.profile || 'conta';
    const comments = Number(item?.comments) || 0;
    const suffix = item?.stoppedEarly ? ' (limite atingido)' : '';
    return `• ${username}: ${comments}${suffix}`;
  });

  if (perAccount.length > topEntries.length) {
    topEntries.push(`• ... +${perAccount.length - topEntries.length} conta(s)`);
  }

  return topEntries.join('\n');
}

async function announceQueueEvent(event = {}) {
  const job = event.job || null;
  const client = event.client || job?.user || null;
  const clientLabel = formatClientLabel(client);
  const clientWebhookUrl = (client?.discordWebhookUrl || '').trim();
  const embed = {
    timestamp: new Date().toISOString(),
    fields: [],
  };

  if (job?.id) {
    embed.footer = { text: `Job ${job.id}` };
  }

  switch (event.type) {
    case 'job.completed': {
      const totalComments = Number(event.summary?.totalComments ?? job?.totalComments ?? 0);
      const credits = Number(event.creditsConsumed ?? job?.creditsConsumed ?? 0);
      embed.title = `✅ Pedido concluído – ${clientLabel}`;
      embed.description = `autoRun finalizado com ${totalComments} comentário(s).`;
      embed.color = 0x2ecc71;
      embed.fields.push({ name: 'Comentários enviados', value: String(totalComments), inline: true });
      embed.fields.push({ name: 'Créditos debitados', value: String(Math.max(0, credits)), inline: true });
      embed.fields.push({ name: 'Limites aplicados', value: buildLimitLabel(job), inline: false });
      const perAccountSummary = summarizePerAccount(event.summary?.perAccount);
      if (perAccountSummary) {
        embed.fields.push({ name: 'Detalhes por conta', value: perAccountSummary, inline: false });
      }
      break;
    }
    case 'job.failed': {
      embed.title = `❌ Pedido falhou – ${clientLabel}`;
      embed.description = event.error || job?.error || 'Falha desconhecida.';
      embed.color = 0xe74c3c;
      embed.fields.push({ name: 'Limites aplicados', value: buildLimitLabel(job), inline: true });
      break;
    }
    case 'job.cancelled': {
      embed.title = `⏹️ Pedido cancelado – ${clientLabel}`;
      const actor = event.cancelledBy ? ` por ${event.cancelledBy}` : '';
      embed.description = `Pedido cancelado${actor}.`;
      embed.color = 0x95a5a6;
      embed.fields.push({ name: 'Limites aplicados', value: buildLimitLabel(job), inline: true });
      if (event.reason) {
        embed.fields.push({ name: 'Motivo', value: event.reason, inline: true });
      }
      break;
    }
    case 'owner.completed': {
      const totalOwner = Number(event.summary?.totalComments ?? 0);
      embed.title = '🚀 Execução prioritária concluída';
      embed.description = `O lote do proprietário finalizou com ${totalOwner} comentário(s).`;
      embed.color = 0x3498db;
      const perAccountSummary = summarizePerAccount(event.summary?.perAccount);
      if (perAccountSummary) {
        embed.fields.push({ name: 'Detalhes por conta', value: perAccountSummary, inline: false });
      }
      break;
    }
    default:
      return false;
  }

  const payload = { embeds: [embed] };
  const targets = new Set();

  if (DISCORD_WEBHOOK_URL) {
    targets.add(DISCORD_WEBHOOK_URL);
  }

  if (clientWebhookUrl) {
    targets.add(clientWebhookUrl);
  }

  if (event.webhookUrl) {
    const explicitUrl = String(event.webhookUrl).trim();
    if (explicitUrl) {
      targets.add(explicitUrl);
    }
  }

  if (!targets.size) {
    return false;
  }

  const deliveries = [];
  for (const url of targets) {
    if (!url) {
      continue;
    }
    if (DISCORD_WEBHOOK_URL && url === DISCORD_WEBHOOK_URL) {
      deliveries.push(sendDiscordWebhook(payload));
    } else {
      deliveries.push(sendDiscordWebhook(payload, { overrideUrl: url }));
    }
  }

  if (!deliveries.length) {
    return false;
  }

  const results = await Promise.allSettled(deliveries);
  return results.some((result) => result.status === 'fulfilled' && result.value === true);
}

function readMaintenanceMetadata() {
  try {
    const raw = fs.readFileSync(MAINTENANCE_STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') {
      return {};
    }
    return data;
  } catch (error) {
    return {};
  }
}

function writeMaintenanceMetadata(data) {
  try {
    ensureDirectory(path.dirname(MAINTENANCE_STATE_FILE));
    fs.writeFileSync(MAINTENANCE_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    log(`⚠️ Não foi possível salvar metadados de manutenção: ${error.message}`);
  }
}

function getLatestBackupTimestamp() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    return 0;
  }

  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter((file) => file.toLowerCase().endsWith('.sqlite'));

  let latest = 0;
  for (const file of files) {
    try {
      const stats = fs.statSync(path.join(BACKUPS_DIR, file));
      latest = Math.max(latest, stats.mtimeMs, stats.ctimeMs ?? 0);
    } catch (error) {
      log(`⚠️ Não foi possível ler data do backup ${file}: ${error.message}`);
    }
  }
  return latest;
}

async function ensureAutomaticBackup() {
  const metadata = readMaintenanceMetadata();
  const recorded = metadata.lastAutomaticBackup
    ? new Date(metadata.lastAutomaticBackup).getTime()
    : 0;
  const latestFile = getLatestBackupTimestamp();
  const lastBackup = Math.max(recorded || 0, latestFile || 0);
  const now = Date.now();

  if (lastBackup && now - lastBackup < THREE_DAYS_MS) {
    return null;
  }

  log('🗂️ Executando backup automático programado...');
  const filePath = await backupDatabase();
  if (filePath) {
    metadata.lastAutomaticBackup = new Date().toISOString();
    writeMaintenanceMetadata(metadata);
    maintenanceState.lastAutomaticBackup = metadata.lastAutomaticBackup;
  }
  return filePath;
}

function scheduleAutomaticBackups() {
  if (maintenanceState.initialized) {
    return;
  }
  maintenanceState.initialized = true;

  ensureDirectory(path.dirname(MAINTENANCE_STATE_FILE));
  const metadata = readMaintenanceMetadata();
  if (metadata.lastAutomaticBackup) {
    maintenanceState.lastAutomaticBackup = metadata.lastAutomaticBackup;
  }

  const run = () => {
    ensureAutomaticBackup().catch((error) => {
      log(`⚠️ Backup automático falhou: ${error.message}`);
    });
  };

  // Executa verificação logo no início, mas sem bloquear a inicialização.
  setTimeout(run, 5_000);

  maintenanceState.backupTimer = setInterval(run, BACKUP_CHECK_INTERVAL_MS);
}

function queueAutomaticBackup({ reason = 'alteração' } = {}) {
  const label = typeof reason === 'string' && reason.trim() ? reason.trim() : 'alteração';
  scheduledBackupReason = label;

  const scheduleRun = () => {
    if (scheduledBackupTimer) {
      clearTimeout(scheduledBackupTimer);
    }
    scheduledBackupTimer = setTimeout(async () => {
      scheduledBackupTimer = null;
      try {
        log(`🗂️ Gerando backup automático (${scheduledBackupReason}).`);
        const filePath = await backupDatabase();
        if (scheduledBackupResolve) {
          scheduledBackupResolve(filePath);
        }
      } catch (error) {
        if (scheduledBackupReject) {
          scheduledBackupReject(error);
        }
      } finally {
        scheduledBackupPromise = null;
        scheduledBackupResolve = null;
        scheduledBackupReject = null;
      }
    }, IMMEDIATE_BACKUP_DEBOUNCE_MS);
  };

  if (scheduledBackupPromise) {
    scheduleRun();
    return scheduledBackupPromise;
  }

  scheduledBackupPromise = new Promise((resolve, reject) => {
    scheduledBackupResolve = resolve;
    scheduledBackupReject = (error) => {
      log(`⚠️ Backup automático (${scheduledBackupReason}) falhou: ${error.message}`);
      reject(error);
    };
  });

  scheduleRun();

  return scheduledBackupPromise;
}

const BACKUP_EVENT_TYPES = new Set(['profile.insert', 'profile.update', 'profile.remove']);
if (typeof db.on === 'function') {
  db.on('change', (event) => {
    if (!event || !event.type || !BACKUP_EVENT_TYPES.has(event.type)) {
      return;
    }

    const detail = event.username ? `${event.type}:${event.username}` : event.type;
    queueAutomaticBackup({ reason: detail });
  });
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

  const token = resolveApiToken(options.apiToken);
  if (!token) {
    log('[Rep4Rep] Token da API não configurado. Defina REP4REP_KEY no .env.');
    return { removed: false, error: new Error('Token Rep4Rep ausente.') };
  }

  try {
    await api.removeSteamProfile(steamId, { token });
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

  const token = resolveApiToken(apiToken);
  if (!token) {
    log('[Rep4Rep] Token da API não configurado. Pulando remoção remota.');
    return { attempted: steamIds.length, removed: 0, error: new Error('Token Rep4Rep ausente.') };
  }

  let removed = 0;
  for (const steamId of steamIds) {
    try {
      await apiClient.removeSteamProfile(steamId, { token });
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

  const apiToken = resolveApiToken(options.apiToken);
  if (!apiToken) {
    log('⚠️ Token Rep4Rep não configurado. Defina REP4REP_KEY no .env para adicionar perfis.');
    return { added: 0, total: selectedAccounts.length, error: new Error('Token Rep4Rep ausente.') };
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
          await api.addSteamProfile(steamId, { token: apiToken });
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
  const apiToken = resolveApiToken(options.apiToken);

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

  const token = resolveApiToken(apiToken);
  if (!token) {
    log('⚠️ Token Rep4Rep não configurado. Configure REP4REP_KEY para executar o autoRun.', true);
    return { totalComments: 0, perAccount: [] };
  }

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
    remoteProfiles = await apiClient.getSteamProfiles({ token });
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
        await apiClient.addSteamProfile(profile.steamId, { token });
        remoteProfiles = await apiClient.getSteamProfiles({ token });
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
        apiToken: token,
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


async function failQueuedJob(job, client, reason, logMessage) {
  const message = reason || 'Falha ao processar pedido.';
  if (logMessage) {
    log(logMessage);
  }

  let failedJob = null;
  if (job?.id) {
    try {
      failedJob = await runQueue.failJob(job.id, message);
    } catch (failError) {
      log(`⚠️ Falha ao marcar pedido ${job.id} como falho: ${failError.message}`);
    }
  }

  if (failedJob) {
    try {
      await announceQueueEvent({ type: 'job.failed', job: failedJob, client, error: message });
    } catch (notifyError) {
      log(`⚠️ Falha ao notificar erro via webhook: ${notifyError.message}`);
    }
  }

  return { status: 'failed', client: client || null, queueJob: failedJob, error: message };
}

async function prioritizedAutoRun(options = {}) {
  const {
    ownerToken: ownerTokenOption = null,
    ownerWebhookUrl = null,
    ownerUser = null,
    maxCommentsPerAccount = MAX_COMMENTS_PER_RUN,
    accountLimit = 100,
    clientFilter,
    onClientProcessed,
    ...runOverrides
  } = options;

  const ownerToken = resolveApiToken(ownerTokenOption);

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
      try {
        await announceQueueEvent({
          type: 'owner.completed',
          summary,
          webhookUrl: ownerWebhookUrl,
          client: ownerUser,
        });
      } catch (notifyError) {
        log(`⚠️ Falha ao notificar lote prioritário: ${notifyError.message}`);
      }
      if (summary.totalComments > 0) {
        log('Pedidos do proprietário atendidos. Continuando com a fila de clientes.');
      }
    } catch (error) {
      log(`❌ Falha ao executar autoRun prioritário: ${error.message}`);
    }
  } else {
    log('⚠️ Nenhum token do proprietário configurado. Pulando etapa prioritária.');
  }

  let completedJobs = 0;

  const processJob = async (job) => {
    const client = job.user || (await userStore.getUser(job.userId));
    if (!client) {
      return failQueuedJob(
        job,
        null,
        'Usuário não encontrado.',
        `❌ Pedido ${job.id} removido da fila: usuário inexistente.`,
      );
    }

    const clientLabel = formatClientLabel(client);

    if (typeof clientFilter === 'function' && !clientFilter(client)) {
      return failQueuedJob(
        job,
        client,
        'Pedido bloqueado pelo filtro do operador.',
        `⚠️ Pedido ${job.id} ignorado (filtro do operador).`,
      );
    }

    if (client.status !== 'active') {
      return failQueuedJob(
        job,
        client,
        'Conta inativa ou bloqueada.',
        `⚠️ ${clientLabel} ignorado: conta não está ativa.`,
      );
    }

    const clientToken = resolveApiToken(client.rep4repKey, {
      fallbackToEnv: client.role === 'admin',
    });

    const clientToken = resolveApiToken(client.rep4repKey, { fallbackToEnv: false });
    if (!clientToken) {
      return failQueuedJob(
        job,
        client,
        'Chave Rep4Rep não configurada.',
        `⚠️ ${clientLabel} ignorado: key Rep4Rep ausente.`,
      );
    }

    const isAdmin = client.role === 'admin';
    const creditLimit = isAdmin ? Infinity : Number(client.credits) || 0;
    if (!isAdmin && creditLimit <= 0) {
      return failQueuedJob(
        job,
        client,
        'Créditos insuficientes.',
        `⚠️ ${clientLabel} sem créditos suficientes. Pedido removido.`,
      );
    }

    const jobMaxComments = Math.min(1000, Math.max(1, job.maxCommentsPerAccount || maxComments));
    const jobAccountLimit = Math.min(100, Math.max(1, job.accountLimit || accountLimit));

    let usedCredits = 0;
    const upstreamTaskHandler = baseRunOptions.onTaskComplete;
    const onTaskComplete = async (payload) => {
      if (typeof upstreamTaskHandler === 'function') {
        try {
          const upstreamResult = await upstreamTaskHandler(payload);
          if (upstreamResult === false) {
            return false;
          }
        } catch (callbackError) {
          log(`⚠️ onTaskComplete custom handler falhou: ${callbackError.message}`);
        }
      }

      if (isAdmin) {
        return true;
      }

      usedCredits += 1;
      return usedCredits < creditLimit;
    };

    log(
      `🧾 Processando pedido da fila (${clientLabel}) (máx ${jobAccountLimit} contas / ${jobMaxComments} comentários).`,
    );

    try {
      const summary = await autoRun({
        ...baseRunOptions,
        apiToken: clientToken,
        maxCommentsPerAccount: jobMaxComments,
        accountLimit: jobAccountLimit,
        onTaskComplete,
      });

      const totalComments = summary?.totalComments ?? 0;
      const consumed = isAdmin ? 0 : Math.min(creditLimit, usedCredits, totalComments);

      let updatedUser = null;
      if (!isAdmin && consumed > 0) {
        try {
          updatedUser = await userStore.consumeCredits(client.id, consumed);
          if (updatedUser?.credits != null) {
            client.credits = updatedUser.credits;
          }
        } catch (creditError) {
          log(`⚠️ Falha ao debitar créditos de ${clientLabel}: ${creditError.message}`);
        }
      }

      if (!isAdmin) {
        const remaining =
          updatedUser?.credits ??
          (Number.isFinite(creditLimit) ? Math.max(0, creditLimit - consumed) : 0);
        log(`[${clientLabel}] Créditos debitados: ${consumed}. Restantes: ${remaining}.`);
      }

      const cleanup = await removeRemoteProfiles(summary, {
        apiToken: clientToken,
        apiClient: baseRunOptions.apiClient || api,
      });

      const completedJob = await runQueue.completeJob(job.id, {
        summary,
        cleanup,
        creditsConsumed: consumed,
        totalComments,
      });

      const clientResult = {
        client,
        summary,
        creditsConsumed: consumed,
        cleanup,
        queueJob: completedJob,
        status: 'completed',
      };

      try {
        await announceQueueEvent({
          type: 'job.completed',
          job: completedJob,
          client,
          summary,
          creditsConsumed: consumed,
        });
      } catch (notifyError) {
        log(`⚠️ Falha ao notificar conclusão via webhook: ${notifyError.message}`);
      }

      if (typeof onClientProcessed === 'function') {
        try {
          await onClientProcessed(clientResult);
        } catch (callbackError) {
          log(`⚠️ onClientProcessed falhou: ${callbackError.message}`);
        }
      }

      if (totalComments > 0) {
        log(`✅ Execução concluída para ${clientLabel}.`);
      } else {
        log(`ℹ️ Nenhum comentário pendente para ${clientLabel}.`);
      }

      return clientResult;
    } catch (error) {
      const message = error?.message || 'Falha ao processar cliente.';
      return failQueuedJob(job, client, message, `❌ Falha ao processar ${clientLabel}: ${message}`);
    }
  };

  while (true) {
    let job;
    try {
      job = await runQueue.takeNextPendingJob();
    } catch (error) {
      log(`❌ Falha ao obter próxima ordem da fila: ${error.message}`);
      break;
    }

    if (!job) {
      break;
    }

    const outcome = await processJob(job);
    if (!outcome) {
      continue;
    }

    result.clients.push(outcome);
    if (outcome.status === 'completed') {
      completedJobs += 1;
    }
  }

  if (completedJobs === 0) {
    log('Nenhuma ordem na fila de clientes neste ciclo.');
  }

  try {
    await runQueue.clearCompleted({ maxEntries: 200 });
  } catch (cleanupError) {
    log(`⚠️ Falha ao limpar histórico da fila: ${cleanupError.message}`);
  }

  if (!result.clients.length) {
    log('Nenhum cliente elegível para processamento neste ciclo.');
  }

  return result;
}


async function waitWithAbort(totalMs, state = keepAliveState) {
  let remaining = Math.max(0, Number(totalMs) || 0);
  const step = Math.min(60_000, Math.max(1_000, remaining));
  while (!state.stopRequested && remaining > 0) {
    const chunk = Math.min(step, remaining);
    await sleep(chunk);
    remaining -= chunk;
  }
}

async function startKeepAliveLoop(options = {}) {
  if (keepAliveState.running) {
    return { alreadyRunning: true, status: getKeepAliveStatus() };
  }

  const intervalMinutes = Math.max(
    5,
    sanitizePositiveInteger(options.intervalMinutes, KEEPALIVE_INTERVAL_MINUTES),
  );
  keepAliveState.intervalMs = intervalMinutes * 60 * 1000;
  keepAliveState.stopRequested = false;
  keepAliveState.running = true;
  keepAliveState.startedAt = new Date().toISOString();
  keepAliveState.lastError = null;
  keepAliveState.runs = 0;
  keepAliveState.ownerToken = resolveApiToken(options.ownerToken ?? keepAliveState.ownerToken);

  const runOptions = {
    accountLimit: 100,
    maxCommentsPerAccount: MAX_COMMENTS_PER_RUN,
    ...options.runOptions,
  };

  if (runOptions.ownerToken !== undefined) {
    runOptions.ownerToken = resolveApiToken(runOptions.ownerToken);
  }

  if (options.ownerWebhookUrl && !runOptions.ownerWebhookUrl) {
    runOptions.ownerWebhookUrl = options.ownerWebhookUrl;
  }
  if (options.ownerUser && !runOptions.ownerUser) {
    runOptions.ownerUser = options.ownerUser;
  }

  keepAliveState.ownerWebhookUrl = runOptions.ownerWebhookUrl || null;

  const loop = async () => {
    while (!keepAliveState.stopRequested) {
      try {
        const summary = await prioritizedAutoRun({
          ...runOptions,
          ownerToken: resolveApiToken(keepAliveState.ownerToken ?? runOptions.ownerToken),
        });
        keepAliveState.lastRunAt = new Date().toISOString();
        keepAliveState.runs += 1;
        keepAliveState.lastError = null;
        const ownerComments = summary?.owner?.totalComments ?? 0;
        const clientTotals = Array.isArray(summary?.clients)
          ? summary.clients.reduce((acc, item) => acc + (item?.summary?.totalComments ?? 0), 0)
          : 0;
        keepAliveState.lastSummary = {
          ownerComments,
          clientComments: clientTotals,
          processedClients: Array.isArray(summary?.clients) ? summary.clients.length : 0,
          totalComments: ownerComments + clientTotals,
          timestamp: keepAliveState.lastRunAt,
        };
      } catch (error) {
        keepAliveState.lastRunAt = new Date().toISOString();
        keepAliveState.lastError = error.message;
        log(`⚠️ Vigia automático falhou: ${error.message}`);
      }

      if (keepAliveState.stopRequested) {
        break;
      }

      await waitWithAbort(keepAliveState.intervalMs);
    }

    keepAliveState.running = false;
    keepAliveState.promise = null;
  };

  keepAliveState.promise = loop();
  return { started: true, status: getKeepAliveStatus() };
}

async function stopKeepAliveLoop() {
  if (!keepAliveState.running) {
    return { stopped: false, status: getKeepAliveStatus() };
  }

  keepAliveState.stopRequested = true;
  if (keepAliveState.promise) {
    try {
      await keepAliveState.promise;
    } catch (error) {
      log(`⚠️ Erro ao encerrar vigia: ${error.message}`);
    }
  }

  keepAliveState.running = false;
  keepAliveState.promise = null;
  return { stopped: true, status: getKeepAliveStatus() };
}

function getKeepAliveStatus() {
  return {
    running: keepAliveState.running,
    intervalMinutes: Math.round((keepAliveState.intervalMs / 60_000) * 10) / 10,
    startedAt: keepAliveState.startedAt,
    lastRunAt: keepAliveState.lastRunAt,
    runs: keepAliveState.runs,
    lastError: keepAliveState.lastError,
    ownerTokenDefined: Boolean(resolveApiToken(keepAliveState.ownerToken)),
    ownerWebhookDefined: Boolean(keepAliveState.ownerWebhookUrl),
  };
}

async function keepBotAliveInteractive(options = {}) {
  const { alreadyRunning } = await startKeepAliveLoop(options);
  if (alreadyRunning) {
    log('⚠️ O modo vigia já está ativo em segundo plano.');
    return getKeepAliveStatus();
  }

  log(
    `🛡️ Modo vigia ativo. Executando prioridade a cada ${Math.round(
      keepAliveState.intervalMs / 60_000,
    )} minuto(s). Pressione Ctrl+C para encerrar.`,
  );

  return new Promise((resolve) => {
    const finish = async () => {
      log('⏹️ Encerrando modo vigia. Aguardando ciclo atual...');
      await stopKeepAliveLoop();
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      log('✅ Modo vigia encerrado.');
      resolve(getKeepAliveStatus());
    };

    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

async function checkAndSyncProfiles(options = {}) {
  const { apiClient = api, apiToken = null } = options;
  const profiles = await db.getAllProfiles();
  if (!profiles.length) {
    log('Nenhum perfil cadastrado.');
    return;
  }

  const token = resolveApiToken(apiToken);
  if (!token) {
    log('⚠️ Token Rep4Rep não configurado. Configure REP4REP_KEY antes de sincronizar perfis.');
    return;
  }

  let remoteProfiles;
  try {
    remoteProfiles = await apiClient.getSteamProfiles({ token });
  } catch (error) {
    log(`[API] Falha ao obter perfis: ${describeApiError(error)}`);
    return;
  }

  const remoteMap = new Map(remoteProfiles.map((item) => [String(item.steamId), item]));

  for (const profile of profiles) {
    if (!remoteMap.has(String(profile.steamId))) {
      log(`[${profile.username}] não encontrado no Rep4Rep. Tentando sincronizar.`);
      try {
        await apiClient.addSteamProfile(profile.steamId, { token });
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

async function showQueueSnapshot() {
  log('📬 Status da fila de execuções:');
  try {
    const snapshot = await runQueue.getQueueSnapshot();
    const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
    log(`Pedidos pendentes: ${jobs.length}`);

    if (jobs.length) {
      const rows = [
        ['Posição', 'Cliente', 'Status', 'Enfileirado', 'Limites', 'Comentários'],
      ];

      for (const job of jobs) {
        rows.push([
          job.position != null ? String(job.position) : '—',
          formatClientLabel(job.user),
          job.status || 'pending',
          job.enqueuedAt ? new Date(job.enqueuedAt).toLocaleString() : '—',
          buildLimitLabel(job),
          String(job.totalComments ?? 0),
        ]);
      }

      console.log(table(rows));
    } else {
      log('Nenhum pedido aguardando processamento.');
    }

    const averageMs = Number(snapshot?.averageDurationMs) || 0;
    if (averageMs > 0) {
      const minutes = Math.round(averageMs / 60000);
      log(`⏱️ Duração média estimada dos últimos ciclos: ${minutes} minuto(s).`);
    }

    const history = Array.isArray(snapshot?.history) ? snapshot.history : [];
    if (history.length) {
      log('🕑 Histórico recente:');
      history.forEach((item) => {
        const finishedAt = item.finishedAt ? new Date(item.finishedAt).toLocaleString() : '—';
        const status = item.status || 'desconhecido';
        log(`- ${formatClientLabel(item.user)} · ${status} · ${finishedAt}`);
      });
    }

    return snapshot;
  } catch (error) {
    log(`❌ Falha ao obter fila: ${error.message}`);
    return null;
  }
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
    await db.checkpoint('FULL');
    try {
      await db.vacuumInto(dest);
    } catch (vacuumError) {
      log(`⚠️ VACUUM INTO falhou (${vacuumError.message}). Tentando cópia direta...`);
      try {
        fs.rmSync(dest, { force: true });
      } catch (rmError) {
        // Ignora falhas ao remover arquivo parcialmente gerado
      }
      fs.copyFileSync(src, dest);
    }
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
  showQueueSnapshot,
  collectUsageStats,
  resetProfileCookies,
  backupDatabase,
  queueAutomaticBackup,
  scheduleAutomaticBackups,
  startKeepAliveLoop,
  stopKeepAliveLoop,
  getKeepAliveStatus,
  keepBotAliveInteractive,
  describeApiError,
  readAccountsFile,
  parseStoredCookies,
  closeReadline,
  announceQueueEvent,
  getEnvRep4RepKey,
  resolveApiToken,
};
