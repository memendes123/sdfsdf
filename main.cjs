
const {
    log,
    showAllProfiles,
    addProfileSetup,
    authAllProfiles,
    removeProfile,
    autoRun,
    addProfilesFromFile,
    addProfilesAndRun,
    runFullCycle,
    prioritizedAutoRun,
    checkAndSyncProfiles,
    checkCommentAvailability,
    verifyProfileStatus,
    exportProfilesToCSV,
    clearInvalidAccounts,
    usageStats,
    showQueueSnapshot,
    resetProfileCookies,
    backupDatabase,
    scheduleAutomaticBackups,
    keepBotAliveInteractive,
    closeReadline,
    getEnvRep4RepKey
} = require('./src/util.cjs');

require('dotenv').config();
scheduleAutomaticBackups();
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let cliTokenReadyLogged = false;
function getCliApiToken(options = {}) {
    const token = getEnvRep4RepKey();
    if (token) {
        if (!cliTokenReadyLogged) {
            log("🔐 Usando token do .env para as operações do terminal.");
            cliTokenReadyLogged = true;
        }
        return token;
    }

    if (options.required) {
        log("⚠️ Defina REP4REP_KEY no arquivo .env para executar este comando pelo terminal.");
    }

    return null;
}

async function mainMenu() {
    log("Rep4Rep Bot CLI");
    log("==================");
    log("1. Mostrar perfis");
    log("2. Autorizar todos perfis");
    log("3. Executar autoRun prioritário");
    log("4. Adicionar perfis do arquivo");
    log("5. Adicionar perfis e rodar");
    log("6. Remover perfil");
    log("7. Verificar e sincronizar perfis");
    log("8. Verificar disponibilidade de comentários");
    log("9. Verificar status dos perfis");
    log("10. Exportar perfis para CSV");
    log("11. Limpar contas inválidas");
    log("12. Estatísticas de uso");
    log("13. Resetar cookies dos perfis");
    log("14. Backup do banco de dados");
    log("15. Ciclo completo (adicionar, rodar e remover)");
    log("16. Ativar modo vigia (loop automático)");
    log("17. Ver fila de execuções");
    log("0. Sair", true);

    rl.question("Escolha uma opção: ", async (opt) => {
        switch (opt.trim()) {
            case "1":
                await showAllProfiles();
                break;
            case "2":
                await authAllProfiles();
                break;
            case "3": {
                const token = getCliApiToken({ required: true });
                if (!token) {
                    break;
                }
                await prioritizedAutoRun({
                    accountLimit: 100,
                    maxCommentsPerAccount: 1000,
                    clientFilter: (user) => user.role !== 'admin',
                    ownerToken: token
                });
                break;
            }
            case "4": {
                const token = getCliApiToken({ required: true });
                if (!token) {
                    break;
                }
                await addProfilesFromFile({ apiToken: token });
                break;
            }
            case "5": {
                const token = getCliApiToken({ required: true });
                if (!token) {
                    break;
                }
                await addProfilesAndRun({ apiToken: token });
                break;
            }
            case "6":
                rl.question("Usuário a remover: ", async (username) => {
                    try {
                        const token = getCliApiToken();
                        await removeProfile(username.trim(), { apiToken: token });
                    } catch (error) {
                        if (!error?.logged) {
                            log(`❌ Falha ao remover perfil: ${error.message}`, true);
                        }
                    }
                    setTimeout(mainMenu, 1000);
                });
                return;
            case "7": {
                const token = getCliApiToken({ required: true });
                if (!token) {
                    break;
                }
                await checkAndSyncProfiles({ apiToken: token });
                break;
            }
            case "8":
                await checkCommentAvailability();
                break;
            case "9":
                await verifyProfileStatus();
                break;
            case "10":
                await exportProfilesToCSV();
                break;
            case "11":
                await clearInvalidAccounts();
                break;
            case "12":
                await usageStats();
                break;
            case "13":
                await resetProfileCookies();
                break;
            case "14":
                await backupDatabase();
                break;
            case "15": {
                const token = getCliApiToken({ required: true });
                if (!token) {
                    break;
                }
                await runFullCycle({
                    maxAccounts: 100,
                    maxCommentsPerAccount: 1000,
                    apiToken: token
                });
                break;
            }
            case "16": {
                const token = getCliApiToken({ required: true });
                if (!token) {
                    break;
                }
                closeReadline();
                await keepBotAliveInteractive({ ownerToken: token });
                return;
            }
            case "17":
                await showQueueSnapshot();
                break;
            case "0":
                rl.close();
                return;
            default:
                log("Opção inválida!");
        }
        setTimeout(mainMenu, 1000);
    });
}

mainMenu();
