const fs = require('fs');
const path = require('path');
const db = require('./db.cjs');
const apiModule = require('./api.cjs');
const api = apiModule;
const { ApiError } = apiModule;
const steamBot = require('./steamBot.cjs');
const { table } = require('table');
const ReadLine = require('readline');
const moment = require('moment');
require('dotenv').config();

const ROOT_DIR = path.join(__dirname, '..');
const ACCOUNTS_PATH = path.join(ROOT_DIR, 'accounts.txt');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');


let rl = null;

function getReadline() {
    if (!rl) {
        rl = ReadLine.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }
    return rl;
}

const statusMessage = {
    inactive: 0,
    steamGuardRequired: 1,
    steamGuardMobileRequired: 2,
    captchaRequired: 3,
    loggedIn: 4
};

// ============ LOGGING ============

function log(message, emptyLine = false) {
    console.log(`[rep4rep-bot] ${message}`);
    if (emptyLine) {
        console.log();
    }
}

function logToFile(username, success = 0, fail = 0) {
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(LOGS_DIR, `${date}.log`);
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${username} - Success: ${success} | Fail: ${fail}\n`;
    fs.appendFileSync(logFile, line);
}

function logInvalidAccount(username, reason) {
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(LOGS_DIR, `invalid-${date}.log`);
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${username} - ${reason}\n`;
    fs.appendFileSync(logFile, line);
}

function removeFromAccountsFile(username) {
    if (!fs.existsSync(ACCOUNTS_PATH)) {
        return;
    }
    const lines = fs.readFileSync(ACCOUNTS_PATH, 'utf-8').split(/\r?\n/);
    const filtered = lines.filter(line => line && !line.startsWith(`${username}:`));
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

    const content = fs.readFileSync(ACCOUNTS_PATH, 'utf-8');
    return content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
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
                log(`[${username}] Failed to parse stored cookies. Ignorando cookies salvos.`);
            }
            return [];
        }
    }

    return Array.isArray(rawCookies) ? rawCookies : [];

    const filePath = path.join(__dirname, '..', 'accounts.txt');
    if (!fs.existsSync(filePath)) {
        return;
    }
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const filtered = lines.filter(line => !line.startsWith(username + ':'));
    fs.writeFileSync(filePath, filtered.join('\n'));

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
                log(`[${username}] Failed to parse stored cookies. Ignorando cookies salvos.`);
            }
            return [];
        }
    }

    return Array.isArray(rawCookies) ? rawCookies : [];
}

