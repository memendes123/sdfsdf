// start.js
const { fork } = require('child_process');
const open = require('open');
const path = require('path');

// Caminhos relativos
const botPath = path.join(__dirname, 'main.cjs');
const panelPath = path.join(__dirname, 'web', 'server.js');

// Inicia o bot
console.log('[🔁] Iniciando BOT...');
fork(botPath);

// Inicia o painel
console.log('[🌐] Iniciando Painel Web...');
fork(panelPath);

// Aguarda e abre o navegador
setTimeout(() => {
    console.log('[🚀] Abrindo navegador...');
    open('http://localhost:3000'); // ou a porta que usares
}, 2000); // Espera 2s para garantir que o painel já está subindo
