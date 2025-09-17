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

const hasNoBrowserFlag = Object.prototype.hasOwnProperty.call(args, 'no-browser');
const disableBrowser =
  hasNoBrowserFlag ||
  args.browser === false ||
  args.nobrowser === true ||
  args.noBrowser === true;

const shouldOpenBrowser = !disableBrowser;

const botPath = path.join(__dirname, 'main.cjs');
const panelPath = path.join(__dirname, 'web', 'server.js');
const port = process.env.PORT || 3000;

let openModulePromise = null;
function loadOpenModule() {
  if (!openModulePromise) {
    openModulePromise = import('open').then((module) => module.default || module);
  }
  return openModulePromise;
}

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
    loadOpenModule()
      .then((openBrowser) => openBrowser(`http://localhost:${port}`))
      .catch((error) => {
        console.error('[❌] Não foi possível abrir o navegador automaticamente:', error);
        console.log('[ℹ️] Acesse manualmente:', `http://localhost:${port}`);
      });
  }, 2000);
} else {
  console.log(
    '[ℹ️] Painel disponível em http://localhost:%s (sem abrir navegador automático).',
    port
  );
}
