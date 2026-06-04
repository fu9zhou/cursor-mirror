const https = require('https');
const http = require('http');
const { getProxyAgent } = require('./proxy');

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

const VERSION_PROBE_PLATFORMS = ['win32-x64', 'linux-x64'];
const VERSION_PROBE_MAX_RETRIES = 3;
const VERSION_PROBE_RETRY_DELAY_MS = 3000;
const FULL_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

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
  for (let attempt = 1; attempt <= VERSION_PROBE_MAX_RETRIES; attempt++) {
    for (const platform of VERSION_PROBE_PLATFORMS) {
      try {
        const probeUrl = buildDownloadUrl(platform, 'latest');
        const redirectUrl = await getFirstRedirectLocation(probeUrl);
        const versionMatch = redirectUrl.match(/[-_](\d+\.\d+\.\d+)/);
        if (versionMatch && FULL_VERSION_PATTERN.test(versionMatch[1])) {
          const fullVersion = versionMatch[1];
          return { apiVersion: fullVersion, fullVersion };
        }
      } catch (err) {
        console.warn(`[VersionProbe] Attempt ${attempt}/${VERSION_PROBE_MAX_RETRIES} (${platform}): ${err.message}`);
      }
    }
    if (attempt < VERSION_PROBE_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, VERSION_PROBE_RETRY_DELAY_MS * attempt));
    }
  }

  throw new Error(`Failed to resolve latest version after ${VERSION_PROBE_MAX_RETRIES} attempts via API redirect probe`);
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
