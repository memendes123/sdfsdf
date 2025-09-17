
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
    resetProfileCookies,
    backupDatabase,
    scheduleAutomaticBackups,
    keepBotAliveInteractive,
    closeReadline
} = require('./src/util.cjs');

require('dotenv').config();
scheduleAutomaticBackups();
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

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
    log("0. Sair", true);

    rl.question("Escolha uma opção: ", async (opt) => {
        switch (opt.trim()) {
            case "1":
                await showAllProfiles();
                break;
            case "2":
                await authAllProfiles();
                break;
            case "3":
                await prioritizedAutoRun({
                    accountLimit: 100,
                    maxCommentsPerAccount: 1000,
                    clientFilter: (user) => user.role !== 'admin',
                });
                break;
            case "4":
                await addProfilesFromFile();
                break;
            case "5":
                await addProfilesAndRun();
                break;
            case "15":
                await runFullCycle({
                    maxAccounts: 100,
                    maxCommentsPerAccount: 1000,
                });
                break;
            case "6":
                rl.question("Usuário a remover: ", async (username) => {
                    try {
                        await removeProfile(username.trim());
                    } catch (error) {
                        if (!error?.logged) {
                            log(`❌ Falha ao remover perfil: ${error.message}`, true);
                        }
                    }
                    setTimeout(mainMenu, 1000);
                });
                return;
            case "7":
                await checkAndSyncProfiles();
                break;
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
            case "16":
                closeReadline();
                await keepBotAliveInteractive();
                return;
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
