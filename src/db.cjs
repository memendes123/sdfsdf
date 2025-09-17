const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_DB_NAME = 'steamprofiles.db';

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

class DbWrapper extends EventEmitter {
  constructor() {
    super();
    this.db = null;
    this._initPromise = null;
    this.databasePath = null;
    this._resolvedDatabaseEnv = null;
  }

  async init() {
    if (this.db) {
      return this.db;
    }

    if (!this._initPromise) {
      this._initPromise = (async () => {
        const filename = this._resolveDatabasePath();
        const database = await open({
          filename,
          driver: sqlite3.Database,
        });

        await database.exec('PRAGMA journal_mode = WAL');
        this.db = database;
        await this._createProfilesTable();
        await this._createCommentsTable();
        await this._createUsersTable();
        await this._createRunQueueTable();
        console.log(`📦 Banco de dados inicializado em ${this.databasePath}.`);
        return this.db;
      })().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }

    return this._initPromise;
  }

  _resolveDatabasePath() {
    const envPath = (process.env.DATABASE_PATH || '').trim();
    const previousEnv = this._resolvedDatabaseEnv;
    const rootCandidate = path.join(ROOT_DIR, DEFAULT_DB_NAME);

    let resolvedPath = null;

    if (envPath) {
      resolvedPath = path.isAbsolute(envPath)
        ? envPath
        : path.resolve(ROOT_DIR, envPath);
      ensureDirectory(path.dirname(resolvedPath));
    } else {
      const legacyInData = path.join(ROOT_DIR, 'data', DEFAULT_DB_NAME);
      const shouldUseLegacy = !fs.existsSync(rootCandidate) && fs.existsSync(legacyInData);
      resolvedPath = shouldUseLegacy ? legacyInData : rootCandidate;
      ensureDirectory(path.dirname(resolvedPath));
    }

    if (this.databasePath !== resolvedPath || previousEnv !== envPath) {
      this.databasePath = resolvedPath;
      this._resolvedDatabaseEnv = envPath;
    }

    return this.databasePath;
  }

  _emitChange(details = {}) {
    const payload = {
      timestamp: new Date().toISOString(),
      ...details,
    };

    this.emit('change', payload);
  }