async function autoRun() {
    const accounts = readAccountsFile();
    if (accounts.length === 0) {
        log('Nenhuma conta configurada no accounts.txt. Adicione contas antes de executar o autoRun.', true);
        return;
    }

    let profiles;
    try {
        profiles = await db.getAllProfiles();
    } catch (error) {
        log(`❌ Falha ao carregar perfis do banco de dados: ${error.message}`, true);
        return;
    }

    let r4rProfiles;
    try {
        r4rProfiles = await api.getSteamProfiles();
    } catch (error) {
        log(`[API] Não foi possível obter os perfis do Rep4Rep: ${describeApiError(error)}`, true);
        return;
    }

    if (!Array.isArray(r4rProfiles) || r4rProfiles.length === 0) {
        log('[API] Nenhum perfil Rep4Rep encontrado. Execute a sincronização (--auth-profiles) antes do autoRun.', true);
        return;
    }

    for (const [i, account] of accounts.entries()) {
        const [username, password, sharedSecret] = account.split(':');
        if (!username || !password || !sharedSecret) {
            log(`Formato inválido de conta: ${account}`);
            continue;
        }

        log(`Attempting to leave comments from: ${username}`);

        const profile = profiles.find(p => p.username === username);
        if (!profile) {
            log(`Perfil não encontrado no banco de dados para o usuário: ${username}`);
            continue;
        }

        const hoursSinceLastComment = profile.lastComment
            ? moment().diff(moment(profile.lastComment), 'hours')
            : Infinity;

        if (!profile.lastComment || hoursSinceLastComment >= 24) {
            const r4rSteamProfile = r4rProfiles.find(r4rProfile => r4rProfile?.steamId == profile.steamId);
            if (!r4rSteamProfile) {
                log(`[${username}] steamProfile não existe no Rep4Rep.`);
                log('Sincronize os perfis com --auth-profiles e tente novamente.', true);
                continue;
            }

            let tasks;
            try {
                tasks = await api.getTasks(r4rSteamProfile.id);
            } catch (error) {
                log(`[${username}] Falha ao obter tarefas: ${describeApiError(error)}`, true);
                continue;
            }

            if (!Array.isArray(tasks) || tasks.length === 0) {
                log(`[${username}] Nenhuma tarefa disponível. Pulando...`, true);
                continue;
            }

            const client = steamBot();
            let loggedIn = false;
            try {
                loggedIn = await loginWithRetries(client, username, password, sharedSecret, profile.cookies);
            } catch (error) {
                log(`[${username}] Falha ao autenticar: ${error.message}`, true);
                continue;
            }

            if (!loggedIn || (client.status !== statusMessage.loggedIn && !await client.isLoggedIn())) {
                log(`[${username}] não está logado. Reautenticação necessária.`, true);
                continue;
            }

            await autoRunComments(profile, client, tasks, r4rSteamProfile.id, 10);
            if (i !== accounts.length - 1) {
                await sleep(process.env.LOGIN_DELAY);
            }
        } else {
            const remaining = Math.max(0, Math.round(24 - hoursSinceLastComment));
            log(`[${username}] ainda está em cooldown.`);
            log(`[${username}] tente novamente em: ${remaining} horas`, true);
        }
    }

    log('autoRun completed');
}

