const HttpsProxyAgent = require('https-proxy-agent');
const { execSync } = require('child_process');

let proxyAgent = null;

function detectSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const enable = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: 'utf-8', timeout: 3000 }
    );
    if (!enable.includes('0x1')) return null;

    const server = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const match = server.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (match) {
      const addr = match[1].trim();
      return addr.startsWith('http') ? addr : `http://${addr}`;
    }
  } catch {}
  return null;
}

function initProxy(config) {
  const url = config.proxy
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || '';

  const finalUrl = url || detectSystemProxy() || '';

  if (finalUrl) {
    proxyAgent = new HttpsProxyAgent(finalUrl);
    console.log(`[Proxy] Using proxy: ${finalUrl}${!url ? ' (auto-detected from system)' : ''}`);
  } else {
    proxyAgent = null;
    console.log('[Proxy] No proxy configured, connecting directly');
  }
}

function getProxyAgent() {
  return proxyAgent;
}

module.exports = { initProxy, getProxyAgent };
