const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initProxy } = require('./proxy');
const { createServer, refreshOfficialVersion, setOfficialVersion, setLastSyncTime, setSyncTrigger } = require('./server');
const { syncCursorPackages, abortSync, getSyncState, migrateExistingToWPS365 } = require('./downloader');

const config = require(path.resolve(__dirname, '../config.json'));

initProxy(config);

async function runSync(options = {}) {
  if (getSyncState().running) {
    console.log('[Sync] 检测到正在进行的同步，先终止再重新开始...');
    abortSync();
    const deadline = Date.now() + 30000;
    while (getSyncState().running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (getSyncState().running) {
      console.error('[Sync] 等待上一个同步结束超时，跳过本次');
      return;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${new Date().toLocaleString('zh-CN')}] Starting sync task...`);
  console.log('='.repeat(60));
  try {
    const result = await syncCursorPackages(config, options);
    if (result.version) setOfficialVersion(result.version);
    if (!result.aborted) setLastSyncTime(new Date().toISOString());
    if (result.skipped && !result.alreadyRunning) {
      console.log(`[Sync] Version ${result.version} is already up to date.`);
    } else if (!result.skipped) {
      const successCount = result.results?.filter((r) => r.success).length || 0;
      const totalCount = result.results?.length || 0;
      console.log(`[Sync] Finished. ${successCount}/${totalCount} packages for v${result.version}.`);
    }
  } catch (err) {
    console.error(`[Sync] Error: ${err.message}`);
  }
  console.log('='.repeat(60) + '\n');
}

setSyncTrigger((options) => runSync(options));

const syncCronExpressions = Array.isArray(config.cron)
  ? config.cron
  : [config.cron || '0 21 * * *'];

for (const expr of syncCronExpressions) {
  cron.schedule(expr, () => { runSync(); });
}
console.log(`[Cron] 拉取计划: ${syncCronExpressions.join(', ')}`);

cron.schedule('0 * * * *', () => { refreshOfficialVersion(); });
console.log('[Cron] 版本检查: 每个整点');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

let server = null;

const app = createServer(config);
const port = config.port || 6700;
server = app.listen(port, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`[Server] Cursor Mirror started:`);
  console.log(`  Local:   http://localhost:${port}`);
  if (ip) console.log(`  Network: http://${ip}:${port}`);
});

if (config.wps365?.enabled && config.wps365?.driveId) {
  console.log('[Init] WPS365 云端同步已启用，检查历史版本迁移...');
  migrateExistingToWPS365(config).catch(err => {
    console.error('[Init] Migration error:', err.message);
  });
}

if (config.runOnStart) {
  console.log('[Init] runOnStart=true, executing initial sync...');
  runSync();
}

function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);
  if (getSyncState().running) {
    abortSync();
  }
  const downloadDir = path.resolve(config.downloadDir || './downloads');
  const tmpVersion = path.join(downloadDir, 'version.json.tmp');
  try { if (fs.existsSync(tmpVersion)) fs.unlinkSync(tmpVersion); } catch {}

  if (server) {
    server.close(() => {
      console.log('[Shutdown] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('[Fatal] Unhandled promise rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});