async function autoRunComments(profile, client, tasks, authorSteamProfileId, maxComments = 10) {
    let commentsPosted = 0;
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;
    let completedTasks = new Set();
    let attempts = 0;
    const maxAttempts = 3;

    log(`[${profile.username}] Starting autoRunComments with ${tasks.length} tasks`);

    for (let taskIndex = 0; commentsPosted < maxComments && taskIndex < tasks.length && consecutiveFailures < maxConsecutiveFailures; taskIndex++) {
        const task = tasks[taskIndex];
        if (!task || !task.requiredCommentText || !task.targetSteamProfileName) {
            log(`[${profile.username}] Invalid task data. Skipping...`, true);
            continue;
        }

        log(`[${profile.username}] posting comment:`);
        log(`${task.requiredCommentText} > ${task.targetSteamProfileName}`, true);

        let commentSent = false;
        try {
            await client.postComment(task.targetSteamProfileId, task.requiredCommentText);
            commentSent = true;
        } catch (err) {
            log(`[${profile.username}] failed to post comment: ${err.message}`);
            log(`Debug Info: TargetSteamProfileId: ${task.targetSteamProfileId}, RequiredCommentText: ${task.requiredCommentText}`);
            consecutiveFailures++;
        }

        if (!commentSent) {
            await sleep(process.env.COMMENT_DELAY);
            continue;
        }

        completedTasks.add(task.taskId);
        commentsPosted++;
        consecutiveFailures = 0;

        try {
            await api.completeTask(task.taskId, task.requiredCommentId, authorSteamProfileId);
        } catch (error) {
            log(`[${profile.username}] falha ao confirmar a tarefa na API: ${describeApiError(error)}`);
        }

        try {
            await db.updateLastComment(profile.steamId);
        } catch (error) {
            log(`[${profile.username}] Falha ao atualizar informações do banco: ${error.message}`);
        }

        log(`[${profile.username}] comment posted and recorded`, true);
        await sleep(process.env.COMMENT_DELAY);
    }

    while (commentsPosted < maxComments && consecutiveFailures < maxConsecutiveFailures && attempts < maxAttempts) {
        log(`[${profile.username}] Attempting additional comment ${commentsPosted + 1}/${maxComments}`);
        let additionalTasks;
        try {
            additionalTasks = await api.getTasks(authorSteamProfileId); // Fetch new tasks to ensure updated list
        } catch (error) {
            log(`[${profile.username}] Falha ao atualizar lista de tarefas: ${describeApiError(error)}`, true);
            break;
        }

        additionalTasks = additionalTasks.filter(t => !completedTasks.has(t.taskId));

        if (additionalTasks.length === 0) {
            log(`[${profile.username}] No valid tasks available for additional comments. Retrying... (${attempts + 1}/${maxAttempts})`, true);
            attempts++;
            await sleep(process.env.COMMENT_DELAY);
            continue;
        }

        let postedThisRound = false;
        for (const randomTask of additionalTasks) {
            if (!randomTask || !randomTask.requiredCommentText || !randomTask.targetSteamProfileId) {
                log(`[${profile.username}] Invalid random task for additional comments. Skipping...`, true);
                continue;
            }

            const randomComment = randomTask.requiredCommentText;
            const targetSteamProfileId = randomTask.targetSteamProfileId;
            try {
                await client.postComment(targetSteamProfileId, randomComment);
                postedThisRound = true;
            } catch (err) {
                log(`[${profile.username}] failed to post additional comment: ${err.message}`);
                log(`Debug Info: TargetSteamProfileId: ${targetSteamProfileId}, RandomComment: ${randomComment}`);
                consecutiveFailures++;
                await sleep(process.env.COMMENT_DELAY);
                continue;
            }

            completedTasks.add(randomTask.taskId);
            commentsPosted++;
            consecutiveFailures = 0;

            try {
                await api.completeTask(randomTask.taskId, randomTask.requiredCommentId, authorSteamProfileId); // Mark additional comments as completed
            } catch (error) {
                log(`[${profile.username}] falha ao confirmar tarefa adicional: ${describeApiError(error)}`);
            }

            }

            completedTasks.add(randomTask.taskId);
            commentsPosted++;
            consecutiveFailures = 0;

            try {
                await api.completeTask(randomTask.taskId, randomTask.requiredCommentId, authorSteamProfileId); // Mark additional comments as completed
            } catch (error) {
                log(`[${profile.username}] falha ao confirmar tarefa adicional: ${describeApiError(error)}`);
            }

            try {
                await db.updateLastComment(profile.steamId);
            } catch (error) {
                log(`[${profile.username}] Falha ao atualizar informações do banco: ${error.message}`);
            }

            log(`[${profile.username}] additional comment posted successfully`, true);
            await sleep(process.env.COMMENT_DELAY);
            break; // Exit the for loop to attempt the next comment
        }

        if (postedThisRound) {
            attempts = 0;
        } else {
            attempts++;
        }
    }

    log(`[${profile.username}] done with posting comments. Total comments posted: ${commentsPosted}`, true);
}

