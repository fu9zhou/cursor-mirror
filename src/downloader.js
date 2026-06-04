const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const { fetchLatestVersion, getDownloadList } = require('./scraper');
const { getProxyAgent } = require('./proxy');
const { isCliAvailable, ensureFolder, uploadFile, updateInfoFile, shareFile, setLogger } = require('./uploader');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

const syncEmitter = new EventEmitter();
syncEmitter.setMaxListeners(50);
let syncState = { running: false, aborted: false, logs: [], activeReq: null };

function emitLog(msg) {
  const entry = { time: new Date().toISOString(), msg };
  syncState.logs.push(entry);
  if (syncState.logs.length > 200) syncState.logs.shift();
  console.log(msg);
  syncEmitter.emit('log', entry);
}

setLogger(emitLog);

function getSyncState() { return syncState; }

function abortSync() {
  if (!syncState.running) return;
  syncState.aborted = true;
  if (syncState.activeReq) {
    syncState.activeReq.destroy(new Error('Sync aborted by user'));
    syncState.activeReq = null;
  }
  emitLog('[Sync] 收到终止信号，正在停止...');
}

function readVersionStore(downloadDir) {
  const versionFile = path.join(downloadDir, 'version.json');
  if (!fs.existsSync(versionFile)) {
    return { current: null, history: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
    if (raw.version && !raw.current) {
      return {
        current: raw.version,
        history: [{
          version: raw.version,
          updatedAt: raw.updatedAt,
          files: raw.files || [],
        }],
      };
    }
    return {
      current: raw.current || null,
      history: raw.history || [],
    };
  } catch {
    return { current: null, history: [] };
  }
}

function writeVersionStore(downloadDir, store) {
  const versionFile = path.join(downloadDir, 'version.json');
  const tmpFile = versionFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmpFile, versionFile);
}

function cleanupTempFiles(dir) {
  if (!fs.existsSync(dir)) return;
  const tmpFiles = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(path.join(dir, f));
      emitLog(`[Cleanup] 清理未完成的临时文件: ${f}`);
    } catch {}
  }
}

function resolveFilename(platformKey, contentType, contentDisposition, finalUrl) {
  if (contentDisposition) {
    const match = contentDisposition.match(/filename[^;=\n]*=["']?([^"';\n]+)/i);
    if (match && match[1]) return match[1].trim();
  }

  if (finalUrl) {
    try {
      const urlPath = new URL(finalUrl).pathname;
      const urlFilename = path.basename(urlPath);
      if (urlFilename && /\.\w{2,10}$/.test(urlFilename)) return urlFilename;
    } catch {}
  }

  let ext = '.bin';
  if (platformKey.includes('deb')) ext = '.deb';
  else if (platformKey.includes('rpm')) ext = '.rpm';
  else if (platformKey.startsWith('darwin')) ext = '.dmg';
  else if (platformKey.startsWith('win32')) ext = '.exe';
  else if (platformKey.startsWith('linux-') && !platformKey.includes('deb') && !platformKey.includes('rpm')) ext = '.AppImage';
  else if (contentType) {
    if (contentType.includes('dmg') || contentType.includes('apple-diskimage')) ext = '.dmg';
    else if (contentType.includes('exe') || contentType.includes('msdos')) ext = '.exe';
  }

  return `${platformKey}${ext}`;
}

function httpHead(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    const agent = getProxyAgent();
    const opts = {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    };
    if (agent) opts.agent = agent;

    const req = client.request(url, opts, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpHead(res.headers.location, maxRedirects - 1));
      }
      resolve({
        finalUrl: url,
        headers: {
          get: (name) => res.headers[name.toLowerCase()] || '',
        },
      });
    });
    req.on('timeout', () => { req.destroy(new Error('HEAD timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function httpDownload(url, destPath, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (syncState.aborted) return reject(new Error('Sync aborted by user'));
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const client = url.startsWith('https') ? https : http;
    const agent = getProxyAgent();
    const opts = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 30000,
    };
    if (agent) opts.agent = agent;
    const req = client.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        syncState.activeReq = null;
        return resolve(httpDownload(res.headers.location, destPath, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        syncState.activeReq = null;
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const expectedSize = parseInt(res.headers['content-length'], 10) || 0;
      let downloaded = 0;
      let lastLog = Date.now();

      const monitor = new PassThrough();
      monitor.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastLog > 10000) {
          const pct = expectedSize ? ((downloaded / expectedSize) * 100).toFixed(1) : '?';
          emitLog(`    进度: ${formatSize(downloaded)}/${expectedSize ? formatSize(expectedSize) : '?'} (${pct}%)`);
          lastLog = now;
        }
      });

      const fileStream = fs.createWriteStream(destPath);

      pipeline(res, monitor, fileStream)
        .then(() => {
          syncState.activeReq = null;
          const stats = fs.statSync(destPath);
          resolve({ size: stats.size, expectedSize, success: true });
        })
        .catch((err) => {
          syncState.activeReq = null;
          reject(err);
        });
    });

    syncState.activeReq = req;
    req.on('timeout', () => { req.destroy(new Error('Connection timeout')); });
    req.on('error', (err) => { syncState.activeReq = null; reject(err); });
  });
}

