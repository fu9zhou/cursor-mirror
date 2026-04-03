const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let logFn = (msg) => console.log(msg);

function setLogger(fn) { logFn = fn; }

function getCliPath() {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const defaultPath = path.join(userProfile, '.wps365', 'bin', 'wps365-cli.exe');
  if (fs.existsSync(defaultPath)) return defaultPath;
  const altPath = path.join(userProfile, '.wps365', 'bin', 'wps365-cli');
  if (fs.existsSync(altPath)) return altPath;
  return 'wps365-cli';
}

function isCliAvailable() {
  try {
    const cli = getCliPath();
    require('child_process').execFileSync(cli, ['--version'], {
      timeout: 10000, encoding: 'utf-8', stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function cliExec(args) {
  return new Promise((resolve, reject) => {
    const cli = getCliPath();
    execFile(cli, args, {
      timeout: 120000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`wps365-cli error: ${stderr || err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

function getAuthToken() {
  return new Promise((resolve, reject) => {
    const cli = getCliPath();
    execFile(cli, ['auth', 'token'], {
      timeout: 15000, encoding: 'utf-8',
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`Failed to get WPS365 auth token: ${err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function computeHashes(filePath) {
  return new Promise((resolve, reject) => {
    const sha256 = crypto.createHash('sha256');
    const md5 = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => { sha256.update(chunk); md5.update(chunk); });
    stream.on('end', () => {
      resolve({ sha256: sha256.digest('hex'), md5: md5.digest('hex') });
    });
    stream.on('error', reject);
  });
}

async function ensureFolder(driveId, parentId, folderName) {
  try {
    const listResult = await cliExec([
      'drive', 'files', 'list', driveId, parentId, '--page-size', '100',
    ]);
    const items = listResult?.data?.items || listResult?.data?.files || listResult?.items || [];
    if (Array.isArray(items)) {
      const found = items.find(f => f.name === folderName && f.type === 'folder');
      if (found) {
        logFn(`[WPS365] 文件夹已存在: ${folderName} (${found.id})`);
        return found.id;
      }
    }
  } catch (err) {
    logFn(`[WPS365] 查询文件夹失败: ${err.message}, 尝试创建...`);
  }

  const result = await cliExec([
    'drive', 'files', 'create', driveId, parentId,
    '--name', folderName, '--file-type', 'folder',
  ]);
  const folderId = result?.data?.id || result?.id;
  if (folderId) {
    logFn(`[WPS365] 创建文件夹: ${folderName} (${folderId})`);
    return folderId;
  }
  throw new Error(`Failed to create folder "${folderName}" on WPS365`);
}

function putFileStream(uploadUrl, filePath, token) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(filePath).size;
    const parsedUrl = new URL(uploadUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize,
      },
      timeout: 600000,
    };

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`PUT HTTP ${res.statusCode}: ${body.substring(0, 500)}`));
      });
    });

    req.on('timeout', () => { req.destroy(new Error('Upload PUT timeout (10min)')); });
    req.on('error', reject);

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(req);
    readStream.on('error', (err) => { req.destroy(err); reject(err); });
  });
}

const UPLOAD_RETRIES = 3;

