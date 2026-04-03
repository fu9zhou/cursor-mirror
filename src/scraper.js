const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const { getProxyAgent } = require('./proxy');

const DOWNLOAD_PAGE_URL = 'https://cursor.com/cn/download';

const ALL_PLATFORMS = [
  { key: 'darwin-arm64', label: 'Mac (ARM64)', category: 'macOS' },
  { key: 'darwin-x64', label: 'Mac (x64)', category: 'macOS' },
  { key: 'darwin-universal', label: 'Mac Universal', category: 'macOS' },
  { key: 'win32-x64', label: 'Windows (x64) (System)', category: 'windows' },
  { key: 'win32-x64-user', label: 'Windows (x64) (User)', category: 'windows' },
  { key: 'win32-arm64', label: 'Windows (ARM64) (System)', category: 'windows' },
  { key: 'win32-arm64-user', label: 'Windows (ARM64) (User)', category: 'windows' },
  { key: 'linux-arm64-deb', label: 'Linux .deb (ARM64)', category: 'linux' },
  { key: 'linux-x64-deb', label: 'Linux .deb (x64)', category: 'linux' },
  { key: 'linux-arm64-rpm', label: 'Linux RPM (ARM64)', category: 'linux' },
  { key: 'linux-x64-rpm', label: 'Linux RPM (x64)', category: 'linux' },
  { key: 'linux-arm64', label: 'Linux AppImage (ARM64)', category: 'linux' },
  { key: 'linux-x64', label: 'Linux AppImage (x64)', category: 'linux' },
];

function buildDownloadUrl(platformKey, version) {
  return `https://api2.cursor.sh/updates/download/golden/${platformKey}/cursor/${version}`;
}

function httpsGet(url, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    const agent = getProxyAgent();
    const opts = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    };
    if (agent) opts.agent = agent;

    const req = client.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('Connection timeout')); });
    req.on('error', reject);
  });
}

function getFirstRedirectLocation(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const agent = getProxyAgent();
    const opts = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    };
    if (agent) opts.agent = agent;

    const req = client.get(url, opts, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        reject(new Error(`Expected 302, got ${res.statusCode}`));
      }
    });
    req.on('timeout', () => { req.destroy(new Error('Version probe timeout')); });
    req.on('error', reject);
  });
}

async function fetchLatestVersion() {
  const html = await httpsGet(DOWNLOAD_PAGE_URL);
  const $ = cheerio.load(html);

  let apiVersion = null;

  $('a[href*="api2.cursor.sh/updates/download/golden"]').each((_, el) => {
    const href = $(el).attr('href');
    const match = href && href.match(/\/cursor\/([\d.]+)$/);
    if (match && !apiVersion) {
      apiVersion = match[1];
    }
  });

  if (!apiVersion) {
    const bodyText = $('body').text();
    const match = bodyText.match(/([\d]+\.[\d]+(?:\.[\d]+)?)[\s]*Latest/i);
    if (match) {
      apiVersion = match[1];
    }
  }

  if (!apiVersion) {
    throw new Error('Could not parse latest version from Cursor download page');
  }

  let fullVersion = apiVersion;

  try {
    const probeUrl = buildDownloadUrl('win32-x64', apiVersion);
    const redirectUrl = await getFirstRedirectLocation(probeUrl);
    const versionMatch = redirectUrl.match(/[-_](\d+\.\d+\.\d+)/);
    if (versionMatch) {
      fullVersion = versionMatch[1];
    }
  } catch (err) {
    console.error(`[VersionProbe] Failed to resolve full version: ${err.message}, using ${apiVersion}`);
  }

  return { apiVersion, fullVersion };
}

function filterPlatforms(config) {
  const { platforms, platformFilter, specificPlatforms } = config;

  if (specificPlatforms && specificPlatforms.length > 0) {
    return ALL_PLATFORMS.filter((p) => specificPlatforms.includes(p.key));
  }

  if (platforms === 'all' && (!platformFilter || (platformFilter.macOS && platformFilter.windows && platformFilter.linux))) {
    return ALL_PLATFORMS;
  }

  if (platformFilter) {
    return ALL_PLATFORMS.filter((p) => {
      return platformFilter[p.category] === true;
    });
  }

  return ALL_PLATFORMS;
}

function getDownloadList(version, config) {
  const filtered = filterPlatforms(config);
  return filtered.map((p) => ({
    ...p,
    url: buildDownloadUrl(p.key, version),
  }));
}

module.exports = {
  ALL_PLATFORMS,
  fetchLatestVersion,
  getDownloadList,
};
