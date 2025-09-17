const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(USERS_FILE);
  } catch (error) {
    const now = new Date().toISOString();
    const seed = [
      {
        id: 'demo-user',
        displayName: 'Cliente Demo',
        email: 'demo@example.com',
        rep4repKey: '',
        credits: 10,
        status: 'active',
        role: 'customer',
        notes: 'Exemplo de usuário. Pode ser removido com segurança.',
        createdAt: now,
        updatedAt: now,
      },
    ];
    await fs.writeFile(USERS_FILE, JSON.stringify(seed, null, 2), 'utf8');
  }
}

async function readUsers() {
  await ensureDataFile();
  const raw = await fs.readFile(USERS_FILE, 'utf8');
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('[UserStore] Falha ao interpretar users.json. Recriando arquivo...', error);
    await fs.writeFile(USERS_FILE, '[]', 'utf8');
    return [];
  }
}

async function writeUsers(users) {
  await ensureDataFile();
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function normalizeCredits(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.round(num));
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

async function listUsers() {
  const users = await readUsers();
  return users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getUser(id) {
  const users = await readUsers();
  return users.find((user) => user.id === id) || null;
}

async function createUser({ displayName, email, rep4repKey = '', credits = 0, notes = '' }) {
  const name = normalizeString(displayName);
  const mail = normalizeString(email);
  if (!name) {
    throw new Error('Informe um nome para o usuário.');
  }
  if (!mail) {
    throw new Error('Informe um email válido.');
  }

  const users = await readUsers();
  if (users.some((user) => user.email.toLowerCase() === mail.toLowerCase())) {
    throw new Error('Já existe um usuário com este email.');
  }

  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    displayName: name,
    email: mail,
    rep4repKey: normalizeString(rep4repKey),
    credits: normalizeCredits(credits),
    status: 'active',
    role: 'customer',
    notes: normalizeString(notes),
    createdAt: now,
    updatedAt: now,
  };

  users.push(user);
  await writeUsers(users);
  return user;
}

async function updateUser(id, updates = {}) {
  const users = await readUsers();
  const index = users.findIndex((user) => user.id === id);
  if (index === -1) {
    throw new Error('Usuário não encontrado.');
  }

  const current = users[index];
  const next = { ...current };

  if (updates.displayName !== undefined) {
    const value = normalizeString(updates.displayName);
    if (!value) {
      throw new Error('O nome não pode ficar vazio.');
    }
    next.displayName = value;
  }

  if (updates.email !== undefined) {
    const value = normalizeString(updates.email);
    if (!value) {
      throw new Error('Informe um email válido.');
    }
    const duplicate = users.some((user, idx) => idx !== index && user.email.toLowerCase() === value.toLowerCase());
    if (duplicate) {
      throw new Error('Já existe um usuário com este email.');
    }
    next.email = value;
  }

  if (updates.rep4repKey !== undefined) {
    next.rep4repKey = normalizeString(updates.rep4repKey);
  }

  if (updates.status !== undefined) {
    const allowed = ['active', 'blocked', 'pending'];
    if (!allowed.includes(updates.status)) {
      throw new Error('Status inválido.');
    }
    next.status = updates.status;
  }

  if (updates.role !== undefined) {
    next.role = normalizeString(updates.role) || current.role;
  }

  if (updates.notes !== undefined) {
    next.notes = normalizeString(updates.notes);
  }

  if (updates.credits !== undefined) {
    next.credits = normalizeCredits(updates.credits);
  }

  next.updatedAt = new Date().toISOString();

  users[index] = next;
  await writeUsers(users);
  return next;
}

async function adjustCredits(id, delta) {
  const users = await readUsers();
  const index = users.findIndex((user) => user.id === id);
  if (index === -1) {
    throw new Error('Usuário não encontrado.');
  }

  const current = users[index];
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('Informe um valor numérico para ajustar créditos.');
  }

  const credits = normalizeCredits(current.credits + amount);
  const updated = { ...current, credits, updatedAt: new Date().toISOString() };
  users[index] = updated;
  await writeUsers(users);
  return updated;
}

module.exports = {
  ensureDataFile,
  listUsers,
  getUser,
  createUser,
  updateUser,
  adjustCredits,
};
