require("dotenv").config();
const { FormData } = require("formdata-node");

const fetchFn = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));


class ApiError extends Error {
  constructor(message, { status, payload } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status ?? null;
    this.payload = payload;
  }
}

class ApiWrapper {
  constructor() {
    this.url = "https://rep4rep.com/pub-api/";
    this.token = process.env.REP4REP_KEY;

    if (!this.token) {
      console.error("❌ REP4REP_KEY não está definido no .env");
      process.exit(1);
    }
  }

  buildForm(params = {}) {
    const form = new FormData();
    form.set("apiToken", this.token);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.set(key, value);
    }
    return form;
  }

  extractList(payload, preferredKeys = []) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && typeof payload === "object") {
      const candidates = [...preferredKeys, "data", "result", "items", "records", "profiles"];
      for (const key of candidates) {
        if (!key) continue;
        const value = payload[key];
        if (Array.isArray(value)) {
          return value;
        }
      }
    }

    if (payload == null) {
      return [];
    }

    console.warn("⚠️ [Rep4Rep API] Formato inesperado recebido ao extrair lista.", payload);
    return [];
  }

  async fetchWithJsonCheck(url, options, { retries = 3, retryStatuses = [502, 503, 504] } = {}) {
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchFn(url, options);
        const text = await response.text();

        let json = null;
        if (text.trim().length > 0) {
          try {
            json = JSON.parse(text);
          } catch (jsonErr) {
            throw new ApiError(`Falha ao interpretar resposta da API: ${jsonErr.message}`, {
              status: response.status,
              payload: text.slice(0, 200),
            });
          }
        } else {
          json = {};
        }

        if (!response.ok) {
          const message = json?.message || json?.error || `HTTP ${response.status}`;
          const error = new ApiError(message, { status: response.status, payload: json });
          if (retryStatuses.includes(response.status) && attempt < retries - 1) {
            await delay((attempt + 1) * 1000);
            lastError = error;
            continue;
          }
          throw error;
        }

        if (json && typeof json === "object") {
          if (Object.prototype.hasOwnProperty.call(json, "success") && !json.success) {
            throw new ApiError(json.message || json.error || "Erro retornado pela API.", {
              status: response.status,
              payload: json,
            });
          }

          if (!Object.prototype.hasOwnProperty.call(json, "success") && json.error) {
            throw new ApiError(json.error, {
              status: response.status,
              payload: json,
            });
          }
        }

        return json;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const shouldRetry =
          attempt < retries - 1 &&
          (lastError instanceof ApiError
            ? retryStatuses.includes(lastError.status)
            : true);

        if (!shouldRetry) {
          throw lastError;
        }

        await delay((attempt + 1) * 1000);

      }
    }

    throw lastError;
  }

  async request(path, {
    method = "POST",
    query = {},
    form = {},
    expectsArray = false,
    listKeys = [],
  } = {}) {
    const attempts = method.toUpperCase() === "GET" ? [false, true] : [false];
    let lastError = null;

    for (const includeTokenInQuery of attempts) {
      const url = new URL(path, this.url);
      const headers = {
        Accept: "application/json",
      };

      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      const options = {
        method,
        headers,
      };

      if (method.toUpperCase() === "GET") {
        const params = new URLSearchParams(query);
        if (includeTokenInQuery || !headers.Authorization) {
          params.set("apiToken", this.token);
        }
        const search = params.toString();
        if (search) {
          url.search = search;
        }
      } else {
        options.body = this.buildForm(form);
      }

      try {
        const payload = await this.fetchWithJsonCheck(url.toString(), options);
        if (!expectsArray) {
          return payload;
        }
        return this.extractList(payload, listKeys);
      } catch (error) {
        lastError = error;
        if (
          method.toUpperCase() === "GET" &&
          !includeTokenInQuery &&
          error instanceof ApiError &&
          [401, 403].includes(error.status)
        ) {
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  async addSteamProfile(steamId) {
    return this.request("user/steamprofiles/add", {
      method: "POST",
      form: { steamProfile: steamId },
    });
  }

  async removeSteamProfile(steamId) {
    return this.request("user/steamprofiles/remove", {
      method: "POST",
      form: { steamProfile: steamId },
    });
  }

  async getSteamProfiles() {
    return this.request("user/steamprofiles", {
      method: "GET",
      expectsArray: true,
      listKeys: ["steamProfiles"],
    });
  }

  async getTasks(r4rSteamId) {
    return this.request("tasks", {
      method: "GET",
      query: { steamProfile: r4rSteamId },
      expectsArray: true,
      listKeys: ["tasks"],
    });
  }

  async completeTask(taskId, commentId, authorSteamProfileId) {
    return this.request("tasks/complete", {
      method: "POST",
      form: {
        taskId,
        commentId,
        authorSteamProfileId,
      },
    });
  }
}

const apiInstance = new ApiWrapper();

module.exports = apiInstance; // exporta instância pronta
module.exports.ApiWrapper = ApiWrapper; // opcional: útil para mocks e testes
module.exports.ApiError = ApiError;
