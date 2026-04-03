(function () {
  var sse = null;
  var logOpen = false;
  var isLocal = false;

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

    if (isLocal) {
      html += '<button class="sync-btn" id="syncBtn" onclick="triggerSync()">↻ 立即拉取</button>';
      html += '<button class="sync-btn abort-btn" id="abortBtn" onclick="abortSync()" style="display:none;background:#dc2626">■ 终止</button>';
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
      var verifiedBadge = f.verified ? '<span class="verified-badge" title="完整性校验通过">✓</span>' : '';
      return '<a class="file-row" href="/download/' + version + '/' + escapeHtml(f.filename) + '" title="下载 ' + escapeHtml(f.label) + '">'
        + '<span class="file-label">' + escapeHtml(f.label) + '</span>'
        + '<span class="file-meta">' + verifiedBadge + '<span class="file-size">' + formatSize(f.size) + '</span><span class="dl-icon">&#x2913;</span></span>'
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
      var date = h.updatedAt ? new Date(h.updatedAt).toLocaleDateString('zh-CN') : '';
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