async function loginWithRetries(client, profileOrUsername, password, sharedSecret, cookies, maxRetries = 3) {
    let username;
    let pass;
    let secret;
    let storedCookies;

    if (profileOrUsername && typeof profileOrUsername === 'object' && !Array.isArray(profileOrUsername)) {
        ({ username, password: pass, sharedSecret: secret, cookies: storedCookies } = profileOrUsername);
        if (typeof password !== 'undefined' || typeof sharedSecret !== 'undefined' || typeof cookies !== 'undefined') {
            // Avoid accidental mixed usage of the API
            log('loginWithRetries recebeu objeto de perfil e parâmetros adicionais. Ignorando parâmetros extras.');
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
    let fatalError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const cookiePayload = attempt === 0 && parsedCookies.length > 0 ? parsedCookies : null;

        try {
            await client.steamLogin(username, pass, null, secret, null, cookiePayload);
            const isLoggedIn = client.status === statusMessage.loggedIn || await client.isLoggedIn();
            if (isLoggedIn) {
                log(`[${username}] login successful`);
                return true;
            }

            if ([
                statusMessage.steamGuardRequired,
                statusMessage.steamGuardMobileRequired,
                statusMessage.captchaRequired
            ].includes(client.status)) {
                log(`[${username}] login requires manual verification (status: ${client.status}).`);
                return false;
            }
        } catch (error) {
            const msg = error.message || '';
            log(`[${username}] login attempt ${attempt + 1} failed: ${msg}`);

            if (/Invalid|denied|banned|RateLimit|Throttle|too many/i.test(msg)) {
                fatalError = msg;
                break;
            }

            if (error.code === 502) {
                log(`[${username}] WebAPI error 502. Retrying...`);
                await sleep(10000);
            } else if (attempt < maxRetries - 1) {
                await sleep(5000);
            } else {
                throw error;
            }
        }
    }

    if (fatalError) {
        log(`[${username}] login failed permanently: ${fatalError}`);
        logInvalidAccount(username, fatalError);

        try {
            const profile = (await db.getAllProfiles()).find(p => p.username === username);
            if (profile?.steamId) {
                await removeFromRep4Rep(profile.steamId);
            }
        } catch (err) {
            log(`[${username}] Falha ao buscar perfil para remoção: ${err.message}`);
        }

        await db.removeProfile(username);
        removeFromAccountsFile(username);
        return false;
    }

    throw new Error(`[${username}] login failed after ${maxRetries} attempts.`);
}


async function sleep(millis) {
    const ms = Number(millis) || 0;
    if (ms <= 0) {
        return Promise.resolve();
    }

    const sec = Math.round(ms / 1000);
    log(`[ ${sec}s delay ] ...`, true);
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function authAllProfiles() {
    let profiles = await db.getAllProfiles();
    for (const [i, profile] of profiles.entries()) {
        log(`Attempting to auth: ${profile.username} (${profile.steamId})`);
        let client = steamBot();
        let loggedIn = false;
        try {
            loggedIn = await loginWithRetries(client, profile);
        } catch (error) {
            log(`[${profile.username}] Falha ao autenticar: ${error.message}`, true);
            continue;
        }

        if (!loggedIn) {
            log(`[${profile.username}] Requer verificação manual. Pulando perfil.`, true);
            continue;
        }

        log(`[${profile.username}] Authorized`);

        try {
            let res = await syncWithRep4rep(client);
            if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
                log(`[${profile.username}] Synced to Rep4Rep`, true);
            } else {
                log(`[${profile.username}] Failed to sync:`);
                log(res, true);
            }
        } catch (error) {
            log(`[${profile.username}] Erro ao sincronizar: ${describeApiError(error)}`, true);

            log(`[${profile.username}] Erro ao sincronizar: ${describeApiError(error)}`, true);

            log(`[${profile.username}] Erro ao sincronizar: ${error.message}`, true);

        }

        if (i !== profiles.length - 1) {
            await sleep(process.env.LOGIN_DELAY);
        }
    }

    log(`authProfiles completed`);
}

async function syncWithRep4rep(client) {
    let steamId = await client.getSteamId();
    let steamProfiles;

    try {
        steamProfiles = await api.getSteamProfiles();
    } catch (error) {
        const message = describeApiError(error);
        log(`Error retrieving steamProfiles: ${message}`);
        return `Error retrieving steamProfiles: ${message}`;
    }

    if (!Array.isArray(steamProfiles)) {
        console.error("steamProfiles is not an array");
        return "steamProfiles is not an array"; // Or handle the error accordingly
    }

    let exists = steamProfiles.some(steamProfile => steamProfile.steamId == steamId);

    if (!exists) {
        let res;
        try {
            res = await api.addSteamProfile(steamId);
        } catch (error) {
            const message = describeApiError(error);
            log(`Error adding steamProfile: ${message}`);
            return `Error adding steamProfile: ${message}`;
        }
        if (res.error) {
            return res.error;
        }
    }
    return true;
}

async function showAllProfiles() {
    let profiles = await db.getAllProfiles();
    let data = [
        ['steamId', 'username', 'lastComment']
    ];
    profiles.forEach(profile => {
        data.push([profile.steamId, profile.username, profile.lastComment]);
    });

    console.log(table(data));
}

async function addProfileSetup(accountName, password, sharedSecret) {
    let client = steamBot();

    let attempts = 0;
    const maxAttempts = 5;
    let success = false;

    while (attempts < maxAttempts && !success) {
        try {
            await client.steamLogin(accountName, password, null, sharedSecret, null);

            let loggedIn = client.status === statusMessage.loggedIn || await client.isLoggedIn();

            if (!loggedIn) {
                if (client.status === statusMessage.steamGuardRequired) {
                    const code = await promptForCode(accountName, client);
                    if (!code) {
                        throw new Error('Steam Guard code não informado.');
                    }
                    await client.steamLogin(accountName, password, code, sharedSecret, null);
                    loggedIn = client.status === statusMessage.loggedIn || await client.isLoggedIn();
                } else if (client.status === statusMessage.captchaRequired) {
                    const captcha = await promptForCode(accountName, client);
                    if (!captcha) {
                        throw new Error('Captcha não informado.');
                    }
                    await client.steamLogin(accountName, password, null, sharedSecret, captcha);
                    loggedIn = client.status === statusMessage.loggedIn || await client.isLoggedIn();
                } else if (client.status === statusMessage.steamGuardMobileRequired) {
                    log(`[${accountName}] Aguardando novo código do Steam Guard Mobile...`);
                    attempts++;
                    await sleep(30000);
                    continue;
                }
            }

            if (!loggedIn) {
                throw new Error('Não foi possível autenticar o perfil.');
            }

            let res = await syncWithRep4rep(client);
            if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
                log(`[${accountName}] Synced to Rep4Rep`, true);
            } else {
                log(`[${accountName}] Failed to sync:`);
                log(res, true);
            }

            log(`[${accountName}] Profile added`);
            success = true;
        } catch (error) {
            attempts++;
            const errorMessage = error?.message || String(error);
            if (errorMessage.includes('RateLimitExceeded')) {
                log(`Rate limit exceeded for ${accountName}. Waiting before retrying...`);
                await sleep(30000); // wait 1 minute before retrying
            } else {
                log(`Error adding profile ${accountName}: ${errorMessage}`);
                if (attempts < maxAttempts) {
                    await sleep(5000);
                }
            }
        }
    }

    if (!success) {
        log(`Failed to add profile ${accountName} after ${maxAttempts} attempts.`);
    }
}

