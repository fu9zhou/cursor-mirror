(function () {
  var sse = null;
  var logOpen = false;
  var isLocal = false;
  var isLocalDownloadMode = location.search.indexOf('local') !== -1;

  function toggleDownloadMode() {
    if (isLocalDownloadMode) {
      var url = location.pathname;
      var params = new URLSearchParams(location.search);
      params.delete('local');
      var qs = params.toString();
      location.href = url + (qs ? '?' + qs : '');
    } else {
      var params = new URLSearchParams(location.search);
      params.set('local', '1');
      location.href = location.pathname + '?' + params.toString();
    }
  }
  window.toggleDownloadMode = toggleDownloadMode;

  var CATEGORY_ICONS = { macOS: '🍎', windows: '🪟', linux: '🐧' };
  var CATEGORY_TITLES = { macOS: 'macOS', windows: 'Windows', linux: 'Linux' };

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0 || !isFinite(bytes)) return '-';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  // --- Log panel ---

  function toggleLog() {
    var p = document.getElementById('logPanel');
    logOpen = !logOpen;
    p.classList.toggle('open', logOpen);
  }
  window.toggleLog = toggleLog;

  function showLogPanel() {
    var p = document.getElementById('logPanel');
    if (p) { p.style.display = ''; logOpen = true; p.classList.add('open'); }
  }

  function hideLogPanel() {
    var p = document.getElementById('logPanel');
    if (p) { p.style.display = 'none'; logOpen = false; p.classList.remove('open'); }
  }

  function addLogLine(entry) {
    var b = document.getElementById('logBody');
    var l = document.createElement('div');
    l.className = 'log-line';
    var ts = entry.time ? new Date(entry.time).toLocaleTimeString('zh-CN') : '';
    l.innerHTML = '<span class="ts">' + ts + '</span> ' + escapeHtml(entry.msg || '');
    b.appendChild(l);
    b.scrollTop = b.scrollHeight;
  }

  // --- Sync button ---

  function setSyncing(syncing) {
    var btn = document.getElementById('syncBtn');
    var abortBtn = document.getElementById('abortBtn');
    if (!btn) return;
    if (syncing) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 同步中...';
      if (abortBtn) abortBtn.style.display = '';
    } else {
      btn.disabled = false;
      btn.innerHTML = '↻ 立即拉取';
      if (abortBtn) abortBtn.style.display = 'none';
    }
  }

  function triggerSync() {
    setSyncing(true);
    showLogPanel();
    document.getElementById('logBody').innerHTML = '';
    connectSSE();
    fetch('/api/sync/trigger', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          addLogLine({ msg: d.msg });
          setSyncing(false);
          if (sse) { sse.close(); sse = null; }
        }
      })
      .catch(function (e) {
        addLogLine({ msg: e.message });
        setSyncing(false);
        if (sse) { sse.close(); sse = null; }
      });
  }
  window.triggerSync = triggerSync;

  function abortSync() {
    fetch('/api/sync/abort', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) addLogLine({ time: new Date().toISOString(), msg: '[Sync] 正在终止同步...' });
      })
      .catch(function () {});
  }
  window.abortSync = abortSync;

  function triggerMigrate() {
    showLogPanel();
    document.getElementById('logBody').innerHTML = '';
    connectSSE();
    addLogLine({ time: new Date().toISOString(), msg: '[WPS365] 开始迁移已有版本到云端...' });
    fetch('/api/sync/migrate', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        addLogLine({ time: new Date().toISOString(), msg: d.msg || '迁移已触发' });
      })
      .catch(function (e) {
        addLogLine({ time: new Date().toISOString(), msg: '迁移触发失败: ' + e.message });
      });
  }
  window.triggerMigrate = triggerMigrate;

  // --- SSE ---

  function connectSSE() {
    if (sse) sse.close();
    sse = new EventSource('/api/sync/stream');
    sse.onmessage = function (e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'done' || d.type === 'aborted') {
          var msg = d.type === 'aborted'
            ? '[Sync] 已终止，页面将在 2 秒后刷新...'
            : '[Sync] 完成，页面将在 2 秒后刷新...';
          addLogLine({ time: new Date().toISOString(), msg: msg });
          setSyncing(false);
          sse.close();
          sse = null;
          setTimeout(function () { hideLogPanel(); location.reload(); }, 2000);
          return;
        }
        if (d.type === 'status') { if (!d.running) setSyncing(false); return; }
        addLogLine(d);
      } catch (ex) { /* ignore */ }
    };
    sse.onerror = function () {
      setSyncing(false);
      if (sse) { sse.close(); sse = null; }
    };
  }

  // --- Platform detection (same algorithm as cursor.com) ---

  function detectPlatform() {
    var ua = window.navigator.userAgent.toLowerCase();
    var platform = (navigator.platform || '').toLowerCase();
    var combined = ua + ' ' + platform;
    if (ua.indexOf('mac') !== -1) return 'darwin';
    if (ua.indexOf('windows') !== -1) return 'win32';
    if (ua.indexOf('linux') !== -1) {
      var rpmDistros = [/centos/i, /redhat/i, /rhel/i, /fedora/i, /scientific/i, /rocky/i, /alma/i, /opensuse/i, /suse/i, /mageia/i, /mandriva/i, /mandrake/i];
      for (var i = 0; i < rpmDistros.length; i++) { if (rpmDistros[i].test(combined)) return 'linux-rpm'; }
      var debDistros = [/ubuntu/i, /debian/i, /mint/i, /elementary/i, /pop!_os/i, /zorin/i, /kali/i, /parrot/i];
      for (var i = 0; i < debDistros.length; i++) { if (debDistros[i].test(combined)) return 'linux-deb'; }
      return 'linux';
    }
    return null;
  }

  function detectArchitecture(callback) {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'platform'])
        .then(function (v) {
          if (v.architecture === 'arm') callback('arm64');
          else callback('x64');
        })
        .catch(function () { callback(detectArchFallback()); });
    } else {
      callback(detectArchFallback());
    }
  }

  function detectArchFallback() {
    var combined = navigator.userAgent + ' ' + (navigator.platform || '');
    var armPatterns = [/arm64/i, /aarch64/i, /armv8l/i, /armv8a/i, /armv8/i, /armv9/i];
    for (var i = 0; i < armPatterns.length; i++) { if (armPatterns[i].test(combined)) return 'arm64'; }
    return 'x64';
  }

  function findBestDownloadOption(files, arch, platform) {
    if (!files || !files.length) return null;
    var includes = function (label, keywords) {
      var lower = label.toLowerCase();
      for (var i = 0; i < keywords.length; i++) { if (lower.indexOf(keywords[i]) !== -1) return true; }
      return false;
    };

    var candidates = files.filter(function (f) { return f.success !== false; });

    if (platform === 'darwin') {
      if (arch === 'arm64') {
        var found = candidates.find(function (f) { return includes(f.label, ['arm64', 'aarch64', 'apple silicon', 'arm']); });
        if (found) return found;
      }
      var universal = candidates.find(function (f) { return includes(f.label, ['universal']); });
      if (universal) return universal;
      if (arch === 'x64') {
        var found = candidates.find(function (f) { return includes(f.label, ['x64', 'intel']); });
        if (found) return found;
      }
    }

    if (platform === 'win32') {
      var found = candidates.find(function (f) {
        var lower = f.label.toLowerCase();
        var isUser = lower.indexOf('user') !== -1;
        var matchArch = arch === 'arm64'
          ? (lower.indexOf('arm64') !== -1 || lower.indexOf('arm') !== -1)
          : lower.indexOf('x64') !== -1;
        return isUser && matchArch;
      });
      if (found) return found;
    }

    if (platform === 'linux-rpm') {
      var found = candidates.find(function (f) {
        var lower = f.label.toLowerCase();
        return lower.indexOf('.rpm') !== -1 || lower.indexOf('rpm') !== -1;
      });
      if (found) return found;
    } else if (platform === 'linux-deb' || platform === 'linux') {
      var found = candidates.find(function (f) {
        var lower = f.label.toLowerCase();
        return lower.indexOf('.deb') !== -1 || lower.indexOf('deb') !== -1;
      });
      if (found) return found;
    }

    var archMatch = candidates.find(function (f) {
      return includes(f.label, [arch, arch === 'arm64' ? 'arm' : 'x64']);
    });
    if (archMatch) return archMatch;
    return candidates[0] || null;
  }

  function getOSName(platform) {
    if (!platform) return null;
    if (platform === 'darwin') return 'macOS';
    if (platform === 'win32') return 'Windows';
    return 'Linux';
  }

  function getDownloadHref(file, version) {
    if (!isLocalDownloadMode && file.downloadUrl) return file.downloadUrl;
    return '/download/' + version + '/' + escapeHtml(file.filename);
  }

  function isExternalLink(file) {
    return !isLocalDownloadMode && !!file.downloadUrl;
  }

  // --- Page rendering ---

  function renderStatusRow(data) {
    var row = document.getElementById('statusRow');
    var html = '';

    if (data.version && data.officialVersion && data.version === data.officialVersion) {
      html += '<div class="status-badge synced"><span class="dot"></span>已是最新</div>';
    } else if (data.version && data.officialVersion && data.version !== data.officialVersion) {
      html += '<div class="status-badge behind"><span class="dot"></span>有新版本待同步</div>';
    } else if (!data.version && data.officialVersion) {
      html += '<div class="status-badge behind"><span class="dot"></span>尚未同步</div>';
    }

    if (isLocalDownloadMode) {
      html += '<div class="status-badge local-mode clickable" onclick="toggleDownloadMode()" title="点击切换到云端下载"><span class="dot"></span>📥 本地下载模式</div>';
    } else {
      html += '<div class="status-badge cloud-mode clickable" onclick="toggleDownloadMode()" title="点击切换到本地下载"><span class="dot"></span>☁ 云端下载模式</div>';
    }

    if (isLocal) {
      html += '<button class="sync-btn" id="syncBtn" onclick="triggerSync()">↻ 立即拉取</button>';
      html += '<button class="sync-btn abort-btn" id="abortBtn" onclick="abortSync()" style="display:none;background:#dc2626">■ 终止</button>';
      html += '<button class="sync-btn migrate-btn" id="migrateBtn" onclick="triggerMigrate()" title="上传已有版本到WPS365">☁ 迁移到云端</button>';
    }

    row.innerHTML = html;
  }

  function renderCategory(name, items, version) {
    var icon = CATEGORY_ICONS[name] || '';
    var title = CATEGORY_TITLES[name] || name;
    if (!items || !items.length) {
      return '<div class="category"><h2>' + icon + ' ' + title + '</h2><p class="empty">暂无可用文件</p></div>';
    }
    var rows = items.filter(function (f) { return f.success !== false; }).map(function (f) {
      var href = getDownloadHref(f, version);
      var external = isExternalLink(f);
      var targetAttr = external ? ' target="_blank" rel="noopener"' : '';
      var showCloud = !isLocalDownloadMode && !!f.downloadUrl;
      var badge = showCloud
        ? '<span class="cloud-badge" title="云端存储">☁</span>'
        : (f.verified ? '<span class="verified-badge" title="完整性校验通过">✓</span>' : '');
      return '<a class="file-row" href="' + href + '"' + targetAttr + ' title="下载 ' + escapeHtml(f.label) + '">'
        + '<span class="file-label">' + escapeHtml(f.label) + '</span>'
        + '<span class="file-meta">' + badge + '<span class="file-size">' + formatSize(f.size) + '</span><span class="dl-icon">&#x2913;</span></span>'
        + '</a>';
    }).join('');
    return '<div class="category"><h2>' + icon + ' ' + title + '</h2>' + rows + '</div>';
  }

  function renderVersionGrid(files, version) {
    var cats = { macOS: [], windows: [], linux: [] };
    (files || []).forEach(function (f) { if (f.success !== false && cats[f.category]) cats[f.category].push(f); });
    return '<div class="grid">'
      + renderCategory('macOS', cats.macOS, version)
      + renderCategory('windows', cats.windows, version)
      + renderCategory('linux', cats.linux, version)
      + '</div>';
  }

  function renderHistorySection(history) {
    if (!history || !history.length) return '';
    var items = history.map(function (h, idx) {
      var date = h.updatedAt ? new Date(h.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
      var fileCount = (h.files || []).filter(function(f) { return f.success !== false; }).length;
      return '<div class="history-card" id="historyCard' + idx + '">'
        + '<div class="history-header" onclick="toggleHistory(' + idx + ')">'
        + '<span class="history-ver">v' + escapeHtml(h.version) + '</span>'
        + '<span class="history-meta">' + fileCount + ' 个文件 · ' + date + '</span>'
        + '<span class="history-toggle">▸</span>'
        + '</div>'
        + '<div class="history-body">' + renderVersionGrid(h.files, h.version) + '</div>'
        + '</div>';
    }).join('');
    return '<div class="history-section">'
      + '<h3 class="history-title">历史版本</h3>'
      + items
      + '</div>';
  }

  function toggleHistory(idx) {
    var card = document.getElementById('historyCard' + idx);
    if (!card) return;
    var body = card.querySelector('.history-body');
    if (card.classList.contains('open')) {
      body.style.maxHeight = body.scrollHeight + 'px';
      body.offsetHeight;
      body.style.maxHeight = '0';
      card.classList.remove('open');
    } else {
      card.classList.add('open');
      body.style.maxHeight = body.scrollHeight + 'px';
      var onEnd = function () {
        if (card.classList.contains('open')) body.style.maxHeight = 'none';
        body.removeEventListener('transitionend', onEnd);
      };
      body.addEventListener('transitionend', onEnd);
    }
  }
  window.toggleHistory = toggleHistory;

  function renderHeroDownload(data) {
    var el = document.getElementById('heroDownload');
    if (!el || !data.version || !data.files || !data.files.length) {
      if (el) el.innerHTML = '';
      return;
    }
    var platform = detectPlatform();
    var osName = getOSName(platform);
    if (!osName) { el.innerHTML = ''; return; }

    detectArchitecture(function (arch) {
      var best = findBestDownloadOption(data.files, arch, platform);
      if (!best || !best.filename) { el.innerHTML = ''; return; }
      var href = getDownloadHref(best, data.version);
      var external = isExternalLink(best);
      var targetAttr = external ? ' target="_blank" rel="noopener"' : '';
      el.innerHTML = '<div class="hero-download">'
        + '<a class="hero-download-btn" href="' + href + '"' + targetAttr + ' title="下载 ' + escapeHtml(best.label) + '">'
        + '<span class="dl-arrow">⤓</span> Download for ' + escapeHtml(osName)
        + '</a>'
        + '<p class="hero-download-hint">' + escapeHtml(best.label) + ' · ' + formatSize(best.size) + '</p>'
        + '</div>';
    });
  }

  function renderMainContent(data) {
    var el = document.getElementById('mainContent');
    if (!data.version || !data.files || !data.files.length) {
      el.innerHTML = '<div class="no-data"><div class="icon">📦</div><p>暂无已同步的安装包</p><p style="margin-top:8px;font-size:13px;">等待自动拉取或手动触发</p></div>';
      return;
    }
    el.innerHTML = renderVersionGrid(data.files, data.version)
      + renderHistorySection(data.history);
  }

  function renderPage(data) {
    document.getElementById('officialVer').textContent = data.officialVersion ? 'v' + data.officialVersion : '-';
    document.getElementById('mirrorVer').textContent = data.version ? 'v' + data.version : '未同步';

    renderStatusRow(data);
    renderHeroDownload(data);
    renderMainContent(data);

    var checkLast = data.lastCheckTime
      ? new Date(data.lastCheckTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : '-';
    var syncLast = data.lastSyncTime
      ? new Date(data.lastSyncTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : '-';
    document.getElementById('checkScheduleVal').textContent = data.checkSchedule || '每个整点';
    document.getElementById('checkLastVal').textContent = checkLast;
    document.getElementById('syncScheduleVal').textContent = data.syncSchedule || '-';
    document.getElementById('syncLastVal').textContent = syncLast;

    if (data.syncing && isLocal) {
      setSyncing(true);
      showLogPanel();
      connectSSE();
    }
  }

  // --- Init ---

  var host = location.hostname;
  isLocal = (host === 'localhost' || host === '127.0.0.1');

  if (!isLocal) {
    document.getElementById('logPanel').remove();
  }

  fetch('/api/page-data')
    .then(function (r) { return r.json(); })
    .then(renderPage)
    .catch(function (err) {
      console.error('Failed to load page data:', err);
    });
})();
