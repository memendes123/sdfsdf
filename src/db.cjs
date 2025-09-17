const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

class DbWrapper {
  constructor() {
    this.db = null;
    this._initPromise = null;
    this.databasePath = path.join(__dirname, '..', 'steamprofiles.db');
  }

  async init() {
    if (this.db) {
      return this.db;
    }

    if (!this._initPromise) {
      this._initPromise = (async () => {
        const database = await open({
          filename: this.databasePath,
          driver: sqlite3.Database
        });

        this.db = database;
        await this._createProfilesTable();
        await this._createCommentsTable();
        await this._createUsersTable();
        console.log("📦 Banco de dados inicializado.");
        return this.db;
      })().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }

    return this._initPromise;
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
        updatedAt TEXT NOT NULL
      )
    `);

    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_app_user_status ON app_user(status)
    `);
  }

  async addOrUpdateProfile(username, password, sharedSecret, steamId, cookies) {
    await this._ensureReady();
    try {
      const serializedCookies = typeof cookies === 'string'
        ? cookies
        : JSON.stringify(cookies || []);
      const result = await this.db.run(`
        INSERT INTO steamprofile (username, password, sharedSecret, steamId, cookies)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(steamId) DO UPDATE SET
          username = excluded.username,
          password = excluded.password,
          sharedSecret = excluded.sharedSecret,
          cookies = excluded.cookies
      `, [username, password, sharedSecret || null, steamId, serializedCookies]);

      console.log(`✅ Perfil ${username} adicionado/atualizado.`);
      return result;
    } catch (err) {
      console.error("❌ Erro ao adicionar/atualizar perfil:", err.message);
    }
  }

  async removeProfile(username) {
    await this._ensureReady();
    const result = await this.db.run(
      `DELETE FROM steamprofile WHERE username = ?`,
      [username]
    );

    if (result.changes > 0) {
      console.log(`🗑️ Perfil '${username}' removido.`);
    } else {
      console.log(`⚠️ Nenhum perfil encontrado com username '${username}'.`);
    }

    return result;
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
    const result = await this.db.get(`
      SELECT COUNT(*) as count
      FROM comments
      WHERE steamId = ? AND timestamp >= DATETIME('now', '-24 hours')
    `, [steamId]);

    return result?.count || 0;
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
    return this.databasePath;
  }

  async getConnection() {
    await this._ensureReady();
    return this.db;
  }

  // Utilitário opcional para logging ou debug
  async dumpAllData() {
    await this._ensureReady();
    const profiles = await this.getAllProfiles();
    return JSON.stringify(profiles, null, 2);
  }
}

module.exports = new DbWrapper();