async function downloadFile(url, destPath, retries = MAX_RETRIES) {
  const tmpPath = destPath + '.tmp';
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (syncState.aborted) return { size: 0, expectedSize: 0, success: false, error: 'Sync aborted' };
    try {
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const result = await httpDownload(url, tmpPath);

      if (result.expectedSize > 0 && result.size !== result.expectedSize) {
        throw new Error(
          `完整性校验失败: 预期 ${formatSize(result.expectedSize)}, 实际 ${formatSize(result.size)}`
        );
      }

      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.renameSync(tmpPath, destPath);

      return result;
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      if (syncState.aborted) return { size: 0, expectedSize: 0, success: false, error: 'Sync aborted' };
      emitLog(`  [重试 ${attempt}/${retries}] 失败: ${err.message}`);
      if (attempt < retries) {
        const delay = RETRY_DELAY_MS * attempt;
        emitLog(`  ${delay / 1000}s 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        return { size: 0, expectedSize: 0, success: false, error: err.message };
      }
    }
  }
  return { size: 0, expectedSize: 0, success: false, error: 'All retries exhausted' };
}

async function resolveRootFolder(wps) {
  if (wps.useParentAsRoot && wps.parentFolderId && wps.parentFolderId !== '0') {
    return wps.parentFolderId;
  }
  const rootName = wps.rootFolderName || 'cursor-mirror';
  const parentId = wps.parentFolderId || '0';
  return await ensureFolder(wps.driveId, parentId, rootName);
}

async function initWPS365(config, fullVersion) {
  const wps = config.wps365;
  if (!wps || !wps.enabled || !wps.driveId) return null;

  if (!isCliAvailable()) {
    emitLog('[WPS365] wps365-cli 未安装或不可用，本次仅本地存储');
    return null;
  }

  try {
    const rootName = wps.rootFolderName || 'cursor-mirror';
    const label = wps.useParentAsRoot ? `共享文件夹/${fullVersion}` : `${rootName}/${fullVersion}`;
    emitLog(`[WPS365] 初始化云端存储: ${label}`);
    const rootFolderId = await resolveRootFolder(wps);
    const versionFolderId = await ensureFolder(wps.driveId, rootFolderId, fullVersion);
    return { driveId: wps.driveId, versionFolderId, rootFolderId };
  } catch (err) {
    emitLog(`[WPS365] 初始化失败: ${err.message}，本次仅本地存储`);
    return null;
  }
}

async function syncCursorPackages(config, options = {}) {
  if (syncState.running) {
    emitLog('[Sync] 同步任务正在进行中，跳过重复触发');
    return { skipped: true, version: null, alreadyRunning: true };
  }

  syncState.running = true;
  syncState.aborted = false;
  syncState.logs = [];
  syncState.activeReq = null;

  const force = !!options.force;

  try {
    const downloadDir = path.resolve(config.downloadDir || './downloads');

    emitLog('[Sync] 正在获取 Cursor 最新版本...');
    const { apiVersion, fullVersion } = await fetchLatestVersion();
    emitLog(`[Sync] 官方最新版本: ${fullVersion} (API: ${apiVersion})`);

    if (syncState.aborted) {
      emitLog('[Sync] 同步已被终止');
      syncEmitter.emit('aborted');
      return { skipped: true, version: fullVersion, aborted: true };
    }

    const store = readVersionStore(downloadDir);
    const localVersion = store.current;
    emitLog(`[Sync] 本地镜像版本: ${localVersion || '无'}`);

    const downloadList = getDownloadList(apiVersion, config);
    const isNewVersion = localVersion !== fullVersion;

    if (!isNewVersion) {
      const versionDir = path.join(downloadDir, fullVersion);
      const currentEntry = store.history.find(h => h.version === fullVersion);
      const storedFiles = currentEntry?.files || [];
      let invalidCount = 0;

      for (const sf of storedFiles) {
        const filePath = path.join(versionDir, sf.filename);
        if (!fs.existsSync(filePath)) { invalidCount++; continue; }
        const stats = fs.statSync(filePath);
        const expected = sf.expectedSize || sf.size || 0;
        if (expected > 0 && stats.size !== expected) {
          invalidCount++;
          emitLog(`[校验] ${sf.filename} 大小不匹配 (${formatSize(stats.size)}/${formatSize(expected)})，将重新下载`);
          try { fs.unlinkSync(filePath); } catch {}
        }
      }

      const allHaveCloudUrl = storedFiles.every(f => f.downloadUrl);
      const wpsEnabled = config.wps365?.enabled && config.wps365?.driveId;

      if (!force && invalidCount === 0 && storedFiles.length >= downloadList.length
          && (!wpsEnabled || allHaveCloudUrl)) {
        emitLog('[Sync] 已是最新版本，全部安装包校验通过，无需下载');
        syncEmitter.emit('done', { skipped: true, version: fullVersion });
        return { skipped: true, version: fullVersion };
      }

      if (invalidCount > 0) {
        emitLog(`[Sync] 发现 ${invalidCount} 个文件需要重新下载`);
      } else if (storedFiles.length < downloadList.length) {
        emitLog(`[Sync] 本地仅 ${storedFiles.length}/${downloadList.length} 个文件，继续补全`);
      } else if (wpsEnabled && !allHaveCloudUrl) {
        emitLog(`[Sync] 部分文件尚未上传到云端，继续补全`);
      } else if (force) {
        emitLog('[Sync] 手动触发强制同步，重新检查所有安装包');
      }
    }

    if (isNewVersion) {
      emitLog(`[Sync] 发现新版本 ${fullVersion}，下载期间保持当前版本 ${localVersion || '-'} 可用`);
    }

    const versionDir = path.join(downloadDir, fullVersion);

    if (!fs.existsSync(versionDir)) {
      fs.mkdirSync(versionDir, { recursive: true });
    }

    cleanupTempFiles(versionDir);

    const wps365 = await initWPS365(config, fullVersion);
    if (wps365) {
      emitLog(`[Sync] WPS365 云端上传已启用，拉一个传一个`);
    }

    emitLog(`[Sync] 开始下载 ${downloadList.length} 个安装包...`);

    const existingEntry = store.history.find(h => h.version === fullVersion);
    const results = [];

    for (let i = 0; i < downloadList.length; i++) {
      if (syncState.aborted) {
        emitLog('[Sync] 同步已被终止，跳过剩余下载');
        break;
      }

      const item = downloadList[i];
      emitLog(`[${i + 1}/${downloadList.length}] 处理: ${item.label} (${item.key})`);

      const headRes = await httpHead(item.url).catch(() => null);

      const contentType = headRes?.headers?.get('content-type') || '';
      const contentDisposition = headRes?.headers?.get('content-disposition') || '';
      const headExpectedSize = parseInt(headRes?.headers?.get('content-length') || '0', 10);
      const finalUrl = headRes?.finalUrl || '';
      const filename = resolveFilename(item.key, contentType, contentDisposition, finalUrl);
      const destPath = path.join(versionDir, filename);

      const existingFile = existingEntry?.files?.find(f => f.filename === filename);
      let downloadNeeded = true;
      let downloadResult = null;

      if (fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        if (stats.size > 0) {
          if (headExpectedSize > 0 && stats.size !== headExpectedSize) {
            emitLog(`  文件不完整: ${filename} (${formatSize(stats.size)}/${formatSize(headExpectedSize)}), 重新下载`);
            try { fs.unlinkSync(destPath); } catch {}
          } else {
            const verified = headExpectedSize > 0 && stats.size === headExpectedSize;
            emitLog(`  已存在: ${filename} (${formatSize(stats.size)})${verified ? ' ✓' : ''}`);
            downloadNeeded = false;
            downloadResult = { size: stats.size, expectedSize: headExpectedSize, success: true };
          }
        }
      }

      if (downloadNeeded) {
        downloadResult = await downloadFile(item.url, destPath);
        if (downloadResult.success) {
          const verified = downloadResult.expectedSize > 0 && downloadResult.size === downloadResult.expectedSize;
          emitLog(`  下载完成: ${filename} (${formatSize(downloadResult.size)})${verified ? ' ✓' : ''}`);
        } else {
          emitLog(`  下载失败: ${filename} - ${downloadResult.error}`);
          results.push({
            ...item, filename, size: 0, expectedSize: 0,
            success: false, verified: false, cached: false,
          });
          continue;
        }
      }

      let downloadUrl = existingFile?.downloadUrl || '';
      let wps365FileId = existingFile?.wps365FileId || '';

      if (wps365 && downloadResult.success) {
        if (downloadUrl && !downloadNeeded) {
          emitLog(`  云端已上传，跳过: ${filename}`);
        } else {
          try {
            const uploadResult = await uploadFile(destPath, wps365.driveId, wps365.versionFolderId);
            downloadUrl = uploadResult.downloadUrl;
            wps365FileId = uploadResult.fileId;
            emitLog(`  上传完成: ${filename}`);

            const share = config.wps365?.share;
            if (share?.enabled && uploadResult.fileId) {
              try {
                await shareFile(wps365.driveId, uploadResult.fileId, share.roleId, share.scope);
              } catch {}
            }
          } catch (err) {
            emitLog(`  ⚠ 云端上传失败 (本地文件可用): ${filename} - ${err.message}`);
          }
        }
      }

      const verified = downloadResult.expectedSize > 0
        && downloadResult.size === downloadResult.expectedSize;

      results.push({
        ...item, filename, size: downloadResult.size,
        expectedSize: downloadResult.expectedSize,
        success: true, verified, cached: !downloadNeeded,
        downloadUrl, wps365FileId,
      });
    }

    const successResults = results.filter((r) => r.success);
    const successCount = successResults.length;
    const allSucceeded = successCount === downloadList.length && !syncState.aborted;

    const fileEntries = successResults.map((r) => ({
      key: r.key, label: r.label, category: r.category,
      filename: r.filename, size: r.size, expectedSize: r.expectedSize,
      success: true, verified: r.verified,
      downloadUrl: r.downloadUrl || '',
      wps365FileId: r.wps365FileId || '',
    }));

    if (syncState.aborted) {
      emitLog(`[Sync] 已终止: ${successCount} 个安装包已处理，${downloadList.length - results.length} 个已跳过`);
      emitLog('[Sync] 当前显示版本保持不变');
      syncEmitter.emit('aborted');
      return { skipped: false, version: fullVersion, results, aborted: true };
    }

    emitLog(`[Sync] 完成: ${successCount}/${downloadList.length} 个安装包已处理`);

    if (allSucceeded) {
      const newEntry = {
        version: fullVersion,
        updatedAt: new Date().toISOString(),
        files: fileEntries,
      };
      const newHistory = [newEntry, ...store.history.filter(h => h.version !== fullVersion)];
      writeVersionStore(downloadDir, { current: fullVersion, history: newHistory });

      if (isNewVersion && localVersion) {
        emitLog(`[Sync] 版本已切换: ${localVersion} → ${fullVersion}`);
      }
    } else if (!isNewVersion && successCount > 0) {
      const entry = store.history.find(h => h.version === fullVersion);
      if (entry) {
        for (const fe of fileEntries) {
          const idx = entry.files.findIndex(f => f.filename === fe.filename);
          if (idx >= 0) entry.files[idx] = fe;
          else entry.files.push(fe);
        }
        entry.updatedAt = new Date().toISOString();
      }
      writeVersionStore(downloadDir, store);
      emitLog(`[Sync] 已补全部分文件，但仍有 ${downloadList.length - successCount} 个未成功`);
    } else if (isNewVersion) {
      emitLog(`[Sync] 新版本 ${fullVersion} 未全部完成 (${successCount}/${downloadList.length})，保持当前版本 ${localVersion}`);
    }

    if (wps365 && successCount > 0) {
      await refreshCloudInfoFile(config, {
        lastSyncTime: new Date().toISOString(),
        officialVersion: fullVersion,
      });
    }

    const finalResult = { skipped: false, version: fullVersion, results };
    syncEmitter.emit('done', finalResult);
    return finalResult;
  } finally {
    syncState.running = false;
    syncState.activeReq = null;
  }
}

async function migrateExistingToWPS365(config) {
  const wps = config.wps365;
  if (!wps || !wps.enabled || !wps.driveId) {
    emitLog('[WPS365] 云端上传未启用，跳过迁移');
    return;
  }

  if (!isCliAvailable()) {
    emitLog('[WPS365] wps365-cli 未安装，跳过迁移');
    return;
  }

  const downloadDir = path.resolve(config.downloadDir || './downloads');
  const store = readVersionStore(downloadDir);

  if (!store.history.length) {
    emitLog('[WPS365] 没有历史版本需要迁移');
    return;
  }

  const needsMigration = store.history.some(v =>
    v.files.some(f => f.success !== false && !f.downloadUrl)
  );
  if (!needsMigration) {
    emitLog('[WPS365] 所有版本已同步到云端，无需迁移');
    return;
  }

  if (syncState.running) {
    emitLog('[WPS365] 同步任务正在进行中，跳过迁移');
    return;
  }

  syncState.running = true;
  syncState.aborted = false;

  try {
    const rootFolderId = await resolveRootFolder(wps);

    let changed = false;

    for (const versionEntry of store.history) {
      const pending = versionEntry.files.filter(f => f.success !== false && !f.downloadUrl);
      if (!pending.length) continue;

      emitLog(`[WPS365] 迁移版本 ${versionEntry.version} (${pending.length} 个文件)...`);
      const versionFolderId = await ensureFolder(wps.driveId, rootFolderId, versionEntry.version);

      for (const file of pending) {
        if (syncState.aborted) {
          emitLog('[WPS365] 迁移已终止');
          if (changed) writeVersionStore(downloadDir, store);
          return;
        }

        const filePath = path.join(downloadDir, versionEntry.version, file.filename);
        if (!fs.existsSync(filePath)) {
          emitLog(`  跳过 (本地不存在): ${file.filename}`);
          continue;
        }

        try {
          const result = await uploadFile(filePath, wps.driveId, versionFolderId);
          file.downloadUrl = result.downloadUrl;
          file.wps365FileId = result.fileId;
          changed = true;
          writeVersionStore(downloadDir, store);

          const share = wps.share;
          if (share?.enabled && result.fileId) {
            try {
              await shareFile(wps.driveId, result.fileId, share.roleId, share.scope);
            } catch {}
          }
        } catch (err) {
          emitLog(`  迁移失败: ${file.filename} - ${err.message}`);
        }
      }
    }

    if (changed) {
      emitLog('[WPS365] 迁移完成，数据已保存');
      await refreshCloudInfoFile(config, {
        lastSyncTime: new Date().toISOString(),
      });
    }
  } catch (err) {
    emitLog(`[WPS365] 迁移异常: ${err.message}`);
  } finally {
    syncState.running = false;
  }
}

function getLocalIP() {
  const interfaces = require('os').networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

async function refreshCloudInfoFile(config, { lastSyncTime, lastCheckTime, officialVersion } = {}) {
  const wps = config.wps365;
  if (!wps?.enabled || !wps.driveId) return;

  try {
    const cliOk = await isCliAvailable();
    if (!cliOk) return;

    const downloadDir = path.resolve(config.downloadDir || './downloads');
    const store = readVersionStore(downloadDir);
    const rootFolderId = await resolveRootFolder(wps);

    const currentEntry = store.history.find(h => h.version === store.current);
    const historyVersions = store.history
      .filter(h => h.version !== store.current)
      .map(h => 'v' + h.version);

    const totalFiles = currentEntry?.files?.length || 0;
    const port = config.port || 6700;
    const siteUrl = config.siteUrl || `http://${getLocalIP()}:${port}`;

    const infoData = {
      mirrorVersion: store.current || '-',
      officialVersion: officialVersion || store.current || '-',
      fileCount: totalFiles,
      historyVersions,
      siteUrl,
      lastSyncTime: lastSyncTime || store.lastSyncTime || currentEntry?.updatedAt || null,
      lastCheckTime: lastCheckTime || store.lastCheckTime || null,
    };

    if (lastSyncTime) store.lastSyncTime = lastSyncTime;
    if (lastCheckTime) store.lastCheckTime = lastCheckTime;

    const newInfoFileId = await updateInfoFile(wps.driveId, rootFolderId, infoData);
    if (newInfoFileId) {
      store.wps365InfoFileId = newInfoFileId;
      const share = wps.share;
      if (share?.enabled) {
        try {
          await shareFile(wps.driveId, newInfoFileId, share.roleId, share.scope);
        } catch {}
      }
    }
    writeVersionStore(downloadDir, store);
  } catch (err) {
    emitLog(`[WPS365] 更新信息文件失败: ${err.message}`);
  }
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

module.exports = {
  syncCursorPackages,
  migrateExistingToWPS365,
  refreshCloudInfoFile,
  readVersionStore,
  formatSize,
  syncEmitter,
  getSyncState,
  abortSync,
};
