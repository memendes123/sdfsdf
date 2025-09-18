const path = require('path');
const dotenv = require('dotenv');

const ROOT_DIR = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const { FormData: NodeFormData } = require('formdata-node');

const FormDataCtor =
  typeof globalThis.FormData === 'function'
    ? globalThis.FormData
    : typeof NodeFormData === 'function'
      ? NodeFormData
      : null;

const fetchFn = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

class ApiError extends Error {
  constructor(message, { status, payload } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? null;
    this.payload = payload;
  }
}

function sanitizeToken(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getEnvToken() {
  return sanitizeToken(process.env.REP4REP_KEY);
}

class ApiWrapper {
  constructor({ token, baseUrl } = {}) {
    this.url = baseUrl || 'https://rep4rep.com/pub-api/';
    this.token = sanitizeToken(token) ?? getEnvToken();
    if (!this.token) {
      console.warn(
        '[Rep4Rep API] Token não configurado. Defina REP4REP_KEY ou forneça manualmente.',
      );
    }
  }

  withToken(token) {
    return new ApiWrapper({ token, baseUrl: this.url });
  }

  setToken(token) {
    this.token = sanitizeToken(token);
  }

  resolveToken(override) {
    const provided = sanitizeToken(override);
    if (provided) {
      return provided;
    }

    const envToken = getEnvToken();
    if (envToken) {
      this.token = envToken;
      return envToken;
    }

    if (this.token) {
      return this.token;
    }

    throw new ApiError('Token da API Rep4Rep não definido.');
  }

  buildForm(params = {}, tokenOverride) {
    const useFormData = typeof FormDataCtor === 'function';
    const form = useFormData ? new FormDataCtor() : new URLSearchParams();
    const token = this.resolveToken(tokenOverride);
    const setValue = (key, value) => {
      if (typeof form.set === 'function') {
        form.set(key, value);
      } else {
        form.append(key, value);
      }
    };

    setValue('apiToken', token);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          const normalized = entry === undefined || entry === null ? '' : String(entry);
          form.append(key, normalized);
        }
        continue;
      }

      const normalized = String(value);
      setValue(key, normalized);
    }
    return form;
  }

  extractList(payload, preferredKeys = []) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && typeof payload === 'object') {
      const candidates = [...preferredKeys, 'data', 'result', 'items', 'records', 'profiles'];
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

    console.warn('⚠️ [Rep4Rep API] Formato inesperado recebido ao extrair lista.', payload);
    return [];
  }

  async fetchWithJsonCheck(url, options, { retries = 3, retryStatuses = [502, 503, 504] } = {}) {
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchFn(url, options);
        const text = await response.text();

        let json = {};
        if (text.trim().length > 0) {
          try {
            json = JSON.parse(text);
          } catch (jsonErr) {
            throw new ApiError(`Falha ao interpretar resposta da API: ${jsonErr.message}`, {
              status: response.status,
              payload: text.slice(0, 200),
            });
          }
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

        if (json && typeof json === 'object') {
          if (Object.prototype.hasOwnProperty.call(json, 'success') && !json.success) {
            throw new ApiError(json.message || json.error || 'Erro retornado pela API.', {
              status: response.status,
              payload: json,
            });
          }

          if (!Object.prototype.hasOwnProperty.call(json, 'success') && json.error) {
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
          (lastError instanceof ApiError ? retryStatuses.includes(lastError.status) : true);

        if (!shouldRetry) {
          throw lastError;
        }

        await delay((attempt + 1) * 1000);
      }
    }

    throw lastError;
  }

  async request(path, {
    method = 'POST',
    query = {},
    form = {},
    expectsArray = false,
    listKeys = [],
    token,
  } = {}) {
    const url = new URL(path, this.url);
    const authToken = this.resolveToken(token);
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${authToken}`,
    };

    const options = { method, headers };

    if (method.toUpperCase() === 'GET') {
      const params = new URLSearchParams(query);
      if (!params.has('apiToken')) {
        params.set('apiToken', authToken);
      }
      const search = params.toString();
      if (search) {
        url.search = search;
      }
    } else {
      options.body = this.buildForm(form, authToken);
    }

    const payload = await this.fetchWithJsonCheck(url.toString(), options);
    if (!expectsArray) {
      return payload;
    }
    return this.extractList(payload, listKeys);
  }

  async addSteamProfile(steamId, options = {}) {
    return this.request('user/steamprofiles/add', {
      method: 'POST',
      form: { steamProfile: steamId },
      token: options.token,
    });
  }

  async removeSteamProfile(steamId, options = {}) {
    return this.request('user/steamprofiles/remove', {
      method: 'POST',
      form: { steamProfile: steamId },
      token: options.token,
    });
  }

  async getSteamProfiles(options = {}) {
    return this.request('user/steamprofiles', {
      method: 'GET',
      expectsArray: true,
      listKeys: ['steamProfiles'],
      token: options.token,
    });
  }

  async getTasks(steamProfileId, options = {}) {
    return this.request('tasks', {
      method: 'GET',
      query: { steamProfile: steamProfileId },
      expectsArray: true,
      listKeys: ['tasks'],
      token: options.token,
    });
  }

  async completeTask(taskId, commentId, authorSteamProfileId, options = {}) {
    return this.request('tasks/complete', {
      method: 'POST',
      form: {
        taskId,
        commentId,
        authorSteamProfileId,
      },
      token: options.token,
    });
  }
}

const defaultApi = new ApiWrapper();

module.exports = defaultApi;
module.exports.ApiWrapper = ApiWrapper;
module.exports.ApiError = ApiError;
module.exports.createApiClient = (token) => new ApiWrapper({ token });
