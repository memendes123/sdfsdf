const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

class DbWrapper {
  constructor() {
    this.db = null;
  }

  async init() {
    this.db = await open({
      filename: './steamprofiles.db',
      driver: sqlite3.Database
    });

    await this._createProfilesTable();
    await this._createCommentsTable();
    console.log("📦 Banco de dados inicializado.");
  }

  async _createProfilesTable() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS steamprofile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        password TEXT,
        steamId TEXT UNIQUE,
        cookies TEXT,
        lastComment DATETIME
      )
    `);
  }

  async _createCommentsTable() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steamId TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async addOrUpdateProfile(username, password, steamId, cookies) {
    try {
      const result = await this.db.run(`
        INSERT INTO steamprofile (username, password, steamId, cookies)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(steamId) DO UPDATE SET
          username = excluded.username,
          password = excluded.password,
          cookies = excluded.cookies
      `, [username, password, steamId, JSON.stringify(cookies)]);

      console.log(`✅ Perfil ${username} adicionado/atualizado.`);
      return result;
    } catch (err) {
      console.error("❌ Erro ao adicionar/atualizar perfil:", err.message);
    }
  }

  async removeProfile(username) {
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
    return await this.db.all(`SELECT * FROM steamprofile`);
  }

  async updateLastComment(steamId) {
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
    const result = await this.db.get(`
      SELECT COUNT(*) as count
      FROM comments
      WHERE steamId = ? AND timestamp >= DATETIME('now', '-24 hours')
    `, [steamId]);

    return result?.count || 0;
  }

  // Utilitário opcional para logging ou debug
  async dumpAllData() {
    const profiles = await this.getAllProfiles();
    return JSON.stringify(profiles, null, 2);
  }
}

module.exports = new DbWrapper();
