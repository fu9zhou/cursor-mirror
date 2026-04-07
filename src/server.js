const express = require('express');
const path = require('path');
const fs = require('fs');
const { syncEmitter, getSyncState, abortSync, readVersionStore, migrateExistingToWPS365, refreshCloudInfoFile } = require('./downloader');
const { fetchLatestVersion } = require('./scraper');

let cachedOfficialVersion = null;
let triggerSync = null;
let lastCheckTime = null;
let lastSyncTime = null;
let storedConfig = null;

function refreshOfficialVersion() {
  fetchLatestVersion()
    .then(({ fullVersion }) => {
      cachedOfficialVersion = fullVersion;
      lastCheckTime = new Date().toISOString();
      console.log(`[VersionCheck] Official latest: ${fullVersion}`);

      if (storedConfig) {
        refreshCloudInfoFile(storedConfig, {
          lastCheckTime,
          lastSyncTime,
          officialVersion: fullVersion,
        }).catch(err => {
          console.error(`[VersionCheck] 更新云端信息文件失败: ${err.message}`);
        });
      }
    })
    .catch((err) => {
      console.error(`[VersionCheck] Failed to fetch official version: ${err.message}`);
    });
}

function setOfficialVersion(v) { cachedOfficialVersion = v; }

function setLastSyncTime(t) { lastSyncTime = t; }

function setSyncTrigger(fn) { triggerSync = fn; }

function readVersionData(downloadDir) {
  const store = readVersionStore(downloadDir);
  const currentEntry = store.history.find(h => h.version === store.current);
  const olderVersions = store.history.filter(h => h.version !== store.current);

  return {
    version: store.current,
    files: currentEntry?.files || [],
    updatedAt: currentEntry?.updatedAt || null,
    history: olderVersions,
  };
}

function parseCronTimes(cronConfig) {
  const cronList = Array.isArray(cronConfig) ? cronConfig : [cronConfig || '0 21 * * *'];
  return cronList.map((c) => {
    const parts = c.split(' ');
    if (parts.length >= 2) return `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
    return c;
  }).join(' / ');
}

function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function localOnly(req, res, next) {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ ok: false, msg: 'Forbidden: local access only' });
  }
  next();
}

function createServer(config) {
  storedConfig = config;
  const app = express();
  app.set('trust proxy', false);
  const downloadDir = path.resolve(config.downloadDir || './downloads');

  refreshOfficialVersion();

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/page-data', (req, res) => {
    const data = readVersionData(downloadDir);
    const state = getSyncState();
    res.json({
      version: data.version,
      files: data.files,
      updatedAt: data.updatedAt,
      history: data.history,
      officialVersion: cachedOfficialVersion,
      syncing: state.running,
      lastCheckTime,
      lastSyncTime: lastSyncTime || data.updatedAt || null,
      checkSchedule: '每个整点',
      syncSchedule: parseCronTimes(config.cron),
    });
  });

  app.get('/api/status', (req, res) => {
    const data = readVersionData(downloadDir);
    const state = getSyncState();
    res.json({ ...data, officialVersion: cachedOfficialVersion, syncing: state.running });
  });

  app.post('/api/check-version', localOnly, async (req, res) => {
    try {
      const { fullVersion } = await fetchLatestVersion();
      cachedOfficialVersion = fullVersion;
      lastCheckTime = new Date().toISOString();
      console.log(`[VersionCheck] Manual check: ${fullVersion}`);

      if (storedConfig) {
        refreshCloudInfoFile(storedConfig, {
          lastCheckTime,
          lastSyncTime,
          officialVersion: fullVersion,
        }).catch(err => {
          console.error(`[VersionCheck] 更新云端信息文件失败: ${err.message}`);
        });
      }

      res.json({ ok: true, version: fullVersion, lastCheckTime });
    } catch (err) {
      console.error(`[VersionCheck] Manual check failed: ${err.message}`);
      res.json({ ok: false, msg: err.message });
    }
  });

  app.post('/api/sync/trigger', localOnly, (req, res) => {
    if (!triggerSync) {
      return res.json({ ok: false, msg: '同步函数未注册' });
    }
    const state = getSyncState();
    const msg = state.running ? '正在终止当前同步并重新开始...' : '同步任务已触发';
    triggerSync({ force: true });
    res.json({ ok: true, msg });
  });

  app.post('/api/sync/abort', localOnly, (req, res) => {
    const state = getSyncState();
    if (!state.running) {
      return res.json({ ok: false, msg: '当前没有同步任务' });
    }
    abortSync();
    res.json({ ok: true, msg: '终止信号已发送' });
  });

  app.post('/api/sync/migrate', localOnly, (req, res) => {
    migrateExistingToWPS365(config).catch(err => {
      console.error('[Migrate] Error:', err.message);
    });
    res.json({ ok: true, msg: '迁移任务已触发，请查看日志' });
  });

  app.get('/api/sync/stream', localOnly, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const state = getSyncState();
    for (const entry of state.logs) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: 'status', running: state.running })}\n\n`);

    function safeWrite(data) {
      try { if (!res.writableEnded) res.write(data); } catch {}
    }
    const onLog = (entry) => safeWrite(`data: ${JSON.stringify(entry)}\n\n`);
    const onDone = () => safeWrite(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    const onAborted = () => safeWrite(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);

    syncEmitter.on('log', onLog);
    syncEmitter.on('done', onDone);
    syncEmitter.on('aborted', onAborted);
    req.on('close', () => {
      syncEmitter.off('log', onLog);
      syncEmitter.off('done', onDone);
      syncEmitter.off('aborted', onAborted);
    });
  });

  app.get('/download/:version/:filename', (req, res) => {
    const { version, filename } = req.params;
    const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(downloadDir, safeVersion, safeFilename);
    if (!filePath.startsWith(downloadDir) || !fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }
    res.download(filePath, safeFilename, (err) => {
      if (err && !res.headersSent) {
        res.status(500).send('Download failed');
      }
    });
  });

  return app;
}

module.exports = { createServer, refreshOfficialVersion, setOfficialVersion, setLastSyncTime, setSyncTrigger };
