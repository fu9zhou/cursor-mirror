const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let logFn = (msg) => console.log(msg);

function setLogger(fn) { logFn = fn; }

function getCliPath() {
  const candidates = [];
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (userProfile) {
    candidates.push(path.join(userProfile, '.wps365', 'bin', 'wps365-cli.exe'));
    candidates.push(path.join(userProfile, '.wps365', 'bin', 'wps365-cli'));
  }

  // When running as LocalSystem service, USERPROFILE points to systemprofile;
  // scan real user directories so the CLI is still found.
  if (process.platform === 'win32') {
    const usersDir = path.join(process.env.SystemDrive || 'C:', 'Users');
    try {
      const dirs = fs.readdirSync(usersDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        if (/^(Public|Default|Default User|All Users)$/i.test(d.name)) continue;
        const p = path.join(usersDir, d.name, '.wps365', 'bin', 'wps365-cli.exe');
        if (!candidates.includes(p)) candidates.push(p);
      }
    } catch {}
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'wps365-cli';
}

function getCliConfigDir() {
  const cli = getCliPath();
  const match = cli.match(/^([A-Za-z]:\\Users\\[^\\]+)\\/i);
  const profile = match ? match[1] : (process.env.USERPROFILE || process.env.HOME || '');
  return path.join(profile, 'AppData', 'Roaming', 'wps365-cli');
}

// Read WPS365 CLI config.json (contains client_id, client_secret, api_base)
function readCliConfig() {
  try {
    const cfgPath = path.join(getCliConfigDir(), 'config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch { return {}; }
}

// Token file lives alongside config.json — avoids Windows Credential Manager
// which is inaccessible from Session 0 (services).
function getTokenFilePath() {
  return path.join(getCliConfigDir(), 'token_delegated.json');
}

function readTokenFile() {
  try { return JSON.parse(fs.readFileSync(getTokenFilePath(), 'utf-8')); }
  catch { return null; }
}

function writeTokenFile(data) {
  try { fs.writeFileSync(getTokenFilePath(), JSON.stringify(data, null, 2), 'utf-8'); }
  catch (e) { logFn(`[WPS365] Failed to save token: ${e.message}`); }
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`OAuth response parse error: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('OAuth request timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

let cachedAccessToken = null;
let cachedTokenExpiry = 0;

function tryCliToken() {
  try {
    const cli = getCliPath();
    const token = require('child_process').execFileSync(cli, ['auth', 'token'], {
      timeout: 15000, encoding: 'utf-8', stdio: 'pipe',
      env: getCliEnv(),
    }).trim();
    if (token && token.startsWith('ey')) {
      let statusInfo = {};
      try {
        const raw = require('child_process').execFileSync(cli, ['auth', 'status', '-o', 'json'], {
          timeout: 10000, encoding: 'utf-8', stdio: 'pipe',
          env: getCliEnv(),
        });
        statusInfo = JSON.parse(raw);
      } catch {}

      const d = statusInfo.delegated || {};
      const newToken = {
        access_token: token,
        refresh_token: '',
        token_type: 'bearer',
        granted_scopes: d.granted_scopes || [],
        access_token_expires_at: d.access_token_expires_at || new Date(Date.now() + 7200 * 1000).toISOString(),
        refresh_token_expires_at: d.refresh_token_expires_at || '',
      };
      writeTokenFile(newToken);
      return { token, expiresAt: new Date(newToken.access_token_expires_at).getTime() };
    }
  } catch {}
  return null;
}

async function ensureAccessToken() {
  if (cachedAccessToken && Date.now() < cachedTokenExpiry - 60000) {
    return cachedAccessToken;
  }

  const tokenData = readTokenFile();
  if (tokenData?.access_token) {
    const expiresAt = tokenData.access_token_expires_at
      ? new Date(tokenData.access_token_expires_at).getTime()
      : 0;
    if (expiresAt > Date.now() + 60000) {
      cachedAccessToken = tokenData.access_token;
      cachedTokenExpiry = expiresAt;
      return cachedAccessToken;
    }
  }

  const cliCfg = readCliConfig();
  if (tokenData?.refresh_token && cliCfg.client_id && cliCfg.client_secret) {
    const tokenUrl = cliCfg.token_url || 'https://openapi.wps.cn/oauth2/token';
    const body = [
      `grant_type=refresh_token`,
      `client_id=${encodeURIComponent(cliCfg.client_id)}`,
      `client_secret=${encodeURIComponent(cliCfg.client_secret)}`,
      `refresh_token=${encodeURIComponent(tokenData.refresh_token)}`,
    ].join('&');

    logFn('[WPS365] Refreshing access token via OAuth API...');
    try {
      const resp = await httpsPost(tokenUrl, body);
      if (resp.status === 200 && resp.body.access_token) {
        const newToken = {
          access_token: resp.body.access_token,
          refresh_token: resp.body.refresh_token || tokenData.refresh_token,
          token_type: resp.body.token_type || 'bearer',
          granted_scopes: resp.body.scope
            ? resp.body.scope.split(' ')
            : (tokenData.granted_scopes || []),
          access_token_expires_at: new Date(Date.now() + (resp.body.expires_in || 7200) * 1000).toISOString(),
          refresh_token_expires_at: tokenData.refresh_token_expires_at || '',
        };
        writeTokenFile(newToken);
        cachedAccessToken = newToken.access_token;
        cachedTokenExpiry = new Date(newToken.access_token_expires_at).getTime();
        logFn('[WPS365] Token refreshed successfully');
        return cachedAccessToken;
      }
    } catch (refreshErr) {
      logFn(`[WPS365] OAuth refresh failed: ${refreshErr.message}`);
    }
  }

  logFn('[WPS365] Falling back to CLI token...');
  const cliResult = tryCliToken();
  if (cliResult) {
    cachedAccessToken = cliResult.token;
    cachedTokenExpiry = cliResult.expiresAt;
    logFn('[WPS365] Got token from CLI successfully');
    return cachedAccessToken;
  }

  throw new Error('No valid WPS365 token and unable to refresh — run wps365-cli auth login in an interactive session');
}

function getCliEnv() {
  const cli = getCliPath();
  const env = { ...process.env };
  const match = cli.match(/^([A-Za-z]:\\Users\\[^\\]+)\\/i);
  if (match) {
    const ownerProfile = match[1];
    env.USERPROFILE = ownerProfile;
    env.APPDATA = path.join(ownerProfile, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(ownerProfile, 'AppData', 'Local');
    env.HOME = ownerProfile;
  }
  if (cachedAccessToken) {
    env.WPS365_ACCESS_TOKEN = cachedAccessToken;
  }
  return env;
}

function isCliAvailable() {
  try {
    const cli = getCliPath();
    require('child_process').execFileSync(cli, ['--version'], {
      timeout: 10000, encoding: 'utf-8', stdio: 'pipe',
      env: getCliEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

async function cliExec(args) {
  await ensureAccessToken();
  return new Promise((resolve, reject) => {
    const cli = getCliPath();
    execFile(cli, args, {
      timeout: 120000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
      env: getCliEnv(),
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

async function getAuthToken() {
  return ensureAccessToken();
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

async function shareFile(driveId, fileId, roleId, scope) {
  try {
    const openResult = await cliExec([
      'drive', 'file-link', 'open', driveId, fileId,
      '--role-id', roleId,
      '--scope', scope,
    ]);
    if (openResult?.code && openResult.code !== 0) {
      throw new Error(openResult.msg || JSON.stringify(openResult));
    }

    const linkId = openResult?.data?.id;
    if (linkId && openResult?.data?.scope !== scope) {
      const updateBody = JSON.stringify({ scope, role_id: roleId });
      await cliExec(['api', 'post', `/v7/links/${linkId}/update`, '--data', updateBody]);
    }

    logFn(`  [WPS365] 分享已开启: ${fileId} (${scope})`);
    return openResult;
  } catch (err) {
    logFn(`  [WPS365] 开启分享失败: ${fileId} - ${err.message}`);
    throw err;
  }
}

function formatTimeCN(dateOrStr) {
  if (!dateOrStr) return '-';
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function formatTimeCompact(dateOrStr) {
  if (!dateOrStr) return '未知';
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  if (isNaN(d.getTime())) return '未知';
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${M}-${D} ${h}${m}`;
}

function buildInfoFileName(data) {
  const mirrorVer = data.mirrorVersion || '未同步';
  const officialVer = data.officialVersion || '未知';
  const syncTime = formatTimeCompact(data.lastSyncTime);
  const updateTime = formatTimeCompact(new Date());
  return `【镜像v${mirrorVer}_官方v${officialVer}_${syncTime}拉取_${updateTime}更新】.txt`;
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
  shareFile,
  getCliPath,
};
