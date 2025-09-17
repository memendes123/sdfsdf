require("dotenv").config();
const fetch = require("node-fetch");
const { FormData } = require("formdata-node");

class ApiWrapper {
  constructor() {
    this.url = "https://rep4rep.com/pub-api";
    this.token = process.env.REP4REP_KEY;

    if (!this.token) {
      console.error("❌ REP4REP_KEY não está definido no .env");
      process.exit(1);
    }
  }

  buildForm(params) {
    const form = new FormData();
    form.set("apiToken", this.token);
    for (const [key, value] of Object.entries(params)) {
      form.set(key, value);
    }
    return form;
  }

  async fetchWithJsonCheck(url, options) {
    const maxAttempts = 3;
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      try {
        const response = await fetch(url, options);
        const text = await response.text();

        try {
          const json = JSON.parse(text);
          return json;
        } catch (jsonErr) {
          throw new Error(`Falha ao parsear JSON: ${jsonErr.message}`);
        }

      } catch (error) {
        if (attempts < maxAttempts - 1) {
          const waitTime = (attempts + 1) * 1000;
          console.warn(`⚠️ Erro ao conectar à API. Tentando novamente em ${waitTime / 1000}s...`);
          await delay(waitTime);
        } else {
          console.error(`❌ Erro permanente ao chamar ${url}:`, error.message);
          throw error;
        }
      }
    }
  }

  async addSteamProfile(steamId) {
    return await this.fetchWithJsonCheck(`${this.url}/user/steamprofiles/add`, {
      method: "POST",
      body: this.buildForm({ steamProfile: steamId }),
    });
  }

  async getSteamProfiles() {
    return await this.fetchWithJsonCheck(`${this.url}/user/steamprofiles?apiToken=${this.token}`, {
      method: "GET",
    });
  }

  async getTasks(r4rSteamId) {
    return await this.fetchWithJsonCheck(`${this.url}/tasks?apiToken=${this.token}&steamProfile=${r4rSteamId}`, {
      method: "GET",
    });
  }

  async completeTask(taskId, commentId, authorSteamProfileId) {
    return await this.fetchWithJsonCheck(`${this.url}/tasks/complete`, {
      method: "POST",
      body: this.buildForm({
        taskId,
        commentId,
        authorSteamProfileId,
      }),
    });
  }
}

module.exports = new ApiWrapper(); // exporta instância pronta
module.exports.ApiWrapper = ApiWrapper; // opcional: útil para mocks e testes
