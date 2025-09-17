const fs = require('fs');
const path = require('path');
const db = require('./db.cjs');
const api = require('./api.cjs');
const steamBot = require('./steamBot.cjs');
const { table } = require('table');
const ReadLine = require('readline');
const moment = require('moment');
require('dotenv').config();

let rl = ReadLine.createInterface({
    input: process.stdin,
    output: process.stdout
});

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
    const logDir = path.join(__dirname, '..', 'logs');
    const logFile = path.join(logDir, `${date}.log`);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${username} - Success: ${success} | Fail: ${fail}\n`;
    fs.appendFileSync(logFile, line);
}

function logInvalidAccount(username, reason) {
    const date = new Date().toISOString().split('T')[0];
    const logDir = path.join(__dirname, '..', 'logs');
    const logFile = path.join(logDir, `invalid-${date}.log`);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ${username} - ${reason}\n`;
    fs.appendFileSync(logFile, line);
}

function removeFromAccountsFile(username) {
    const filePath = path.join(__dirname, '..', 'accounts.txt');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const filtered = lines.filter(line => !line.startsWith(username + ':'));
    fs.writeFileSync(filePath, filtered.join('\n'));
}

async function autoRun() {
    const accounts = fs.readFileSync('accounts.txt', 'utf-8').split('\n').filter(Boolean);
    let profiles = await db.getAllProfiles();
    let r4rProfiles = await api.getSteamProfiles();

    for (const [i, account] of accounts.entries()) {
        const [username, password, sharedSecret] = account.split(':');
        if (!username || !password || !sharedSecret) {
            log(`Invalid account format for ${account}`);
            continue;
        }
        
        log(`Attempting to leave comments from: ${username}`);

        let profile = profiles.find(p => p.username === username);
        if (!profile) {
            log(`Profile not found in database for username: ${username}`);
            continue;
        }

        let hours = moment().diff(moment(profile.lastComment), 'hours');
        if (!profile.lastComment || hours >= 24) {
            let r4rSteamProfile = r4rProfiles.find(r4rProfile => r4rProfile['steamId'] == profile.steamId);
            if (!r4rSteamProfile) {
                log(`[${username}] steamProfile doesn't exist on rep4rep`);
                log(`Try syncing it with --auth-profiles`, true);
                continue;
            }

            let tasks = await api.getTasks(r4rSteamProfile.id);
            if (!tasks || tasks.length === 0) {
                log(`[${username}] No tasks found for the profile. Skipping...`, true);
                continue;
            }

            let client = steamBot();
            await loginWithRetries(client, username, password, sharedSecret, profile.cookies);
            if (client.status !== 4 && !await client.isLoggedIn()) {
                log(`[${username}] is logged out. reAuth needed`, true);
                continue;
            } else {
                await autoRunComments(profile, client, tasks, r4rSteamProfile.id, 10);
                if (i !== accounts.length - 1) {
                    await sleep(process.env.LOGIN_DELAY);
                }
                continue;
            }
        } else {
            log(`[${username}] is not ready yet`);
            log(`[${username}] try again in: ${Math.round(24 - hours)} hours`, true);
            continue;
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

        try {
            await client.postComment(task.targetSteamProfileId, task.requiredCommentText);
            await api.completeTask(task.taskId, task.requiredCommentId, authorSteamProfileId);
            await db.updateLastComment(profile.steamId);
            log(`[${profile.username}] comment posted and marked as completed`, true);
            commentsPosted++;
            completedTasks.add(task.taskId);
            consecutiveFailures = 0; // Reset failures on success
        } catch (err) {
            log(`[${profile.username}] failed to post comment: ${err.message}`);
            log(`Debug Info: TargetSteamProfileId: ${task.targetSteamProfileId}, RequiredCommentText: ${task.requiredCommentText}`);
            consecutiveFailures++;
        }

        await sleep(process.env.COMMENT_DELAY);
    }

    while (commentsPosted < maxComments && consecutiveFailures < maxConsecutiveFailures && attempts < maxAttempts) {
        log(`[${profile.username}] Attempting additional comment ${commentsPosted + 1}/${maxComments}`);
        let additionalTasks = await api.getTasks(authorSteamProfileId); // Fetch new tasks to ensure updated list
        additionalTasks = additionalTasks.filter(t => !completedTasks.has(t.taskId));

        if (additionalTasks.length === 0) {
            log(`[${profile.username}] No valid tasks available for additional comments. Retrying... (${attempts + 1}/${maxAttempts})`, true);
            attempts++;
            await sleep(process.env.COMMENT_DELAY);
            continue;
        }

        for (const randomTask of additionalTasks) {
            if (!randomTask || !randomTask.requiredCommentText || !randomTask.targetSteamProfileId) {
                log(`[${profile.username}] Invalid random task for additional comments. Skipping...`, true);
                continue;
            }

            const randomComment = randomTask.requiredCommentText;
            const targetSteamProfileId = randomTask.targetSteamProfileId;
            try {
                await client.postComment(targetSteamProfileId, randomComment);
                await api.completeTask(randomTask.taskId, randomTask.requiredCommentId, authorSteamProfileId); // Mark additional comments as completed
                commentsPosted++;
                log(`[${profile.username}] additional comment posted successfully`, true);
                consecutiveFailures = 0; // Reset failures on success
                attempts = 0; // Reset attempts on success
                completedTasks.add(randomTask.taskId); // Mark task as completed
                break; // Exit the for loop to attempt the next comment
            } catch (err) {
                log(`[${profile.username}] failed to post additional comment: ${err.message}`);
                log(`Debug Info: TargetSteamProfileId: ${targetSteamProfileId}, RandomComment: ${randomComment}`);
                consecutiveFailures++;
            }
            await sleep(process.env.COMMENT_DELAY);
        }
        attempts++;
    }

    log(`[${profile.username}] done with posting comments. Total comments posted: ${commentsPosted}`, true);
}

async function loginWithRetries(client, username, password, sharedSecret, cookies, maxRetries = 3) {
    let attempts = 0;
    let fatalError = null;

    while (attempts < maxRetries) {
        try {
            await client.steamLogin(username, password, null, sharedSecret, null, JSON.parse(cookies));
            if (client.status === 4 || await client.isLoggedIn()) {
                log(`[${username}] login successful`);
                return;
            }
        } catch (error) {
            const msg = error.message || '';
            log(`[${username}] login attempt ${attempts + 1} failed: ${msg}`);

            if (
                msg.includes('Invalid') ||
                msg.includes('denied') ||
                msg.includes('banned') ||
                msg.includes('RateLimit') ||
                msg.includes('Throttle') ||
                msg.includes('too many')
            ) {
                fatalError = msg;
                break;
            }

            if (error.code === 502) {
                log(`[${username}] WebAPI error 502. Retrying...`);
                await sleep(10000);
            } else {
                throw error;
            }
        }
        attempts++;
    }

    if (fatalError) {
        log(`[${username}] login failed permanently: ${fatalError}`);
        logInvalidAccount(username, fatalError);

        const profile = await db.getAllProfiles().then(p => p.find(p => p.username === username));
        if (profile?.steamId) await removeFromRep4Rep(profile.steamId);

        await db.removeProfile(username);
        removeFromAccountsFile(username);
        return;
    }

    throw new Error(`[${username}] login failed after ${maxRetries} attempts.`);
}


async function sleep(millis) {
    let sec = Math.round(millis / 1000);
    log(`[ ${sec}s delay ] ...`, true);
    return new Promise(resolve => setTimeout(resolve, millis));
}

async function authAllProfiles() {
    let profiles = await db.getAllProfiles();
    for (const [i, profile] of profiles.entries()) {
        log(`Attempting to auth: ${profile.username} (${profile.steamId})`);
        let client = steamBot();
        await loginWithRetries(client, profile);
        if (client.status !== 4 && !await client.isLoggedIn()) {
            let code = await client.getSteamGuardCode(profile.sharedSecret);
            switch (client.status) {
                case 1:
                    await client.steamLogin(profile.username, profile.password, code);
                    break;
                case 2:
                    await client.steamLogin(profile.username, profile.password, null, code);
                    break;
                case 3:
                    await client.steamLogin(profile.username, profile.password, null, null, code);
                    break;
            }
        }

        log(`[${profile.username}] Authorized`);

        let res = await syncWithRep4rep(client);
        if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
            log(`[${profile.username}] Synced to Rep4Rep`, true);
        } else {
            log(`[${profile.username}] Failed to sync:`);
            log(res, true);
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
        console.log("steamProfiles:", steamProfiles); // Add this log to inspect the retrieved profiles
    } catch (error) {
        console.error("Error retrieving steamProfiles:", error);
        return `Error retrieving steamProfiles: ${error.message}`;
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
            console.error("Error adding steamProfile:", error);
            return `Error adding steamProfile: ${error.message}`;
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

            if (client.status !== 4 && !await client.isLoggedIn()) {
                let code = await client.getSteamGuardCode(sharedSecret);
                switch (client.status) {
                    case 1:
                        await addProfileSetup(accountName, password, code);
                        return;
                    case 2:
                        await addProfileSetup(accountName, password, null, code);
                        return;
                    case 3:
                        await addProfileSetup(accountName, password, null, null, code);
                        return;
                }
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
            if (error.message.includes('RateLimitExceeded')) {
                log(`Rate limit exceeded for ${accountName}. Waiting before retrying...`);
                await sleep(30000); // wait 1 minute before retrying
            } else {
                log(`Error adding profile ${accountName}: ${error.message}`);
                break;
            }
        }
    }

    if (!success) {
        log(`Failed to add profile ${accountName} after ${maxAttempts} attempts.`);
    }
}

async function removeProfile(username) {
    let res = await db.removeProfile(username);
    if (res.changes == 0) {
        log('profile not found', true);
    } else {
        log('profile removed', true);
    }
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
        rl.question('>> ', resolve);
    });
    return res;
}

