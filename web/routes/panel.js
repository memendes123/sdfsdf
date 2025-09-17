const express = require('express');
const router = express.Router();
const basicAuth = require('basic-auth');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const auth = require('../auth');

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

router.get('/run/:command', (req, res) => {
    const cmd = req.params.command;

    const commands = {
        autoRun: 'node ../main.cjs 3',
        stats: 'node ../main.cjs 12',
        backup: 'node ../main.cjs 14'
    };

    if (!commands[cmd]) return res.send('❌ Comando inválido.');

    exec(commands[cmd], (error, stdout, stderr) => {
        if (error) return res.send(`Erro: ${stderr}`);
        res.send(`<pre>${stdout}</pre>`);
    });
});

router.get('/logs', (req, res) => {
    const logDir = path.join(__dirname, '..', 'logs');
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
    const logs = files.map(f => ({
        name: f,
        content: fs.readFileSync(path.join(logDir, f), 'utf8')
    }));
    res.render('logs', { logs });
});

module.exports = router;