async function uploadFile(filePath, driveId, parentId) {
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      logFn(`  [WPS365] 计算哈希: ${fileName}...`);
      const hashes = await computeHashes(filePath);

      logFn(`  [WPS365] 申请上传: ${fileName} (${formatSize(fileSize)})...`);
      const reqBody = JSON.stringify({
        name: fileName,
        size: fileSize,
        on_name_conflict: 'overwrite',
        hashes: [
          { type: 'sha256', sum: hashes.sha256 },
          { type: 'md5', sum: hashes.md5 },
        ],
      });

      const requestResult = await cliExec([
        'api', 'post',
        `/v7/drives/${driveId}/files/${parentId}/request_upload`,
        '--data', reqBody,
      ]);

      if (requestResult?.code && requestResult.code !== 0) {
        throw new Error(`request_upload: ${requestResult.msg || JSON.stringify(requestResult)}`);
      }

      const data = requestResult?.data || requestResult;

      if (data?.file) {
        logFn(`  [WPS365] 秒传成功: ${fileName}`);
        return {
          fileId: data.file.id,
          downloadUrl: data.file.link_url || '',
          name: data.file.name,
        };
      }

      const uploadId = data?.upload_id;
      const uploadUrl = data?.store_request?.url;
      if (!uploadId || !uploadUrl) {
        throw new Error(`request_upload response missing upload_id or store_request.url`);
      }

      logFn(`  [WPS365] 上传文件: ${fileName} (${formatSize(fileSize)})...`);
      const token = await getAuthToken();
      await putFileStream(uploadUrl, filePath, token);

      logFn(`  [WPS365] 确认上传: ${fileName}...`);
      const commitBody = JSON.stringify({ upload_id: uploadId });
      const commitResult = await cliExec([
        'api', 'post',
        `/v7/drives/${driveId}/files/${parentId}/commit_upload`,
        '--data', commitBody,
      ]);

      if (commitResult?.code && commitResult.code !== 0) {
        throw new Error(`commit_upload: ${commitResult.msg || JSON.stringify(commitResult)}`);
      }

      const commitData = commitResult?.data || commitResult;
      logFn(`  [WPS365] 上传成功: ${fileName} → ${commitData?.link_url || '(no link)'}`);
      return {
        fileId: commitData?.id || '',
        downloadUrl: commitData?.link_url || '',
        name: commitData?.name || fileName,
      };
    } catch (err) {
      logFn(`  [WPS365] 上传失败 (${attempt}/${UPLOAD_RETRIES}): ${fileName} - ${err.message}`);
      if (attempt < UPLOAD_RETRIES) {
        const delay = 5000 * attempt;
        logFn(`  [WPS365] ${delay / 1000}s 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function formatTimeCN(dateOrStr) {
  if (!dateOrStr) return '-';
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function buildInfoFileName(data) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const mirrorVer = data.mirrorVersion || '未同步';
  const officialVer = data.officialVersion || '未知';
  const fileCount = data.fileCount || 0;
  return `【镜像v${mirrorVer}_官方v${officialVer}_${fileCount}个包_${dateStr}_${timeStr}更新】.txt`;
}

function buildInfoFileContent(data) {
  const lines = [
    '═════════════════════════════════════',
    '        Cursor 镜像 - 状态信息',
    '═════════════════════════════════════',
    '',
    `🕐 上次拉取时间:  ${formatTimeCN(data.lastSyncTime)}`,
    `🔍 上次检测时间:  ${formatTimeCN(data.lastCheckTime)}`,
    `📦 官方最新版本:  v${data.officialVersion || '未知'}`,
    `📌 当前镜像版本:  v${data.mirrorVersion || '未同步'}`,
    `📊 安装包总数:    ${data.fileCount || 0} 个`,
  ];
  if (data.historyVersions && data.historyVersions.length) {
    lines.push(`📁 历史版本:      ${data.historyVersions.join(', ')}`);
  }
  if (data.siteUrl) {
    lines.push(`🔗 下载站点:      ${data.siteUrl}`);
  }
  lines.push('');
  lines.push('═════════════════════════════════════');
  lines.push('');
  return lines.join('\n');
}

async function findInfoFile(driveId, rootFolderId) {
  try {
    const listResult = await cliExec([
      'drive', 'files', 'list', driveId, rootFolderId, '--page-size', '50',
    ]);
    const items = listResult?.data?.items || listResult?.data?.files || listResult?.items || [];
    return items.find(f =>
      f.type === 'file' && f.name && f.name.startsWith('【') && f.name.endsWith('.txt')
    ) || null;
  } catch {
    return null;
  }
}

async function updateInfoFile(driveId, rootFolderId, data) {
  const infoFileName = buildInfoFileName(data);
  const infoContent = buildInfoFileContent(data);

  const existing = await findInfoFile(driveId, rootFolderId);

  const tmpDir = require('os').tmpdir();
  const tmpFile = path.join(tmpDir, infoFileName);
  fs.writeFileSync(tmpFile, infoContent, 'utf-8');

  try {
    if (existing) {
      try {
        await cliExec([
          'drive', 'files', 'rename', driveId, existing.id,
          '--name', infoFileName,
        ]);
      } catch {}

      const result = await uploadFile(tmpFile, driveId, rootFolderId);
      logFn(`[WPS365] 信息文件已更新: ${infoFileName}`);
      return result?.fileId || existing.id;
    }

    const result = await uploadFile(tmpFile, driveId, rootFolderId);
    try {
      await cliExec([
        'drive', 'files', 'rename', driveId, result.fileId,
        '--name', infoFileName,
      ]);
    } catch {}
    logFn(`[WPS365] 信息文件已创建: ${infoFileName}`);
    return result.fileId;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

module.exports = {
  setLogger,
  isCliAvailable,
  ensureFolder,
  uploadFile,
  updateInfoFile,
  getCliPath,
};
