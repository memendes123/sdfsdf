const fs = require('fs/promises');
const path = require('path');
const { randomUUID, randomBytes, pbkdf2, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const { URL } = require('url');

const db = require('../../src/db.cjs');

const pbkdf2Async = promisify(pbkdf2);

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LEGACY_FILE = path.join(DATA_DIR, 'users.json');

const PASSWORD_ITERATIONS = 120_000;
const PASSWORD_KEYLEN = 64;
const PASSWORD_DIGEST = 'sha512';

function generateApiToken() {
  return randomUUID().replace(/-/g, '');
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(email) {
  const value = normalizeString(email).toLowerCase();
  if (!value) {
    throw new Error('Informe um email.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error('Email inválido.');
  }
  return value;
}

function normalizeDate(value) {
  const text = normalizeString(value);
  if (!text) {
    throw new Error('Informe a data de nascimento.');
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Data de nascimento inválida.');
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizePhone(value) {
  const text = normalizeString(value).replace(/[^+\d]/g, '');
  if (!text || text.length < 8) {
    throw new Error('Informe um telefone/WhatsApp válido com DDI.');
  }
  if (!text.startsWith('+')) {
    return `+${text}`;
  }
  return text;
}

function normalizeDiscordWebhookUrl(value) {
  const text = normalizeString(value);
  if (!text) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new Error('Informe uma URL válida para o webhook do Discord.');
  }

  const normalized = parsed.toString();
  const allowedPattern = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//i;
  if (!allowedPattern.test(normalized)) {
    throw new Error('O webhook deve começar com https://discord.com/api/webhooks/.');
  }

  return normalized;
}

function requireString(value, message) {
  const text = normalizeString(value);
  if (!text) {
    throw new Error(message);
  }
  return text;
}

async function hashPassword(password) {
  const pwd = normalizeString(password);
  if (!pwd) {
    throw new Error('Informe uma senha.');
  }
  if (pwd.length < 8) {
    throw new Error('A senha deve ter pelo menos 8 caracteres.');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = await pbkdf2Async(pwd, salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST);
  return { salt, hash: hash.toString('hex') };
}

async function verifyPassword(password, storedHash, storedSalt) {
  if (!storedHash || !storedSalt) {
    return false;
  }

  const derived = await pbkdf2Async(
    normalizeString(password),
    storedSalt,
    PASSWORD_ITERATIONS,
    PASSWORD_KEYLEN,
    PASSWORD_DIGEST,
  );
  const derivedHex = derived.toString('hex');
  return (
    derivedHex.length === storedHash.length &&
    timingSafeEqual(Buffer.from(derivedHex, 'hex'), Buffer.from(storedHash, 'hex'))
  );
}

function sanitizeUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    displayName: row.fullName,
    email: row.email,
    dateOfBirth: row.dateOfBirth,
    discordId: row.discordId,
    rep4repId: row.rep4repId,
    rep4repKey: row.rep4repKey,
    discordWebhookUrl: row.discordWebhookUrl,
    phoneNumber: row.phoneNumber,
    credits: row.credits,
    role: row.role,
    status: row.status,
    apiToken: row.apiToken,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function migrateLegacyFile(connection) {
  try {
    await fs.access(LEGACY_FILE);
  } catch (error) {
    return;
  }

  try {
    const raw = await fs.readFile(LEGACY_FILE, 'utf8');
    const legacyUsers = JSON.parse(raw);
    if (!Array.isArray(legacyUsers) || legacyUsers.length === 0) {
      return;
    }

    console.log('[UserStore] Migrando usuários legacy do arquivo users.json...');
    for (const legacy of legacyUsers) {
      try {
        const now = new Date().toISOString();
        const username = normalizeString(legacy.username) || `cliente_${Math.random().toString(36).slice(2, 8)}`;
        const fullName = normalizeString(legacy.displayName || legacy.name || username) || 'Cliente importado';
        const email = normalizeEmail(legacy.email || `${username}@example.com`);
        const discordId = normalizeString(legacy.discordId || `${username}#0000`);
        const rep4repId = normalizeString(legacy.rep4repId || `legacy-${Math.random().toString(36).slice(2, 10)}`);
        const phoneNumber = normalizePhone(legacy.phoneNumber || '+550000000000');
        const { hash, salt } = await hashPassword(legacy.password || 'Alterar123');
        const apiToken = generateApiToken();
        const credits = Number.isFinite(legacy.credits) ? Math.max(0, Math.round(legacy.credits)) : 0;

        await connection.run(
          `INSERT OR IGNORE INTO app_user (
            id, username, fullName, email, passwordHash, passwordSalt, dateOfBirth,
            discordId, rep4repId, rep4repKey, phoneNumber, credits, apiToken, role, status,
            createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            username,
            fullName,
            email,
            hash,
            salt,
            '1990-01-01',
            discordId,
            rep4repId,
            normalizeString(legacy.rep4repKey || ''),
            phoneNumber,
            credits,
            apiToken,
            'customer',
            normalizeString(legacy.status) || 'pending',
            now,
            now,
          ],
        );
      } catch (userError) {
        console.error('[UserStore] Falha ao migrar usuário legacy:', userError.message);
      }
    }

    console.log('[UserStore] Migração concluída. Mantendo arquivo users.json para referência.');
  } catch (error) {
    console.error('[UserStore] Não foi possível migrar users.json:', error);
  }
}

let ensurePromise = null;

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const connection = await db.getConnection();
      await migrateLegacyFile(connection);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

async function listUsers() {
  await ensureDataFile();
  const connection = await db.getConnection();
  const rows = await connection.all(`SELECT * FROM app_user ORDER BY datetime(createdAt) DESC`);
  return rows.map(sanitizeUser);
}

async function getUser(id) {
  if (!id) return null;
  await ensureDataFile();
  const connection = await db.getConnection();
  const row = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [id]);
  return sanitizeUser(row);
}

async function getUserByEmail(email) {
  const value = normalizeEmail(email);
  await ensureDataFile();
  const connection = await db.getConnection();
  const row = await connection.get(`SELECT * FROM app_user WHERE lower(email) = ?`, [value]);
  return row ? sanitizeUser(row) : null;
}

async function getRawUserByEmail(email) {
  const value = normalizeEmail(email);
  await ensureDataFile();
  const connection = await db.getConnection();
  return connection.get(`SELECT * FROM app_user WHERE lower(email) = ?`, [value]);
}

async function getRawUserByUsername(username) {
  const value = normalizeString(username).toLowerCase();
  if (!value) return null;
  await ensureDataFile();
  const connection = await db.getConnection();
  return connection.get(`SELECT * FROM app_user WHERE lower(username) = ?`, [value]);
}

async function assertUniqueFields({ email, username, discordId, rep4repId }, { ignoreId } = {}) {
  const connection = await db.getConnection();
  const clauses = [];
  const params = [];

  if (email) {
    clauses.push('lower(email) = ?');
    params.push(email.toLowerCase());
  }
  if (username) {
    clauses.push('lower(username) = ?');
    params.push(username.toLowerCase());
  }
  if (discordId) {
    clauses.push('discordId = ?');
    params.push(discordId);
  }
  if (rep4repId) {
    clauses.push('lower(rep4repId) = ?');
    params.push(rep4repId.toLowerCase());
  }

  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    const param = params[i];
    const existing = await connection.get(
      `SELECT id, email, username, discordId, rep4repId FROM app_user WHERE ${clause}`,
      [param],
    );
    if (existing && (!ignoreId || existing.id !== ignoreId)) {
      if (clause.includes('email')) {
        throw new Error('Já existe um usuário com este email.');
      }
      if (clause.includes('username')) {
        throw new Error('Já existe um usuário com este username.');
      }
      if (clause.includes('discordId')) {
        throw new Error('Já existe um usuário com este Discord ID.');
      }
      if (clause.includes('rep4repId')) {
        throw new Error('Já existe um usuário com este Rep4Rep ID.');
      }
    }
  }
}

async function createUserRecord(data, { defaultStatus = 'pending', allowRoleOverride = true } = {}) {

  await ensureDataFile();

  const username = requireString(data.username, 'Informe um username.');
  const fullName = requireString(data.fullName || data.displayName, 'Informe o nome completo.');
  const email = normalizeEmail(data.email);
  const password = requireString(data.password, 'Informe uma senha.');
  const dateOfBirth = normalizeDate(data.dateOfBirth);
  const discordId = requireString(data.discordId, 'Informe o Discord ID.');
  const rep4repId = requireString(data.rep4repId, 'Informe o Rep4Rep ID.');
  const phoneNumber = normalizePhone(data.phoneNumber || data.whatsapp || data.phone);
  const rep4repKey = normalizeString(data.rep4repKey || '');
  const credits = Number.isFinite(Number(data.credits)) ? Math.max(0, Math.round(Number(data.credits))) : 0;
  const discordWebhookUrl = normalizeDiscordWebhookUrl(
    data.discordWebhookUrl || data.webhookUrl || data.webhook || data.discordWebhook,
  );
  const requestedRole = normalizeString(data.role);
  const roleCandidates = new Set(['customer', 'admin']);
  const role = allowRoleOverride && requestedRole && roleCandidates.has(requestedRole)
    ? requestedRole
    : 'customer';
  const status = normalizeString(data.status) || defaultStatus || 'pending';

  await assertUniqueFields(
    { email, username, discordId, rep4repId },
    data.ignoreId ? { ignoreId: data.ignoreId } : undefined,
  );

  const { hash, salt } = await hashPassword(password);
  const connection = await db.getConnection();
  const now = new Date().toISOString();
  const id = randomUUID();
  const apiToken = generateApiToken();

  await connection.run(
    `INSERT INTO app_user (
      id, username, fullName, email, passwordHash, passwordSalt,
      dateOfBirth, discordId, rep4repId, rep4repKey, discordWebhookUrl, phoneNumber, credits,
      apiToken, role, status, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      username,
      fullName,
      email,
      hash,
      salt,
      dateOfBirth,
      discordId,
      rep4repId,
      rep4repKey,
      discordWebhookUrl,
      phoneNumber,
      credits,
      apiToken,
      role,
      status,
      now,
      now,
    ],
  );

  const row = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [id]);
  return sanitizeUser(row);
}

async function createUser(data = {}) {
  return createUserRecord(
    { ...data, status: data.status || 'active' },
    { defaultStatus: 'active', allowRoleOverride: true },
  );
}

async function registerUser(data = {}) {
  return createUserRecord(
    { ...data, credits: 0, status: 'pending', role: 'customer' },
    { defaultStatus: 'pending', allowRoleOverride: false },
  );
}

async function updateUser(id, updates = {}) {
  await ensureDataFile();
  const connection = await db.getConnection();
  const current = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [id]);
  if (!current) {
    throw new Error('Usuário não encontrado.');
  }

  const next = { ...current };

  if (updates.fullName !== undefined || updates.displayName !== undefined) {
    next.fullName = requireString(updates.fullName || updates.displayName, 'Nome não pode ficar vazio.');
  }
  if (updates.email !== undefined) {
    next.email = normalizeEmail(updates.email);
  }
  if (updates.username !== undefined) {
    next.username = requireString(updates.username, 'Username não pode ficar vazio.');
  }
  if (updates.discordId !== undefined) {
    next.discordId = requireString(updates.discordId, 'Discord ID não pode ficar vazio.');
  }
  if (updates.rep4repId !== undefined) {
    next.rep4repId = requireString(updates.rep4repId, 'Rep4Rep ID não pode ficar vazio.');
  }
  if (updates.rep4repKey !== undefined) {
    next.rep4repKey = normalizeString(updates.rep4repKey);
  }
  if (updates.discordWebhookUrl !== undefined) {
    next.discordWebhookUrl = normalizeDiscordWebhookUrl(updates.discordWebhookUrl);
  }
  if (updates.dateOfBirth !== undefined) {
    next.dateOfBirth = normalizeDate(updates.dateOfBirth);
  }
  if (updates.phoneNumber !== undefined || updates.whatsapp !== undefined) {
    next.phoneNumber = normalizePhone(updates.phoneNumber || updates.whatsapp);
  }
  if (updates.status !== undefined) {
    const value = normalizeString(updates.status);
    if (!['active', 'blocked', 'pending'].includes(value)) {
      throw new Error('Status inválido.');
    }
    next.status = value;
  }
  if (updates.role !== undefined) {
    const value = normalizeString(updates.role);
    if (value && !['customer', 'admin'].includes(value)) {
      throw new Error('Nível de acesso inválido.');
    }
    next.role = value || current.role;
  }
  if (updates.credits !== undefined) {
    const creditsValue = Number(updates.credits);
    if (!Number.isFinite(creditsValue) || creditsValue < 0) {
      throw new Error('Créditos inválidos.');
    }
    next.credits = Math.round(creditsValue);
  }
  if (updates.password) {
    const { hash, salt } = await hashPassword(updates.password);
    next.passwordHash = hash;
    next.passwordSalt = salt;
  }

  await assertUniqueFields(
    {
      email: next.email,
      username: next.username,
      discordId: next.discordId,
      rep4repId: next.rep4repId,
    },
    { ignoreId: id },
  );

  next.updatedAt = new Date().toISOString();

  await connection.run(
    `UPDATE app_user SET
      username = ?,
      fullName = ?,
      email = ?,
      passwordHash = ?,
      passwordSalt = ?,
      dateOfBirth = ?,
      discordId = ?,
      rep4repId = ?,
      rep4repKey = ?,
      discordWebhookUrl = ?,
      phoneNumber = ?,
      credits = ?,
      role = ?,
      status = ?,
      updatedAt = ?
    WHERE id = ?`,
    [
      next.username,
      next.fullName,
      next.email,
      next.passwordHash,
      next.passwordSalt,
      next.dateOfBirth,
      next.discordId,
      next.rep4repId,
      next.rep4repKey,
      next.discordWebhookUrl,
      next.phoneNumber,
      next.credits,
      next.role,
      next.status,
      next.updatedAt,
      id,
    ],
  );

  return sanitizeUser(next);
}

async function adjustCredits(id, delta) {
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('Informe um valor numérico para ajustar créditos.');
  }

  await ensureDataFile();
  const connection = await db.getConnection();
  const current = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [id]);
  if (!current) {
    throw new Error('Usuário não encontrado.');
  }

  const newCredits = current.credits + Math.round(amount);
  if (newCredits < 0) {
    throw new Error('Créditos insuficientes para remover.');
  }

  const updatedAt = new Date().toISOString();
  await connection.run(`UPDATE app_user SET credits = ?, updatedAt = ? WHERE id = ?`, [newCredits, updatedAt, id]);
  return sanitizeUser({ ...current, credits: newCredits, updatedAt });
}

async function consumeCredits(id, amount = 1) {
  const qty = Math.max(0, Math.floor(Number(amount)));
  if (qty <= 0) {
    return getUser(id);
  }

  await ensureDataFile();
  const connection = await db.getConnection();
  const current = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [id]);
  if (!current) {
    throw new Error('Usuário não encontrado.');
  }

  if (current.credits < qty) {
    throw new Error('Créditos insuficientes.');
  }

  const updated = {
    ...current,
    credits: current.credits - qty,
    updatedAt: new Date().toISOString(),
  };
  await connection.run(`UPDATE app_user SET credits = ?, updatedAt = ? WHERE id = ?`, [updated.credits, updated.updatedAt, id]);
  return sanitizeUser(updated);
}

async function authenticateUser({ userId, token }) {
  if (!userId || !token) {
    return null;
  }

  await ensureDataFile();
  const connection = await db.getConnection();
  const user = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [userId]);
  if (!user) {
    return null;
  }

  if (user.apiToken !== token) {
    return null;
  }

  if (user.status !== 'active') {
    return null;
  }

  return sanitizeUser(user);
}

async function rotateApiToken(id) {
  await ensureDataFile();
  const connection = await db.getConnection();
  const current = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [id]);
  if (!current) {
    throw new Error('Usuário não encontrado.');
  }

  const apiToken = generateApiToken();
  const updatedAt = new Date().toISOString();
  await connection.run(`UPDATE app_user SET apiToken = ?, updatedAt = ? WHERE id = ?`, [apiToken, updatedAt, id]);
  return sanitizeUser({ ...current, apiToken, updatedAt });
}

async function loginUser({ identifier, password }) {
  const value = normalizeString(identifier);
  if (!value) {
    throw new Error('Informe email ou username para entrar.');
  }

  await ensureDataFile();
  const connection = await db.getConnection();
  const row = await connection.get(
    `SELECT * FROM app_user WHERE lower(email) = ? OR lower(username) = ?`,
    [value.toLowerCase(), value.toLowerCase()],
  );

  if (!row) {
    throw new Error('Credenciais inválidas.');
  }

  const ok = await verifyPassword(password, row.passwordHash, row.passwordSalt);
  if (!ok) {
    throw new Error('Credenciais inválidas.');
  }

  const lastLoginAt = new Date().toISOString();
  await connection.run(`UPDATE app_user SET lastLoginAt = ?, updatedAt = ? WHERE id = ?`, [lastLoginAt, lastLoginAt, row.id]);
  return sanitizeUser({ ...row, lastLoginAt, updatedAt: lastLoginAt });
}

async function updateClientSettings(id, updates = {}) {
  await ensureDataFile();
  const connection = await db.getConnection();
  const current = await connection.get(`SELECT * FROM app_user WHERE id = ?`, [id]);
  if (!current) {
    throw new Error('Usuário não encontrado.');
  }

  const next = { ...current };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(updates, 'rep4repKey')) {
    next.rep4repKey = normalizeString(updates.rep4repKey);
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'discordWebhookUrl')) {
    next.discordWebhookUrl = normalizeDiscordWebhookUrl(updates.discordWebhookUrl);
    changed = true;
  }

  if (!changed) {
    throw new Error('Nada para atualizar.');
  }

  next.updatedAt = new Date().toISOString();

  await connection.run(
    `UPDATE app_user SET rep4repKey = ?, discordWebhookUrl = ?, updatedAt = ? WHERE id = ?`,
    [next.rep4repKey, next.discordWebhookUrl, next.updatedAt, id],
  );

  return sanitizeUser(next);
}

async function updateRep4repKey(id, rep4repKey) {
  return updateClientSettings(id, { rep4repKey });
}

async function findActiveAdmin() {
  await ensureDataFile();
  const connection = await db.getConnection();
  const row = await connection.get(
    `SELECT * FROM app_user WHERE role = 'admin' AND status = 'active' ORDER BY datetime(updatedAt) DESC LIMIT 1`,
  );
  return sanitizeUser(row);
}

module.exports = {
  ensureDataFile,
  listUsers,
  getUser,
  getUserByEmail,
  createUser,
  registerUser,
  updateUser,
  adjustCredits,
  consumeCredits,
  authenticateUser,
  rotateApiToken,
  loginUser,
  updateClientSettings,
  updateRep4repKey,
  findActiveAdmin,
};

