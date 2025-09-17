const { fork } = require('child_process');
const path = require('path');
const minimist = require('minimist');

const open = require('open');

const args = minimist(process.argv.slice(2), {
  boolean: ['no-browser', 'nobrowser', 'noBrowser'],
  alias: {
    headless: 'no-browser',
  },
});

const shouldOpenBrowser = !(
  args['no-browser'] || args.nobrowser || args.noBrowser || args.headless
);

const botPath = path.join(__dirname, 'main.cjs');
const panelPath = path.join(__dirname, 'web', 'server.js');

console.log('[🔁] Iniciando BOT...');
const botProcess = fork(botPath, { stdio: 'inherit' });

console.log('[🌐] Iniciando Painel Web...');
const panelProcess = fork(panelPath, { stdio: 'inherit' });

const shutdown = () => {
  console.log('\n[⏹️] Encerrando processos filhos...');
  botProcess.kill();
  panelProcess.kill();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (shouldOpenBrowser) {
  setTimeout(() => {
    console.log('[🚀] Abrindo navegador...');
    open(`http://localhost:${process.env.PORT || 3000}`);
  }, 2000);
} else {
  console.log('[ℹ️] Painel disponível em http://localhost:%s (sem abrir navegador automático).', process.env.PORT || 3000);
}