async function removeProfile(username) {
    const target = typeof username === 'string' ? username.trim() : '';

    if (!target) {
        log('Informe o usuário a remover.', true);
        process.exit();
        return;
    }

    let profile;
    try {
        const profiles = await db.getAllProfiles();
        profile = profiles.find(p => p.username === target);
    } catch (error) {
        log(`❌ Falha ao carregar perfis: ${error.message}`, true);
        process.exit(1);
        return;
    }

    if (!profile) {
        log(`⚠️ Perfil '${target}' não encontrado.`, true);
        process.exit();
        return;
    }

    if (profile.steamId) {
        await removeFromRep4Rep(profile.steamId);
    }

    try {
        const result = await db.removeProfile(target);
        if (!result || result.changes === 0) {
            log(`⚠️ Nenhuma entrada removida para '${target}'.`, true);
        }
    } catch (error) {
        log(`❌ Erro ao remover '${target}' do banco: ${error.message}`, true);
    }

    removeFromAccountsFile(target);
    log(`✅ Remoção local concluída para '${target}'.`, true);
    process.exit();
}

async function promptForCode(username, client) {
    switch (client.status) {
        case 1:
            log(`[${username}] steamGuard code required  (${client.emailDomain})`);
            break;
        case 2:
            log(`[${username}] steamGuardMobile code required`);
            break;
        case 3:
            log(`[${username}] captcha required`);
            log(`URL: ${client.captchaUrl}`);
            break;
        default:
            console.log('fatal?');
            console.log(client.status);
            process.exit();
    }

    let res =  await new Promise(resolve => {
        getReadline().question('>> ', resolve);
    });
    return res;
}

