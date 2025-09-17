const { fork, spawn } = require('child_process');
const path = require('path');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2), {
  boolean: ['no-browser', 'nobrowser', 'noBrowser'],
  alias: {
    headless: 'no-browser',
  },
});

const hasNoBrowserFlag = args['no-browser'] === true;
const disableBrowser =
  hasNoBrowserFlag ||
  args.browser === false ||
  args.browser === 'false' ||
  args.nobrowser === true ||
  args.noBrowser === true;

const shouldOpenBrowser = !disableBrowser;

const botPath = path.join(__dirname, 'main.cjs');
const panelPath = path.join(__dirname, 'web', 'server.js');
const port = process.env.PORT || 3000;

function determineOpenCommand(url) {
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'start', '', url],
    };
  }

  if (process.platform === 'darwin') {
    return {
      command: 'open',
      args: [url],
    };
  }

  return {
    command: 'xdg-open',
    args: [url],
  };
}

function tryOpenBrowser(url) {
  const { command, args } = determineOpenCommand(url);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
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
    const url = `http://localhost:${port}`;
    tryOpenBrowser(url).catch((error) => {
      console.error('[❌] Não foi possível abrir o navegador automaticamente:', error);
      console.log('[ℹ️] Acesse manualmente:', url);
    });
  }, 2000);
} else {
  console.log(
    '[ℹ️] Painel disponível em http://localhost:%s (sem abrir navegador automático).',
    port
  );
}