// src/util.cjs

async function addProfilesFromFile() {
    const accounts = fs.readFileSync('accounts.txt', 'utf-8').split('\n').filter(Boolean);
    let accountCount = accounts.length;
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
        const match = profiles.find(p => p.steamId === steamId);
        if (match) {
            await fetch(`https://rep4rep.com/pub-api/user/steamprofiles/remove`, {
                method: 'POST',
                body: api.buildForm({ steamProfile: steamId }),
            });
            log(`[Rep4Rep] Removed steamId: ${steamId}`);
        }
    } catch (err) {
        log(`[ERROR] Failed to remove from Rep4Rep: ${err.message}`);
    }
}

async function addProfilesAndRun() {
    const accounts = fs.readFileSync('accounts.txt', 'utf-8').split('\n').filter(Boolean);
    let accountCount = accounts.length;
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
        let res = await syncWithRep4rep(client);
        if (res === true || res === 'Steam profile already added/exists on rep4rep.') {
            log(`[${profile.username}] Synced to Rep4Rep`);
        } else {
            log(`[${profile.username}] Failed to sync: ${res}`);
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
            await client.steamLogin(profile.username, profile.password, null, profile.sharedSecret, null, JSON.parse(profile.cookies));
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
    const logFile = path.join(__dirname, '..', 'logs', `invalid-${date}.log`);
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

async function usageStats() {
    const profiles = await db.getAllProfiles();
    const total = profiles.length;
    let ativos = 0, inativos = 0, comentariosHoje = 0;

    for (const p of profiles) {
        const diff = moment().diff(moment(p.lastComment), 'hours');
        if (!p.lastComment || diff >= 24) inativos++;
        else ativos++;
        const count = await db.getCommentsInLast24Hours(p.steamId);
        comentariosHoje += count;
    }

    log('📊 Estatísticas de Uso:');
    log(`Total perfis: ${total}`);
    log(`Perfis ativos (prontos para comentar): ${inativos}`);
    log(`Perfis aguardando cooldown: ${ativos}`);
    log(`Total de comentários nas últimas 24h: ${comentariosHoje}`);
}

async function resetProfileCookies() {
    const profiles = await db.getAllProfiles();
    for (const profile of profiles) {
        const client = steamBot();
        try {
            await client.steamLogin(profile.username, profile.password, null, profile.sharedSecret, null);
            const cookies = await client.getCookies();
            await db.updateCookies(profile.username, JSON.stringify(cookies));
            log(`[${profile.username}] Cookies atualizados`);
        } catch (err) {
            log(`[${profile.username}] Falha ao resetar cookies: ${err.message}`);
        }
    }
}

function backupDatabase() {
    const src = path.join(__dirname, '..', 'db.sqlite');
    const destDir = path.join(__dirname, '..', 'backups');
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir);
    const dest = path.join(destDir, `db-${timestamp}.sqlite`);
    fs.copyFileSync(src, dest);
    log(`📦 Backup criado em: ${dest}`);
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
    resetProfileCookies,
    backupDatabase
};