// src/util.cjs

async function addProfilesFromFile() {
    const accounts = readAccountsFile();
    const accountCount = accounts.length;
    if (accountCount === 0) {
        log('Nenhuma conta encontrada para adicionar.', true);
        return;
    }

    log(`Starting to add ${accountCount} profiles from file.`);

    for (const [index, account] of accounts.entries()) {
        const [username, password, sharedSecret] = account.split(':');
        log(`Adding profile ${index + 1} of ${accountCount}: ${username}`);
        
        try {
            if (!username || !password || !sharedSecret) {
                throw new Error(`Invalid account format for ${account}`);
            }
            await addProfileSetup(username, password, sharedSecret);
            log(`Profile ${username} added successfully.`);
        } catch (error) {
            log(`Error adding profile ${username}: ${error.message}`);
        }
        
        if (index !== accounts.length - 1) {
            await sleep(30000); // Add delay to avoid throttling
        }
    }
    log('All profiles from file added');
}

async function removeFromRep4Rep(steamId) {
    try {
        const profiles = await api.getSteamProfiles();
        const match = Array.isArray(profiles) && profiles.find(p => p.steamId === steamId);
        if (!match) {
            return;
        }

        await api.removeSteamProfile(steamId);
        log(`[Rep4Rep] Removed steamId: ${steamId}`);
    } catch (err) {
        log(`[ERROR] Failed to remove from Rep4Rep: ${describeApiError(err)}`);
    }
}

async function addProfilesAndRun() {
    const accounts = readAccountsFile();
    const accountCount = accounts.length;
    if (accountCount === 0) {
        log('Nenhuma conta encontrada para adicionar e executar.', true);
        return;
    }

    log(`Starting to add and run ${accountCount} profiles from file.`);

    for (const [index, account] of accounts.entries()) {
        const [username, password, sharedSecret] = account.split(':');
        log(`Adding and running profile ${index + 1} of ${accountCount}: ${username}`);
        
        try {
            if (!username || !password || !sharedSecret) {
                throw new Error(`Invalid account format for ${account}`);
            }
            await addProfileSetup(username, password, sharedSecret);
            await autoRun(); // Run tasks for the added profile
            log(`Profile ${username} added and run successfully.`);
        } catch (error) {
            log(`Error adding and running profile ${username}: ${error.message}`);
        }
        
        if (index !== accounts.length - 1) {
            await sleep(30000); // Add delay to avoid throttling
        }
    }
    log('All profiles from file added and run completed');
}

async function checkAndSyncProfiles() {
    let profiles = await db.getAllProfiles();
    for (const profile of profiles) {
        log(`Verifying and syncing: ${profile.username} (${profile.steamId})`);
        let client = steamBot();
        try {
            const loggedIn = await loginWithRetries(client, profile);
            if (!loggedIn) {
                log(`[${profile.username}] Não foi possível autenticar para sincronização.`);
                continue;
            }

            let res = await syncWithRep4rep(client);
            if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
                log(`[${profile.username}] Synced to Rep4Rep`);
            } else {
                log(`[${profile.username}] Failed to sync: ${res}`);
            }
        } catch (error) {
            log(`[${profile.username}] Erro ao sincronizar: ${describeApiError(error)}`);

            log(`[${profile.username}] Erro ao sincronizar: ${describeApiError(error)}`);

            log(`[${profile.username}] Erro ao sincronizar: ${error.message}`);

        }
    }
    log('Check and sync completed');
}

