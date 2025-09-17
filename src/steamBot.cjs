const SteamCommunity = require("steamcommunity");
const steamTotp = require("steam-totp");
const db = require("./db.cjs");
const colors = require("colors");

// Definição de status com nomes claros
const LOGIN_STATUS = {
  OK: 4,
  EMAIL_GUARD: 1,
  MOBILE_GUARD: 2,
  CAPTCHA: 3,
  THROTTLED: 5,
};

module.exports = (config = {}) => {
  const client = {
    status: 0,
    captchaUrl: null,
    emailDomain: null,
  };

  const community = new SteamCommunity();

  client.isLoggedIn = async () => {
    return new Promise((resolve, reject) => {
      community.loggedIn((err, loggedIn) => {
        if (err) return reject(err);
        resolve(loggedIn);
      });
    });
  };

  client.getSteamId = async () => {
    return community.steamID ? community.steamID.getSteamID64() : null;
  };

  client.postComment = async (steamId, commentText) => {
    return new Promise((resolve, reject) => {
      community.postUserComment(steamId, commentText, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  };

  client.postComments = async (account, comments = []) => {
    if (!Array.isArray(comments) || comments.length === 0) {
      console.log(`⚠️ Nenhum comentário fornecido para ${account.name}`.yellow);
      return;
    }

    for (let i = 0; i < comments.length; i++) {
      try {
        await client.postComment(account.steamId, comments[i]);
        console.log(`💬 Comentário ${i + 1}/${comments.length} enviado para ${account.name}`.green);
      } catch (error) {
        console.error(`❌ Erro no comentário ${i + 1} para ${account.name}:`, error.message);
        if (error.message.includes("limit reached")) {
          console.log(`⚠️ Limite de comentários atingido para ${account.name}`.yellow);
          break;
        }
      }
    }
  };

  client.processAccounts = async (accounts, comments) => {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      console.log("⚠️ Nenhuma conta fornecida para processar.".yellow);
      return;
    }

    for (let account of accounts) {
      try {
        await client.steamLogin(account.name, account.password, account.authCode, account.sharedSecret);
        const loggedIn = await client.isLoggedIn();

        if (loggedIn) {
          console.log(`✅ Logado com sucesso em ${account.name}`.green);
          await client.postComments(account, comments);
        } else {
          console.log(`❌ Falha ao logar em ${account.name}`.red);
        }
      } catch (err) {
        console.error(`❌ Erro ao processar conta ${account.name}:`, err.message);
      }
    }
  };

  client.steamLogin = async (accountName, password, authCode, sharedSecret, captcha = null, cookies = null) => {
    if (cookies) {
      community.setCookies(cookies);
    }

    return new Promise((resolve, reject) => {
      community.login({
        accountName,
        password,
        authCode,
        twoFactorCode: sharedSecret ? steamTotp.generateAuthCode(sharedSecret) : null,
        captcha,
      }, async (err, sessionID, newCookies, steamguard) => {
        if (err) {
          switch (err.message) {
            case "SteamGuard":
              client.status = LOGIN_STATUS.EMAIL_GUARD;
              client.emailDomain = err.emaildomain;
              console.log(`📧 Proteção Steam Guard por email em ${accountName}`.cyan);
              return resolve(); // precisa do código manual depois
            case "SteamGuardMobile":
              client.status = LOGIN_STATUS.MOBILE_GUARD;
              console.log(`📱 Steam Guard mobile requerido para ${accountName}`.cyan);
              return resolve();
            case "CAPTCHA":
              client.status = LOGIN_STATUS.CAPTCHA;
              client.captchaUrl = err.captchaurl;
              console.log(`🔐 CAPTCHA requerido para ${accountName}: ${err.captchaurl}`.cyan);
              return resolve();
            case "AccountLoginDeniedThrottle":
              client.status = LOGIN_STATUS.THROTTLED;
              console.log("🚫 Tentativas de login bloqueadas. Tente mais tarde.".red);
              return resolve();
            default:
              console.error("❌ Erro de login:", err.message);
              return reject(err);
          }
        }

        client.status = LOGIN_STATUS.OK;
        community.setCookies(newCookies);
        console.log(`✅ Login bem-sucedido para ${accountName}`.green);

        try {
          const steamID64 = community.steamID?.getSteamID64() || null;

          // Salvar dados no DB
          await db.addOrUpdateProfile(accountName, password, steamID64, newCookies);

          // Validar steamID via API
          community.getSteamUser(community.steamID, (err, user) => {
            if (err || !user) {
              console.error("⚠️ Erro ao buscar usuário Steam:", err?.message || "Desconhecido");
              return reject(new Error("Falha ao obter usuário Steam"));
            }

            community.steamID = user.steamID;
            console.log(`🆔 SteamID obtido: ${community.steamID}`);
            resolve();
          });
        } catch (dbErr) {
          return reject(dbErr);
        }
      });
    });
  };

  client.getSteamGuardCode = (sharedSecret) => {
    return steamTotp.generateAuthCode(sharedSecret);
  };

  return client;
};