  async checkpoint(mode = 'PASSIVE') {
    await this._ensureReady();
    const allowed = new Set(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']);
    const normalized =
      typeof mode === 'string' && mode.trim() ? mode.trim().toUpperCase() : 'PASSIVE';
    const target = allowed.has(normalized) ? normalized : 'PASSIVE';

    try {
      await this.db.exec(`PRAGMA wal_checkpoint(${target})`);
    } catch (error) {
      console.warn(`[DB] Falha ao executar wal_checkpoint(${target}):`, error.message);
    }
  }

  async vacuumInto(destinationPath) {
    await this._ensureReady();
    const target = typeof destinationPath === 'string' ? destinationPath.trim() : '';
    if (!target) {
      throw new Error('Destino inválido para o backup.');
    }

    const escaped = target.replace(/'/g, "''");
    await this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  recordChange(reason, extra = {}) {
    const type = typeof reason === 'string' && reason.trim() ? reason.trim() : 'change';
    this._emitChange({ type, ...extra });
  }

  async _ensureReady() {
    if (!this.db) {
      await this.init();
    }
  }

  async _createProfilesTable() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS steamprofile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        password TEXT,
        sharedSecret TEXT,
        steamId TEXT UNIQUE,
        cookies TEXT,
        lastComment DATETIME
      )
    `);

    const columns = await this.db.all(`PRAGMA table_info(steamprofile)`);
    if (!columns.some((column) => column.name === 'sharedSecret')) {
      await this.db.exec(`ALTER TABLE steamprofile ADD COLUMN sharedSecret TEXT`);
    }
  }

  async _createCommentsTable() {
    await this._ensureReady();
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steamId TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async _createUsersTable() {
    await this._ensureReady();
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_user (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        fullName TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL,
        passwordSalt TEXT NOT NULL,
        dateOfBirth TEXT NOT NULL,
        discordId TEXT NOT NULL UNIQUE,
        rep4repId TEXT NOT NULL UNIQUE,
        rep4repKey TEXT DEFAULT '',
        phoneNumber TEXT NOT NULL,
        credits INTEGER NOT NULL DEFAULT 0,
        apiToken TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'customer',
        status TEXT NOT NULL DEFAULT 'pending',
        lastLoginAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        discordWebhookUrl TEXT DEFAULT ''
      )
    `);

    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_app_user_status ON app_user(status)
    `);

    const columns = await this.db.all(`PRAGMA table_info(app_user)`);
    const hasWebhookColumn = columns.some((column) => column.name === 'discordWebhookUrl');
    if (!hasWebhookColumn) {
      await this.db.exec(`ALTER TABLE app_user ADD COLUMN discordWebhookUrl TEXT DEFAULT ''`);
    }
  }

  async _createRunQueueTable() {
    await this._ensureReady();
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_queue (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        command TEXT NOT NULL DEFAULT 'autoRun',
        status TEXT NOT NULL DEFAULT 'pending',
        maxCommentsPerAccount INTEGER NOT NULL DEFAULT 1000,
        accountLimit INTEGER NOT NULL DEFAULT 100,
        requestedComments INTEGER NOT NULL DEFAULT 0,
        enqueuedAt TEXT NOT NULL,
        startedAt TEXT,
        finishedAt TEXT,
        durationMs INTEGER,
        summary TEXT,
        cleanup TEXT,
        creditsConsumed INTEGER NOT NULL DEFAULT 0,
        totalComments INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        FOREIGN KEY(userId) REFERENCES app_user(id) ON DELETE CASCADE
      )
    `);

    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_run_queue_status_enqueued
      ON run_queue(status, datetime(enqueuedAt))
    `);

    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_run_queue_user
      ON run_queue(userId, status)
    `);

    const queueColumns = await this.db.all(`PRAGMA table_info(run_queue)`);
    const hasRequestedComments = queueColumns.some((column) => column.name === 'requestedComments');
    if (!hasRequestedComments) {
      await this.db.exec(`ALTER TABLE run_queue ADD COLUMN requestedComments INTEGER NOT NULL DEFAULT 0`);
    }
  }

  async addOrUpdateProfile(username, password, sharedSecret, steamId, cookies) {
    await this._ensureReady();
    try {
      const serializedCookies =
        typeof cookies === 'string' ? cookies : JSON.stringify(cookies || []);
      let existingProfile = null;

      if (steamId) {
        existingProfile = await this.db.get(
          `SELECT id, steamId, username FROM steamprofile WHERE steamId = ? OR username = ?`,
          [steamId, username],
        );
      } else {
        existingProfile = await this.db.get(
          `SELECT id, steamId, username FROM steamprofile WHERE username = ?`,
          [username],
        );
      }

      let changeType = existingProfile ? 'profile.update' : 'profile.insert';
      let result = null;

      if (existingProfile) {
        result = await this.db.run(
          `UPDATE steamprofile
             SET username = ?, password = ?, sharedSecret = ?, steamId = ?, cookies = ?
           WHERE id = ?`,
          [
            username,
            password,
            sharedSecret || null,
            steamId,
            serializedCookies,
            existingProfile.id,
          ],
        );
      } else {
        try {
          result = await this.db.run(
            `INSERT INTO steamprofile (username, password, sharedSecret, steamId, cookies)
             VALUES (?, ?, ?, ?, ?)`,
            [username, password, sharedSecret || null, steamId, serializedCookies],
          );
        } catch (error) {
          if (
            steamId &&
            /UNIQUE constraint failed: steamprofile\.steamId/.test(error?.message || '')
          ) {
            const conflicting = await this.db.get(
              `SELECT id, steamId, username FROM steamprofile WHERE steamId = ?`,
              [steamId],
            );
            if (conflicting) {
              existingProfile = conflicting;
              changeType = 'profile.update';
              result = await this.db.run(
                `UPDATE steamprofile
                   SET username = ?, password = ?, sharedSecret = ?, steamId = ?, cookies = ?
                 WHERE id = ?`,
                [
                  username,
                  password,
                  sharedSecret || null,
                  steamId,
                  serializedCookies,
                  conflicting.id,
                ],
              );
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }

      console.log(`✅ Perfil ${username} adicionado/atualizado.`);
      if (result?.changes > 0) {
        const steamRef = steamId || existingProfile?.steamId || null;
        this._emitChange({ type: changeType, username, steamId: steamRef });
      }

      await this.checkpoint('PASSIVE');
      return result;
    } catch (err) {
      console.error("❌ Erro ao adicionar/atualizar perfil:", err.message);
      throw err;
    }
  }

  async removeProfile(username) {
    await this._ensureReady();
    const removalResult = await this.db.run(
      `DELETE FROM steamprofile WHERE username = ?`,
      [username]
    );

    if (removalResult.changes > 0) {
      console.log(`🗑️ Perfil '${username}' removido.`);
      this._emitChange({ type: 'profile.remove', username });
      await this.checkpoint('PASSIVE');
    } else {
      console.log(`⚠️ Nenhum perfil encontrado com username '${username}'.`);
    }

    return removalResult;
  }

  async getAllProfiles() {
    await this._ensureReady();
    return await this.db.all(`SELECT * FROM steamprofile`);
  }

  async updateLastComment(steamId) {
    await this._ensureReady();
    await this.db.run(`
      UPDATE steamprofile
      SET lastComment = DATETIME('now', 'localtime')
      WHERE steamId = ?
    `, [steamId]);

    await this.db.run(`
      INSERT INTO comments (steamId) VALUES (?)
    `, [steamId]);
  }

  async getCommentsInLast24Hours(steamId) {
    await this._ensureReady();
    const commentCountRow = await this.db.get(`
      SELECT COUNT(*) as count
      FROM comments
      WHERE steamId = ? AND timestamp >= DATETIME('now', '-24 hours')
    `, [steamId]);

    return commentCountRow?.count || 0;
  }

  async updateCookies(username, cookies) {
    await this._ensureReady();
    const serializedCookies = typeof cookies === 'string'
      ? cookies
      : JSON.stringify(cookies || []);
    await this.db.run(
      `UPDATE steamprofile SET cookies = ? WHERE username = ?`,
      [serializedCookies, username]
    );
  }

  getDatabasePath() {
    return this.databasePath || this._resolveDatabasePath();
  }

  async getConnection() {
    await this._ensureReady();
    return this.db;
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this._initPromise = null;
    }
  }

  // Utilitário opcional para logging ou debug
  async dumpAllData() {
    await this._ensureReady();
    const profiles = await this.getAllProfiles();
    return JSON.stringify(profiles, null, 2);
  }
}

module.exports = new DbWrapper();