async function checkCommentAvailability() {
    let profiles = await db.getAllProfiles();
    for (const profile of profiles) {
        let commentsInLast24Hours = await db.getCommentsInLast24Hours(profile.steamId);
        let commentsAvailable = Math.max(10 - commentsInLast24Hours, 0);
        log(`[${profile.username}] pode fazer mais ${commentsAvailable} comentários nas próximas 24 horas.`);
    }
    log('Verificação de disponibilidade de comentários concluída');
}

async function verifyProfileStatus() {
    const profiles = await db.getAllProfiles();
    for (const profile of profiles) {
        const client = steamBot();
        try {
            const cookies = parseStoredCookies(profile.cookies, profile.username);
            await client.steamLogin(
                profile.username,
                profile.password,
                null,
                profile.sharedSecret,
                null,
                cookies.length ? cookies : null
            );
            const isLoggedIn = client.status === 4 || await client.isLoggedIn();
            log(`[${profile.username}] ${isLoggedIn ? '✅ Logado' : '❌ Não logado'}`);
        } catch (err) {
            log(`[${profile.username}] ❌ Erro ao verificar login: ${err.message}`);
        }
    }
}

async function exportProfilesToCSV() {
    const profiles = await db.getAllProfiles();
    const lines = ['steamId,username,lastComment'];
    profiles.forEach(p => lines.push(`${p.steamId},${p.username},${p.lastComment}`));
    const filePath = path.join(__dirname, '..', 'exported_profiles.csv');
    fs.writeFileSync(filePath, lines.join('\n'));
    log(`Perfis exportados para: ${filePath}`);
}

async function clearInvalidAccounts() {
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(LOGS_DIR, `invalid-${date}.log`);
    if (!fs.existsSync(logFile)) return log('Nenhum arquivo de inválidos encontrado.');
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
        const username = line.split(' - ')[0].replace('[', '').split(']')[1].trim();
        await db.removeProfile(username);
        removeFromAccountsFile(username);
        log(`Removido inválido: ${username}`);
    }
    log('Perfis inválidos removidos.');
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
        const lastCommentMoment = profile.lastComment ? moment(profile.lastComment) : null;
        const diff = lastCommentMoment ? moment().diff(lastCommentMoment, 'hours') : Infinity;
        if (!lastCommentMoment || diff >= 24) {
            totals.ready++;
        } else {
            totals.coolingDown++;
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

async function resetProfileCookies() {
    const profiles = await db.getAllProfiles();
    for (const profile of profiles) {
        const client = steamBot();
        try {
            const loggedIn = await loginWithRetries(client, profile);
            if (!loggedIn) {
                log(`[${profile.username}] Não foi possível autenticar para atualizar cookies.`);
                continue;
            }

            const cookies = await client.getCookies();
            await db.updateCookies(profile.username, cookies);
            log(`[${profile.username}] Cookies atualizados`);
        } catch (err) {
            log(`[${profile.username}] Falha ao resetar cookies: ${err.message}`);
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

function backupDatabase() {
    const src = db.getDatabasePath();
    const destDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const dest = path.join(destDir, `db-${timestamp}.sqlite`);

    try {
        fs.copyFileSync(src, dest);
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
    loginWithRetries,
    statusMessage,
    showAllProfiles,
    addProfileSetup,
    authAllProfiles,
    removeProfile,
    autoRun,
    addProfilesFromFile,
    addProfilesAndRun,
    checkAndSyncProfiles,
    checkCommentAvailability,
    verifyProfileStatus,
    exportProfilesToCSV,
    clearInvalidAccounts,
    usageStats,
    collectUsageStats,
    resetProfileCookies,
    backupDatabase
};
