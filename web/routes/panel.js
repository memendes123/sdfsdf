const express = require('express');
const router = express.Router();
const basicAuth = require('basic-auth');
const fs = require('fs');
const path = require('path');
const auth = require('../auth');
const {
    autoRun,
    collectUsageStats,
    backupDatabase
} = require('../../src/util.cjs');

router.use((req, res, next) => {
    const user = basicAuth(req);
    if (!auth(user)) {
        res.set('WWW-Authenticate', 'Basic realm="Painel Rep4Rep"');
        return res.status(401).send('Auth required.');
    }
    next();
});

router.get('/', (req, res) => {
    res.render('dashboard');
});

router.get('/run/:command', async (req, res) => {
    const cmd = req.params.command;

    const handlers = {
        autoRun: async () => {
            await autoRun();
            return '✅ autoRun concluído. Verifique os logs para detalhes.';
        },
        stats: async () => {
            const stats = await collectUsageStats();
            return [
                '📊 Estatísticas de Uso',
                `Total de perfis: ${stats.total}`,
                `Perfis prontos para comentar: ${stats.ready}`,
                `Perfis aguardando cooldown: ${stats.coolingDown}`,
                `Comentários nas últimas 24h: ${stats.commentsLast24h}`
            ].join('\n');
        },
        backup: async () => {
            const filePath = backupDatabase();
            return `📦 Backup criado em: ${filePath}`;
        }
    };

    const handler = handlers[cmd];
    if (!handler) {
        return res.status(400).send('❌ Comando inválido.');
    }

    try {
        const output = await handler();
        res.type('text/plain').send(output);
    } catch (error) {
        console.error(`[Painel] Falha ao executar comando ${cmd}:`, error);
        res.status(500).send(`Erro ao executar comando: ${error.message}`);
    }
});

router.get('/logs', (req, res) => {
    const logDir = path.join(__dirname, '..', '..', 'logs');

    if (!fs.existsSync(logDir)) {
        return res.render('logs', { logs: [] });
    }

    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
    const logs = files.map(f => ({
        name: f,
        content: fs.readFileSync(path.join(logDir, f), 'utf8')
    }));

    res.render('logs', { logs });
});

module.exports = router;
