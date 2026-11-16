'use strict';
/**
 * 交友软广抓视频 & 案例拆解工作台（前端控制器）
 * 自动适配两种模式：
 *  1. 连接后台模式（在本机双击启动，或在 GitHub 网页填了主机地址）—— 全部抓取、传图分析、设置修改全开
 *  2. GitHub 纯网页只读模式（在任何别人电脑直接打开 GitHub.io 网址）—— 自动读 ./public_feed.json 展示大封面、案例和统计，不报错！
 */
(function () {
  const BACKEND_STORAGE_KEY = 'laya_scout_backend_url';
  const REMOTE_PIN_STORAGE_KEY = 'laya_scout_remote_pin';

  const state = {
    backendBase: '', // '' 表示同源；'http://127.0.0.1:3080' 或公网穿透地址表示已连后台；null 表示云端静态只读模式
    isReadOnlyCloud: false,
    isRemoteHost: false,
    remotePin: localStorage.getItem(REMOTE_PIN_STORAGE_KEY) || '',
    pendingRemoteUrl: '',
    hostComputerName: '',
    lastProbedTunnelUrl: '',
    currentView: 'dashboard',
    platformsSelected: new Set(['instagram', 'facebook', 'x', 'threads', 'tiktok']),
    timePreset: 'all',
    viralOnly: false,
    samples: [],
    allCloudSamples: [],
    cloudFeed: null,
    keywords: { brand: [], competitor: [], generic: [] },
    activeKwBucket: 'brand',
    activeKwGroup: 'ALL',
    customFields: [],
    settings: {},
    feishuOAuthUrl: '',
    caseImagesBase64: [], // 上传/粘贴待拆解的截图数组
    caseHistory: [],
    crawlTimer: null,
    crawlEventSource: null,
    cloudRefreshTimer: null,
    browserStatus: null,
    lastFinishedJobId: '',
    wasCrawlRunning: false,
  };

  /* ---------------- 通用工具 ---------------- */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    const num = Number(n || 0);
    if (num >= 10000) return (num / 10000).toFixed(1) + 'w';
    return num.toLocaleString('zh-CN');
  }

  function fmtTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { hour12: false }).slice(0, 16);
  }

  function toast(msg, type = 'info') {
    const box = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast-item ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function resolveCoverSrc(coverUrl) {
    if (!coverUrl) return '';
    if (coverUrl.startsWith('data:') || coverUrl.startsWith('http')) return coverUrl;
    if (coverUrl.startsWith('./') || coverUrl.startsWith('/')) {
      if (state.backendBase && !state.isReadOnlyCloud && coverUrl.startsWith('./covers/')) {
        return `${state.backendBase}/covers/${coverUrl.slice('./covers/'.length)}`;
      }
      return coverUrl;
    }
    return `./${coverUrl}`;
  }

  async function probeBackend(baseUrl, pin = state.remotePin) {
    const isFastLocal = !baseUrl || baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost');
    const timeoutMs = isFastLocal ? 1200 : 4000;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const headers = pin ? { 'X-Remote-Pin': pin } : {};
      const r = await fetch(`${baseUrl}/api/health?t=${Date.now()}`, { signal: controller.signal, headers });
      clearTimeout(t);
      if (!r.ok) return null;
      const json = await r.json().catch(() => null);
      return json && json.ok ? json : { ok: true };
    } catch (_) {
      return null;
    }
  }

  function openRemotePinModal(targetUrl = '') {
    const target = targetUrl || state.pendingRemoteUrl || state.backendBase || '';
    const lbl = document.getElementById('remote-pin-target-label');
    if (lbl) lbl.textContent = target || '主电脑在线通道';
    const inp = document.getElementById('inp-remote-pin');
    if (inp) {
      inp.value = state.remotePin || '';
      setTimeout(() => inp.focus(), 50);
    }
    const modal = document.getElementById('modal-remote-pin');
    if (modal) modal.classList.remove('hidden');
  }

  async function fetchCloudFeedSnapshot() {
    try {
      const resp = await fetch(`./public_feed.json?t=${Date.now()}`);
      if (!resp.ok) return null;
      const feed = await resp.json();
      state.cloudFeed = feed;
      return feed;
    } catch (_) {
      return null;
    }
  }

  async function detectConnectionMode() {
    const isGitHubPages = /\.github\.io$/i.test(window.location.hostname || '');
    state.pendingRemoteUrl = '';

    // 1. 先探测当前同源是不是本地/局域网后台（GitHub Pages 静态域名跳过）
    if (window.location.protocol !== 'file:' && !isGitHubPages) {
      const h = await probeBackend('');
      if (h && h.ok) {
        state.hostComputerName = h.hostComputer || state.hostComputerName;
        if (!h.remotePinRequired || h.pinVerified) {
          state.backendBase = '';
          state.isReadOnlyCloud = false;
          state.isRemoteHost = !h.isLocal;
          updateConnectionBanner();
          return;
        }
        state.pendingRemoteUrl = window.location.origin;
      }
    }

    // 2. 在主电脑自己打开 GitHub 网页时，优先走本机 127.0.0.1:3080 回环（免输口令）
    const localHealth = await probeBackend('http://127.0.0.1:3080');
    if (localHealth && localHealth.ok && (!localHealth.remotePinRequired || localHealth.pinVerified)) {
      state.backendBase = 'http://127.0.0.1:3080';
      state.isReadOnlyCloud = false;
      state.isRemoteHost = false;
      state.hostComputerName = localHealth.hostComputer || '';
      updateConnectionBanner();
      return;
    }

    // 3. 在其他电脑打开 GitHub 网页时，自动读取 ./public_feed.json 里主电脑发布的加密公网穿透地址（以及用户曾手填的地址）
    const feed = await fetchCloudFeedSnapshot();
    const savedHost = (localStorage.getItem(BACKEND_STORAGE_KEY) || '').replace(/\/+$/, '');
    const tunnelFromFeed = String((feed && feed.remoteTunnelUrl) || '').replace(/\/+$/, '');
    if (tunnelFromFeed) state.lastProbedTunnelUrl = tunnelFromFeed;

    const candidates = Array.from(new Set([tunnelFromFeed, savedHost].filter(Boolean)));
    for (const url of candidates) {
      // 在 https:// 网页下浏览器会拦截非回环 http:// 内网请求，跳过明确不兼容地址避免白等
      if (window.location.protocol === 'https:' && /^http:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url)) {
        continue;
      }
      const h = await probeBackend(url);
      if (h && h.ok) {
        state.hostComputerName = h.hostComputer || (feed && feed.hostComputer) || '';
        if (!h.remotePinRequired || h.pinVerified) {
          state.backendBase = url;
          state.isReadOnlyCloud = false;
          state.isRemoteHost = !h.isLocal;
          state.pendingRemoteUrl = '';
          updateConnectionBanner();
          return;
        }
        state.pendingRemoteUrl = url;
        break;
      }
    }

    // 4. 还没通过口令解锁，或主电脑当前未开机在线 -> 先展示 GitHub 云端公开快照（不报错）
    state.backendBase = null;
    state.isReadOnlyCloud = true;
    state.isRemoteHost = false;
    if (feed && !state.hostComputerName) state.hostComputerName = feed.hostComputer || '';
    updateConnectionBanner();
  }

  function updateConnectionBanner() {
    const dot = document.getElementById('conn-dot');
    const title = document.getElementById('conn-mode-title');
    const desc = document.getElementById('conn-mode-desc');
    const btnBackend = document.getElementById('btn-set-backend-url');
    const btnPush = document.getElementById('btn-top-push-github');
    const btnUnlock = document.getElementById('btn-unlock-remote');
    const btnWake = document.getElementById('btn-wake-host');

    if (!state.isReadOnlyCloud) {
      dot.className = 'conn-dot';
      if (state.isRemoteHost) {
        title.textContent = `🟢 已加密直连主电脑「${state.hostComputerName || '主机'}」（跨网实时同步 · 可改词 · 可开抓）`;
        desc.textContent = '任何操作与主电脑实时同步，抓完自动推上飞书和本网页';
      } else {
        title.textContent = '🟢 已连上本机运行后台（可抓视频 · 可拆案例 · 可同步）';
        desc.textContent = state.backendBase ? `正在控制后台：${state.backendBase}` : '本机直接运行中，操作全部实时生效';
      }
      btnBackend.classList.add('hidden');
      if (btnUnlock) btnUnlock.classList.add('hidden');
      if (btnWake) btnWake.classList.remove('hidden');
      btnPush.classList.remove('hidden');
    } else if (state.pendingRemoteUrl) {
      dot.className = 'conn-dot cloud';
      const updated = state.cloudFeed?.updatedAt ? fmtTime(state.cloudFeed.updatedAt) : '刚刚';
      const hostName = state.hostComputerName || state.cloudFeed?.hostComputer || '主电脑';
      title.textContent = `🔐 已发现主电脑「${hostName}」在线！输入口令即可远程改词开抓`;
      desc.textContent = `先预览云端同步的数据（${updated}）；点右侧输入 1 次口令（默认 8888）即永久记住`;
      if (btnUnlock) btnUnlock.classList.remove('hidden');
      if (btnWake) btnWake.classList.add('hidden');
      btnBackend.classList.remove('hidden');
      btnPush.classList.add('hidden');
    } else {
      dot.className = 'conn-dot cloud';
      const updated = state.cloudFeed?.updatedAt ? fmtTime(state.cloudFeed.updatedAt) : '刚刚';
      const hostName = state.cloudFeed?.hostComputer || '主电脑';
      title.textContent = '🌐 正在看 GitHub 云端同步过来的最新视频和案例';
      desc.textContent = `上次从「${hostName}」同步时间：${updated}（当前电脑仅看结果，待主电脑开机连网后自动可连）`;
      if (btnUnlock) btnUnlock.classList.add('hidden');
      if (btnWake) btnWake.classList.add('hidden');
      btnBackend.classList.remove('hidden');
      btnPush.classList.add('hidden');
    }
  }

  async function api(url, method = 'GET', body = null) {
    if (state.isReadOnlyCloud) {
      if (state.pendingRemoteUrl) {
        openRemotePinModal(state.pendingRemoteUrl);
        throw new Error('请先输入一次主电脑远程口令（默认 8888），验证通过后就能在这台电脑操作啦！');
      }
      throw new Error('这台电脑现在是只看网页模式，主电脑后台暂未开机上线。如需在本地电脑直接抓取，请点右上角「换别的电脑怎么也用来抓」。');
    }
    const headers = {};
    if (state.remotePin) {
      headers['X-Remote-Pin'] = state.remotePin;
    }
    const opts = { method, headers };
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${state.backendBase || ''}${url}`, opts);
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401 && data && data.needPin) {
      const targetUrl = state.backendBase || window.location.origin;
      state.remotePin = '';
      localStorage.removeItem(REMOTE_PIN_STORAGE_KEY);
      state.pendingRemoteUrl = targetUrl;
      state.isReadOnlyCloud = true;
      updateConnectionBanner();
      openRemotePinModal(targetUrl);
      throw new Error(data.error || '请重新输入主电脑远程控制口令');
    }
    if (!resp.ok || data.error) {
      throw new Error(data.error || `操作失败 (${resp.status})`);
    }
    return data;
  }

  /* ---------------- 菜单切换 ---------------- */
  function switchView(viewName) {
    state.currentView = viewName;
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });
    const filterBar = document.getElementById('sticky-filter-bar');
    filterBar.classList.toggle('hidden', !['dashboard', 'results'].includes(viewName));

    if (viewName === 'results') loadSamples();
    if (viewName === 'analyzer') loadCaseHistory();
    if (viewName === 'keywords' && !state.isReadOnlyCloud) loadKeywords();
    if (viewName === 'trash') loadTrashAndLogs();
    if (viewName === 'settings' && !state.isReadOnlyCloud) loadSettingsExtras();
  }

  function renderTopAlerts(alerts = []) {
    const bar = document.getElementById('top-alert-container');
    if (!alerts.length) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    bar.innerHTML = alerts
      .map(
        (a) => `
      <div class="alert-banner-row">
        <div>
          <strong>🚨 ${esc(a.title)}</strong>
          <span style="margin-left:8px;">${esc(a.message)}</span>
        </div>
        <button class="alert-dismiss-btn" data-dismiss-alert="${esc(a.id)}">知道了，关闭提醒</button>
      </div>`
      )
      .join('');
  }

  /* ---------------- 渲染实时抓取进度框 & 黑板 ---------------- */
  function renderLiveCrawlState(job) {
    const panel = document.getElementById('live-crawl-panel');
    const blackboard = document.getElementById('dash-live-blackboard');

    const logs = (job && job.liveLogs) || [];
    if (logs.length) {
      blackboard.innerHTML = logs
        .map((l) => `<div class="live-log-row">[${esc(l.time)}] ${esc(l.text)}</div>`)
        .join('');
    } else {
      blackboard.innerHTML = `<div class="muted-small">还没有新的抓取动态，点右上角「⚡ 选日期抓新视频」立刻开抓！</div>`;
    }

    if (job && job.running) {
      panel.classList.remove('hidden');
      document.getElementById('live-crawl-title').textContent = job.currentStep || '正在抓取中…';
      document.getElementById('live-browser-channel').textContent = job.browserChannelLabel || '防封浏览器通道';
      document.getElementById('live-crawl-range').textContent = `日期：${job.dateRangeLabel || '不限'}`;
      const pct = Number(job.progressPct || 15);
      document.getElementById('live-crawl-pct').textContent = `${pct}%`;
      document.getElementById('live-crawl-bar').style.width = `${pct}%`;
      document.getElementById('live-cnt-fetched').textContent = Number(job.fetchedCount || 0);
      document.getElementById('live-cnt-qualified').textContent = Number(job.qualifiedCount || 0);
      document.getElementById('live-cnt-trash').textContent = Number(job.filteredCount || 0);
      document.getElementById('live-cnt-feishu').textContent = Number(job.feishuSyncedCount || 0);

      const coversEl = document.getElementById('live-recent-covers');
      const recents = Array.isArray(job.recentFoundSamples) ? job.recentFoundSamples : [];
      if (recents.length) {
        coversEl.classList.remove('hidden');
        coversEl.innerHTML = recents
          .map(
            (s) => `
          <div class="live-cover-thumb" data-zoom-cover="${esc(resolveCoverSrc(s.coverUrl))}" data-zoom-title="${esc(s.title || '刚抓到的样本')}">
            <img src="${esc(resolveCoverSrc(s.coverUrl))}" alt="实时封面" loading="lazy" />
            <div class="live-cover-meta">${esc((s.platform || '').toUpperCase())} · ${Number(s.qualityScore || 0)}分</div>
          </div>`
          )
          .join('');
      } else {
        coversEl.classList.add('hidden');
        coversEl.innerHTML = '';
      }

      document.getElementById('live-crawl-logs').innerHTML = logs
        .slice(0, 8)
        .map((l) => `<div class="live-log-row">[${esc(l.time)}] ${esc(l.text)}</div>`)
        .join('');
    } else {
      panel.classList.add('hidden');
    }
  }

  /* ---------------- 读取防封浏览器状态（比特/AdsPower/0元专用窗） ---------------- */
  async function loadBrowserStatus() {
    if (state.isReadOnlyCloud) return;
    try {
      const res = await api('/api/browser/status');
      state.browserStatus = res;
      const badge = document.getElementById('fp-browser-status');
      const quota = document.getElementById('fp-quota-label');
      const sel = document.getElementById('fp-profile-select');
      if (!badge || !quota || !sel) return;

      const online = res.bitbrowserOnline || res.adspowerOnline || res.dedicatedOnline;
      badge.textContent = online ? '✅ 防封窗口已就绪' : '⏳ 待点右侧按钮打开防封窗口';
      quota.textContent = `今日防封搜词安全计数：${res.todaySearchCount || 0} / ${res.maxDailySearchesPerAccount || 30} 次（支持 比特浏览器 / AdsPower / 0元Edge专用防封窗）`;

      const profiles = Array.isArray(res.profiles) ? res.profiles : [];
      const opts = profiles.map(
        (p) => `<option value="${esc(p.source + ':' + p.id)}" data-source="${esc(p.source)}" data-name="${esc(p.name)}">${esc(p.source === 'bitbrowser' ? '[比特浏览器] ' : p.source === 'adspower' ? '[AdsPower] ' : '[0元防封窗] ')}${esc(p.name)}${p.remark ? ' - ' + esc(p.remark) : ''}</option>`
      );
      if (!profiles.some((p) => p.source === 'dedicated')) {
        opts.push('<option value="dedicated:default" data-source="dedicated" data-name="0元专用防封独立窗口">🛡️ 0元专用防封独立窗口（Edge/Chrome，免装第三方插件）</option>');
      }
      sel.innerHTML = opts.join('');
      if (res.selectedProfileId) {
        const matched = Array.from(sel.options).find((o) => o.value.endsWith(':' + res.selectedProfileId) || o.value === res.selectedProfileId);
        if (matched) sel.value = matched.value;
      }
    } catch (_) {
      // 忽略首次连接瞬时抖动
    }
  }

  /* ---------------- 首页总览加载（支持云端只读 & 本地直连双通道） ---------------- */
  async function loadBootstrap() {
    if (state.isReadOnlyCloud) {
      const feed = state.cloudFeed || (await fetchCloudFeedSnapshot());
      if (!feed) throw new Error('还没找到云端数据快照 public_feed.json，请先在主电脑点一次「同步到 GitHub 网页」');
      state.cloudFeed = feed;
      state.allCloudSamples = feed.samples || [];
      state.caseHistory = feed.caseAnalyses || [];
      updateConnectionBanner();
      renderDashboardData(feed.dashboard, feed.keywordsCount, feed.crawlJob, null);

      if (!state.cloudRefreshTimer) {
        state.cloudRefreshTimer = setInterval(async () => {
          if (!state.isReadOnlyCloud) return;
          const freshFeed = await fetchCloudFeedSnapshot();
          if (!freshFeed) return;
          state.cloudFeed = freshFeed;
          const newTunnel = String(freshFeed.remoteTunnelUrl || '').replace(/\/+$/, '');
          if (newTunnel && newTunnel !== state.lastProbedTunnelUrl) {
            await detectConnectionMode();
            if (!state.isReadOnlyCloud) {
              await loadBootstrap();
              if (state.currentView === 'results') await loadSamples();
              return;
            }
          }
          state.allCloudSamples = freshFeed.samples || [];
          state.caseHistory = freshFeed.caseAnalyses || [];
          updateConnectionBanner();
          renderDashboardData(freshFeed.dashboard, freshFeed.keywordsCount, freshFeed.crawlJob, null);
          if (state.currentView === 'results') await loadSamples();
        }, 25000);
      }
      return;
    }

    if (state.cloudRefreshTimer) {
      clearInterval(state.cloudRefreshTimer);
      state.cloudRefreshTimer = null;
    }

    const data = await api('/api/bootstrap');
    state.customFields = data.customFields || [];
    state.settings = data.settings || {};
    renderTopAlerts(data.activeAlerts || []);
    renderDashboardData(data.dashboard, data.keywordsCount, data.crawlJob, data);
    populateSettingsForm(state.settings, data.originUrl);
    loadBrowserStatus().catch(() => {});

    // 只要处于在线连接状态，始终保持实时进度流订阅，实现跨电脑画面/抓取状态双向同步
    if (!state.crawlEventSource) {
      connectCrawlStream();
    }
  }

  function renderDashboardData(dash, kwCounts, crawlJob, fullBootstrap) {
    const pDay = dash.periods.day;
    const pWeek = dash.periods.week;
    const pMonth = dash.periods.month;
    const calcRate = (q, t) => (t > 0 ? `留存率 ${Math.round((q / t) * 100)}%` : '暂未抓取');

    document.getElementById('stat-day-total').textContent = pDay.total;
    document.getElementById('stat-day-qual').textContent = pDay.qualified;
    document.getElementById('stat-day-trash').textContent = pDay.filtered;
    document.getElementById('stat-day-rate').textContent = calcRate(pDay.qualified, pDay.total);

    document.getElementById('stat-week-total').textContent = pWeek.total;
    document.getElementById('stat-week-qual').textContent = pWeek.qualified;
    document.getElementById('stat-week-trash').textContent = pWeek.filtered;
    document.getElementById('stat-week-rate').textContent = calcRate(pWeek.qualified, pWeek.total);

    document.getElementById('stat-month-total').textContent = pMonth.total;
    document.getElementById('stat-month-qual').textContent = pMonth.qualified;
    document.getElementById('stat-month-trash').textContent = pMonth.filtered;
    document.getElementById('stat-month-rate').textContent = calcRate(pMonth.qualified, pMonth.total);

    document.getElementById('nav-badge-samples').textContent = dash.periods.allTime.qualified;
    document.getElementById('nav-badge-trash').textContent = dash.periods.allTime.filtered;
    document.getElementById('nav-badge-keywords').textContent =
      (kwCounts?.brand || 0) + (kwCounts?.competitor || 0) + (kwCounts?.generic || 0);

    document.getElementById('dash-total-viral').textContent = dash.totalViralCount;
    document.getElementById('platform-ratio-list').innerHTML = (dash.platformBreakdown || [])
      .map(
        (p) => `
      <div class="plat-bar-item">
        <div class="plat-bar-meta">
          <span><strong>${esc(p.name)}</strong> · 好视频 ${p.count} 条（占 ${p.ratioPct}%）</span>
          <span class="text-ok">🔥 万赞爆款 ${p.viralCount} 条</span>
        </div>
        <div class="plat-bar-track">
          <div class="plat-bar-fill" style="width:${Math.max(p.count > 0 ? 4 : 0, p.ratioPct)}%;background:${esc(p.color)};"></div>
        </div>
      </div>`
      )
      .join('');

    renderLiveCrawlState(crawlJob);

    if (fullBootstrap && dash.feishuStatus) {
      const fsEl = document.getElementById('dash-feishu-state');
      const fsReady = dash.feishuStatus.authorized || dash.feishuStatus.hasWebhook || dash.feishuStatus.hasAppConfig;
      fsEl.textContent = dash.feishuStatus.authorized
        ? `✅ 已绑定：${dash.feishuStatus.userName}`
        : dash.feishuStatus.hasWebhook
        ? '✅ Webhook 实时通道已开'
        : dash.feishuStatus.hasAppConfig
        ? '✅ 飞书多维表格已连接'
        : '⏳ 待绑定或填 Webhook';
      fsEl.className = 'health-value ' + (fsReady ? 'text-ok' : 'text-warn');
      document.getElementById('dash-feishu-sub').textContent = `${dash.feishuStatus.lastSyncStatus} · 待发 ${dash.feishuStatus.pendingQueueCount} 条`;
      document.getElementById('side-feishu-label').textContent = dash.feishuStatus.authorized
        ? dash.feishuStatus.userName
        : dash.feishuStatus.hasWebhook
        ? 'Webhook直连'
        : dash.feishuStatus.hasAppConfig
        ? '应用直连'
        : '待绑定';
      const prov = state.settings.visionLlm?.provider || 'local_free';
      document.getElementById('side-vision-label').textContent =
        prov === 'local_free' ? '🆓 0费用引擎' : state.settings.visionLlm?.hasApiKey ? '外部AI看图已开' : '0费用保底中';
      document.getElementById('side-cron-label').textContent = (state.settings.schedule?.dailyTimes || ['08:00', '17:30']).join(' / ');
    }

    if (dash.proxySummary) {
      const px = dash.proxySummary;
      const pxEl = document.getElementById('dash-proxy-rate');
      pxEl.textContent = px.configured ? `${px.availabilityPct}% 能连上` : '未导入（用本机网络）';
      pxEl.className = 'health-value ' + (px.configured && px.availabilityPct < 30 ? 'text-danger' : 'text-ok');
    }

    const failBody = document.getElementById('dash-recent-failures');
    const fails = dash.recentFailures || [];
    failBody.innerHTML = fails.length
      ? fails
          .map(
            (f) =>
              `<tr><td>${fmtTime(f.time)}</td><td><strong>${esc(String(f.platform).toUpperCase())}</strong></td><td>${esc(f.detail)}</td></tr>`
          )
          .join('')
      : `<tr><td colspan="3" class="text-center muted-small">目前一切正常，没有报错拦截</td></tr>`;
  }

  /* ---------------- 大封面好视频列表 ---------------- */
  function buildFilterQueryParams() {
    const params = new URLSearchParams();
    params.set('platforms', Array.from(state.platformsSelected).join(','));
    params.set('category', document.getElementById('flt-category').value);
    params.set('timePreset', state.timePreset);

    if (state.timePreset === 'day') {
      const sp = document.getElementById('flt-specific-date').value;
      if (sp) params.set('specificDate', sp);
    } else if (state.timePreset === 'custom') {
      const s = document.getElementById('flt-start-date').value;
      const e = document.getElementById('flt-end-date').value;
      if (s) params.set('startDate', s);
      if (e) params.set('endDate', e);
    }
    const ct = document.getElementById('flt-content-type').value;
    if (ct !== 'all') params.set('contentType', ct);
    const minL = document.getElementById('flt-min-likes').value;
    if (minL) params.set('minLikes', minL);
    const minP = document.getElementById('flt-min-plays').value;
    if (minP) params.set('minPlays', minP);
    const maxD = document.getElementById('flt-max-diff').value;
    if (maxD && maxD !== '0') params.set('maxDifficulty', maxD);
    const used = document.getElementById('flt-used-state').value;
    if (used !== 'all') params.set('usedState', used);
    params.set('sortBy', document.getElementById('flt-sort').value);
    const q = document.getElementById('flt-q').value.trim();
    if (q) params.set('q', q);
    if (state.viralOnly) params.set('viralOnly', 'true');
    return params;
  }

  function fmtLocalDateYmd(dateInput) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function filterCloudSamplesLocally(allList) {
    const q = buildFilterQueryParams();
    let list = [...allList];
    const plats = (q.get('platforms') || '').split(',').filter(Boolean);
    if (plats.length) list = list.filter((s) => plats.includes(s.platform));
    const cat = q.get('category');
    if (cat && cat !== 'all') list = list.filter((s) => s.categoryGroup === cat);
    const ct = q.get('contentType');
    if (ct && ct !== 'all') {
      if (ct.startsWith('media:')) {
        const targetMedia = ct.slice('media:'.length);
        list = list.filter((s) => (s.mediaType || 'video') === targetMedia);
      } else {
        list = list.filter((s) => s.contentType === ct);
      }
    }

    const timePreset = q.get('timePreset') || 'all';
    const nowMs = Date.now();
    if (timePreset === 'day') {
      const targetDay = q.get('specificDate') || fmtLocalDateYmd(new Date());
      list = list.filter((s) => fmtLocalDateYmd(s.publishedAt) === targetDay);
    } else if (timePreset === '7d') {
      list = list.filter((s) => new Date(s.publishedAt || 0).getTime() >= nowMs - 7 * 86400000);
    } else if (timePreset === '30d') {
      list = list.filter((s) => new Date(s.publishedAt || 0).getTime() >= nowMs - 30 * 86400000);
    } else if (timePreset === 'custom') {
      const sDate = q.get('startDate');
      const eDate = q.get('endDate');
      const startMs = sDate ? new Date(`${sDate}T00:00:00`).getTime() : 0;
      const endMs = eDate ? new Date(`${eDate}T23:59:59.999`).getTime() : Infinity;
      list = list.filter((s) => {
        const t = new Date(s.publishedAt || 0).getTime();
        return t >= startMs && t <= endMs;
      });
    }

    const minLikes = Number(q.get('minLikes') || 0);
    if (minLikes > 0) list = list.filter((s) => Number(s.likes || 0) >= minLikes);
    const minPlays = Number(q.get('minPlays') || 0);
    if (minPlays > 0) list = list.filter((s) => Number(s.plays || 0) >= minPlays);
    const maxDiff = Number(q.get('maxDifficulty') || 0);
    if (maxDiff > 0) list = list.filter((s) => Number(s.implantDifficulty || 3) <= maxDiff);

    const usedState = q.get('usedState');
    if (usedState === 'unused') list = list.filter((s) => !s.markedUsed);
    else if (usedState === 'favorited') list = list.filter((s) => Boolean(s.favorited));
    else if (usedState === 'used') list = list.filter((s) => Boolean(s.markedUsed));

    if (q.get('viralOnly') === 'true') {
      const highLike = Number(state.settings.thresholds?.highLikeGreenThreshold || 10000);
      list = list.filter((s) => Number(s.likes || 0) >= highLike);
    }

    const kw = (q.get('q') || '').toLowerCase();
    if (kw) {
      list = list.filter((s) =>
        `${s.title || ''} ${s.fullText || ''} ${s.bgm || ''} ${(s.exposedBrands || []).join(' ')}`.toLowerCase().includes(kw)
      );
    }

    const sortBy = q.get('sortBy') || 'traffic_desc';
    list.sort((a, b) => {
      if (sortBy === 'traffic_desc') {
        return Number(b.likes || 0) - Number(a.likes || 0)
          || Number(b.plays || 0) - Number(a.plays || 0)
          || Number(b.comments || 0) - Number(a.comments || 0)
          || Number(b.qualityScore || 0) - Number(a.qualityScore || 0);
      }
      if (sortBy === 'laya_viral') {
        const textA = `${a.title || ''} ${a.fullText || ''} ${a.matchedKeyword || ''}`;
        const textB = `${b.title || ''} ${b.fullText || ''} ${b.matchedKeyword || ''}`;
        const layaA = a.categoryGroup === 'brand' || /laya|拉雅/i.test(textA) ? 1 : 0;
        const layaB = b.categoryGroup === 'brand' || /laya|拉雅/i.test(textB) ? 1 : 0;
        if (layaA !== layaB) return layaB - layaA;
        return Number(b.likes || 0) * 10 + Number(b.plays || 0) - (Number(a.likes || 0) * 10 + Number(a.plays || 0));
      }
      if (sortBy === 'likes_desc') return Number(b.likes || 0) - Number(a.likes || 0) || Number(b.plays || 0) - Number(a.plays || 0);
      if (sortBy === 'plays_desc') return Number(b.plays || 0) - Number(a.plays || 0) || Number(b.likes || 0) - Number(a.likes || 0);
      if (sortBy === 'comments_desc') return Number(b.comments || 0) - Number(a.comments || 0) || Number(b.likes || 0) - Number(a.likes || 0);
      if (sortBy === 'time_desc') return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
      if (sortBy === 'difficulty_asc') return Number(a.implantDifficulty || 3) - Number(b.implantDifficulty || 3);
      const scoreDiff = Number(b.qualityScore || 0) - Number(a.qualityScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
    });
    return list;
  }

  async function loadSamples() {
    if (state.isReadOnlyCloud) {
      const list = filterCloudSamplesLocally(state.allCloudSamples);
      state.samples = list;
      document.getElementById('results-count-label').textContent = `(云端展示 ${list.length} 条)`;
      return renderSampleCards(list);
    }
    const params = buildFilterQueryParams();
    const res = await api(`/api/samples?${params.toString()}`);
    state.samples = res.items || [];
    document.getElementById('results-count-label').textContent = `(筛出 ${res.total} 条 / 共 ${res.allCount} 条)`;
    renderSampleCards(state.samples);
  }

  function renderSampleCards(list) {
    const grid = document.getElementById('samples-card-grid');
    if (!list.length) {
      grid.innerHTML = `<div class="panel-card text-center" style="grid-column:1/-1;padding:48px;"><h3>这个条件下暂无视频</h3><p class="muted-small">点右上角「清空条件」或点左侧「选日期抓新视频」开抓吧！</p></div>`;
      return;
    }

    const highLikeThreshold = Number(state.settings.thresholds?.highLikeGreenThreshold || 10000);
    const highDiffStar = Number(state.settings.thresholds?.highDifficultyRedStar || 4);

    grid.innerHTML = list
      .map((s) => {
        const coverSrc = resolveCoverSrc(s.coverUrl);
        const stars = '★'.repeat(s.implantDifficulty || 2) + '☆'.repeat(Math.max(0, 5 - (s.implantDifficulty || 2)));
        const isViral = Number(s.likes || 0) >= highLikeThreshold;
        const isHighDiff = Number(s.implantDifficulty || 0) >= highDiffStar;
        const brandsHtml =
          s.exposedBrands && s.exposedBrands.length
            ? s.exposedBrands.map((b) => `<span class="s-tag brand">露出：${esc(b)}</span>`).join('')
            : `<span class="s-tag type">纯泛流量·好植入</span>`;

        const topCommentsHtml =
          s.topComments && s.topComments.length
            ? s.topComments
                .slice(0, 3)
                .map((c, idx) => `<div class="comment-line">💬 热评${idx + 1} [👍${fmtNum(c.likes)}]: ${esc(c.text)}</div>`)
                .join('')
            : `<div class="comment-line muted-small">暂无热评数据</div>`;

        return `
        <article class="sample-card ${s.markedUsed ? 'used-card' : ''}" data-id="${esc(s.id)}">
          <div class="sample-card-top">
            <div class="cover-box act-zoom-cover" data-cover="${esc(coverSrc)}" data-title="${esc(s.title)}" data-link="${esc(s.videoUrl)}" title="点击放大看封面大图">
              <img src="${esc(coverSrc)}" alt="视频封面" loading="lazy" />
              <span class="cover-plat-badge">${esc(s.platform.toUpperCase())}</span>
              <span class="cover-score-badge">${Number(s.qualityScore || 0)}分</span>
              <span class="cover-safe-badge">✓ 无露脸·非游戏</span>
              <span class="cover-dur-badge">${s.mediaType === 'text' ? '📝 纯文字' : s.mediaType === 'image' ? '🖼️ 图文' : `🎬 ${Number(s.durationSec || 15)}s`}</span>
            </div>

            <div class="sample-info-col">
              <h3 class="sample-title">${esc(s.title)}</h3>
              <div class="sample-copy">${esc(s.fullText)}</div>
              <div class="sample-meta-line">
                <span>📅 ${fmtTime(s.publishedAt)}</span>
                <span>🎵 ${esc((s.bgm || '原声').slice(0, 20))}</span>
                <span>👤 @${esc(s.authorHandle)} (${fmtNum(s.authorFollowers)}粉)</span>
              </div>
              <div class="auto-tags-wrap">
                <span class="s-tag type">${esc(s.contentType)}</span>
                ${brandsHtml}
                <span class="s-tag ${isHighDiff ? 'diff-high' : 'diff-low'}">照抄难度: ${stars}</span>
                ${isViral ? '<span class="s-tag viral">🔥 过万赞爆款</span>' : ''}
              </div>
            </div>
          </div>

          <div class="metrics-strip">
            <div><small>浏览/播放</small><strong>${fmtNum(s.plays)}</strong></div>
            <div class="${isViral ? 'viral-like' : ''}"><small>点赞</small><strong>${fmtNum(s.likes)}</strong></div>
            <div><small>评论</small><strong>${fmtNum(s.comments)}</strong></div>
            <div><small>转发</small><strong>${fmtNum(s.shares)}</strong></div>
            <div><small>收藏</small><strong>${fmtNum(s.bookmarks)}</strong></div>
          </div>

          <div class="top-comments-box">${topCommentsHtml}</div>

          <div class="sample-actions-bar">
            <div class="inline-btns">
              <a href="${esc(s.videoUrl)}" target="_blank" rel="noopener" class="btn btn-ghost btn-xs">🔗 查看原帖/原视频</a>
              <button class="btn btn-ghost btn-xs act-fav" data-id="${esc(s.id)}">${s.favorited ? '⭐ 已收藏' : '☆ 收藏'}</button>
              <button class="btn btn-ghost btn-xs act-used" data-id="${esc(s.id)}">${s.markedUsed ? '✅ 已用过' : '⬜ 标为已用'}</button>
              <button class="btn btn-danger-outline btn-xs act-spam" data-id="${esc(s.id)}" data-handle="${esc(s.authorHandle)}">🚫 踢掉拉黑</button>
            </div>
            <button class="btn btn-primary btn-xs act-guide" data-id="${esc(s.id)}">💡 怎么抄 & 插广告指南</button>
          </div>
        </article>`;
      })
      .join('');
  }

  /* ---------------- 丢链接 / 传截图拆解案例 ---------------- */
  function renderUploadPreviews() {
    const strip = document.getElementById('an-preview-strip');
    strip.innerHTML = state.caseImagesBase64
      .map(
        (src, idx) => `
      <div class="preview-thumb">
        <img src="${src}" alt="截图${idx + 1}" />
        <button type="button" data-rm-img="${idx}" title="移除这张图">✕</button>
      </div>`
      )
      .join('');
  }

  function handleImageFiles(files) {
    Array.from(files || []).forEach((file) => {
      if (!file.type || !file.type.startsWith('image/')) return;
      if (state.caseImagesBase64.length >= 4) return toast('最多同时放 4 张截图哦', 'info');
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.caseImagesBase64.push(ev.target.result);
        renderUploadPreviews();
      };
      reader.readAsDataURL(file);
    });
  }

  function renderCaseReport(caseItem) {
    const rep = caseItem.report || {};
    const pit = rep.pitfallCheck || {};
    const box = document.getElementById('an-result-box');
    document.getElementById('an-engine-tag').textContent = `${rep.engineLabel || '拆解完成'} · 推荐指数 ${rep.score || 85} 分`;

    const coverHtml = caseItem.coverUrl
      ? `<img src="${esc(resolveCoverSrc(caseItem.coverUrl))}" style="width:120px;height:160px;object-fit:cover;border-radius:10px;border:1px solid #cbd5e1;" />`
      : '';

    box.innerHTML = `
      <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:14px;">
        ${coverHtml}
        <div>
          <h3 style="margin:0 0 6px;font-size:17px;">${esc(rep.summaryTitle || caseItem.extractedTitle)}</h3>
          <p class="muted-small" style="margin:0 0 6px;">类型：<strong>${esc(rep.contentType || '聊天录屏类')}</strong> ${caseItem.url ? `· <a href="${esc(caseItem.url)}" target="_blank">打开原链接</a>` : ''}</p>
          <div class="s-tag ${pit.safeToCopy === false ? 'diff-high' : 'safe'}" style="white-space:normal;padding:6px 10px;">
            ${esc(pit.conclusion || '安全可照抄')}
          </div>
        </div>
      </div>

      <div class="sop-block">
        <h4>🔥 为什么能火（抓住了男生什么心理）？</h4>
        <ul style="margin:4px 0;padding-left:18px;">
          ${(rep.whyViral || []).map((w) => `<li>${esc(w)}</li>`).join('')}
        </ul>
      </div>

      <div class="sop-block">
        <h4>🎬 手把手照抄步骤（第几秒怎么改）</h4>
        <ol style="margin:4px 0;padding-left:18px;">
          ${(rep.stepByStepCopy || []).map((s) => `<li>${esc(s)}</li>`).join('')}
        </ol>
      </div>

      <div class="sop-block">
        <h4>✍️ 3 套可以直接复制去发的新文案（带评论区一唱一和话术）</h4>
        ${(rep.readyScripts || [])
          .map(
            (sc, i) => `
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-top:8px;">
            <strong>${esc(sc.styleName || `文案套路 ${i + 1}`)}</strong>
            <div style="font-size:12.5px;margin-top:4px;"><b>画面大字/对话：</b>${esc(sc.videoText)}</div>
            <div style="font-size:12.5px;margin-top:3px;"><b>发帖正文：</b>${esc(sc.caption)}</div>
            <div style="font-size:12.5px;margin-top:3px;color:#4f46e5;"><b>评论区配合：</b>${esc(sc.commentHook)}</div>
          </div>`
          )
          .join('')}
      </div>

      <div class="inline-btns mt-10">
        <button id="btn-save-case-to-samples" data-caseid="${esc(caseItem.id)}" class="btn btn-success">
          ${caseItem.savedToSamples ? '✅ 已存入好视频库' : '📥 把这个案例存进「抓到的好视频」库'}
        </button>
      </div>
    `;

    const saveBtn = document.getElementById('btn-save-case-to-samples');
    if (saveBtn && !caseItem.savedToSamples && !state.isReadOnlyCloud) {
      saveBtn.onclick = async () => {
        await api('/api/analyze/save-to-samples', 'POST', { id: caseItem.id });
        saveBtn.textContent = '✅ 已存入好视频库';
        saveBtn.disabled = true;
        toast('已存进「抓到的好视频」库，并自动排入飞书同步队列！', 'success');
        loadBootstrap();
      };
    }
  }

  async function loadCaseHistory() {
    let items = state.caseHistory || [];
    if (!state.isReadOnlyCloud) {
      const res = await api('/api/analyze/list');
      items = res.items || [];
      state.caseHistory = items;
    }
    document.getElementById('nav-badge-cases').textContent = items.length;
    const grid = document.getElementById('an-history-grid');
    if (!items.length) {
      grid.innerHTML = `<div class="muted-small">还没有拆解过的案例，试着在上面扔个链接或贴一张聊天截图吧！</div>`;
      return;
    }
    grid.innerHTML = items
      .map(
        (c) => `
      <div class="case-hist-card">
        <img src="${esc(resolveCoverSrc(c.coverUrl))}" alt="案例封面" />
        <div>
          <strong style="display:block;margin-bottom:4px;">${esc((c.report && c.report.summaryTitle) || c.extractedTitle || '拆解案例')}</strong>
          <div class="muted-small" style="margin-bottom:6px;">${fmtTime(c.createdAt)} · 推荐 ${c.report?.score || 85}分</div>
          <div style="font-size:12px;color:#475569;margin-bottom:8px;">${esc((c.userNote || c.extractedText || '').slice(0, 48))}</div>
          <button class="btn btn-primary btn-xs btn-view-case" data-id="${esc(c.id)}">看完整拆解报告</button>
        </div>
      </div>`
      )
      .join('');
  }

  /* ---------------- SSE 实时抓取流（保持长连双向同步，断线自动降级轮询） ---------------- */
  async function handleLiveJobSnapshot(job) {
    renderLiveCrawlState(job);
    if (job && job.running) {
      state.wasCrawlRunning = true;
      return;
    }
    if (job && !job.running && job.finishedAt && job.id && job.id !== state.lastFinishedJobId) {
      const finishedAgo = Date.now() - new Date(job.finishedAt).getTime();
      const shouldNotify = state.wasCrawlRunning || (!Number.isNaN(finishedAgo) && finishedAgo < 12000);
      state.lastFinishedJobId = job.id;
      state.wasCrawlRunning = false;
      if (shouldNotify) {
        toast(`抓完了！留下好内容 ${job.qualifiedAdded || 0} 条，踢掉无关/废片 ${job.filteredTrash || 0} 条`, 'success');
        await loadBootstrap();
        if (state.currentView === 'keywords') await loadKeywords();
        if (state.currentView === 'results') await loadSamples();
      }
    }
  }

  function connectCrawlStream() {
    if (state.isReadOnlyCloud) return;
    if (typeof EventSource !== 'function') return startCrawlPolling();
    if (state.crawlEventSource) {
      try {
        state.crawlEventSource.close();
      } catch (_) {}
      state.crawlEventSource = null;
    }
    if (state.crawlTimer) {
      clearInterval(state.crawlTimer);
      state.crawlTimer = null;
    }
    try {
      const pinQs = state.remotePin ? `?pin=${encodeURIComponent(state.remotePin)}` : '';
      const es = new EventSource(`${state.backendBase || ''}/api/crawl/stream${pinQs}`);
      state.crawlEventSource = es;
      es.onmessage = async (ev) => {
        try {
          const job = JSON.parse(ev.data || '{}');
          await handleLiveJobSnapshot(job);
        } catch (_) {}
      };
      es.onerror = () => {
        try {
          es.close();
        } catch (_) {}
        if (state.crawlEventSource === es) state.crawlEventSource = null;
        startCrawlPolling();
      };
    } catch (_) {
      startCrawlPolling();
    }
  }

  /* ---------------- 轮询实时抓取进度（空闲期低频保活监听跨电脑抓取） ---------------- */
  function startCrawlPolling() {
    if (state.crawlTimer) clearInterval(state.crawlTimer);
    let tick = 0;
    state.crawlTimer = setInterval(async () => {
      if (state.isReadOnlyCloud) {
        clearInterval(state.crawlTimer);
        state.crawlTimer = null;
        return;
      }
      tick += 1;
      try {
        const job = await api('/api/crawl/status');
        await handleLiveJobSnapshot(job);
        if (!job.running && tick % 6 === 0) {
          connectCrawlStream();
        }
      } catch (_) {
        clearInterval(state.crawlTimer);
        state.crawlTimer = null;
      }
    }, 3000);
  }

  /* ---------------- 其他模块（指南、词库、废片回收站、设置） ---------------- */
  function openImplantGuideModal(sampleId) {
    const s = state.samples.find((x) => x.id === sampleId);
    if (!s) return;
    const g = s.implantGuide || {};
    const steps = Array.isArray(s.replicationSteps) ? s.replicationSteps : [];
    document.getElementById('guide-modal-title').textContent = `💡 怎么改才像自然爆款（综合 ${s.qualityScore} 分）`;
    document.getElementById('guide-modal-body').innerHTML = `
      <div class="sop-block"><h4>⏱️ 第几秒插广告最自然</h4><strong>${esc(g.exactTiming || '')}</strong></div>
      <div class="sop-block"><h4>🎬 画面上怎么露出来</h4><div>${esc(g.visualHook || '')}</div></div>
      <div class="sop-block"><h4>✍️ 文案与评论区一唱一和话术</h4><p>${esc(g.copyScript || '')}</p><p style="color:#4f46e5;">${esc(g.commentSeedScript || '')}</p></div>
      <div class="sop-block"><h4>🛠️ 照抄 4 步走</h4><ol style="padding-left:18px;">${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>
    `;
    document.getElementById('modal-guide').classList.remove('hidden');
  }

  async function loadKeywords() {
    const res = await api('/api/keywords');
    state.keywords = res.keywords || { brand: [], competitor: [], generic: [] };
    renderKeywordManager();
  }

  function renderKeywordManager() {
    ['brand', 'competitor', 'generic'].forEach((b) => {
      document.getElementById(`kw-cnt-${b}`).textContent = (state.keywords[b] || []).length;
    });
    const list = state.keywords[state.activeKwBucket] || [];
    const groups = Array.from(new Set(list.map((k) => k.group || '默认')));
    document.getElementById('kw-group-filter-bar').innerHTML = [
      `<button class="chip ${state.activeKwGroup === 'ALL' ? 'active' : ''}" data-kwgrp="ALL">全部 (${list.length})</button>`,
      ...groups.map((g) => `<button class="chip ${state.activeKwGroup === g ? 'active' : ''}" data-kwgrp="${esc(g)}">${esc(g)}</button>`),
    ].join('');
    const filtered = state.activeKwGroup === 'ALL' ? list : list.filter((x) => (x.group || '默认') === state.activeKwGroup);
    document.getElementById('kw-table-body').innerHTML = filtered.length
      ? filtered
          .map(
            (k) => `<tr>
          <td><button class="chip ${k.enabled !== false ? 'active' : ''}" data-kwtoggle="${esc(k.id)}">${k.enabled !== false ? '开启' : '关闭'}</button></td>
          <td><strong>${esc(k.word)}</strong></td>
          <td><span class="s-tag type">${esc(k.group || '默认')}</span></td>
          <td>${esc((k.synonyms || []).join(' / ') || '自动匹配备选词')}</td>
          <td>
            <div class="inline-btns">
              <button class="btn btn-primary btn-xs" data-kwrun="${esc(k.word)}">⚡ 只抓此词</button>
              <button class="btn btn-danger-outline btn-xs" data-kwdel="${esc(k.id)}">删掉</button>
            </div>
          </td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="text-center muted-small">暂无搜索词</td></tr>`;
  }

  async function loadTrashAndLogs() {
    let data;
    if (state.isReadOnlyCloud) {
      data = { trash: state.cloudFeed?.trash || [], blacklist: { accounts: [], keywords: [] }, rateLimitLogs: [], operationLogs: state.cloudFeed?.recentLogs || [] };
    } else {
      data = await api('/api/trash-and-logs');
    }
    const tbody = document.getElementById('trash-table-body');
    tbody.innerHTML = (data.trash || []).length
      ? data.trash
          .map(
            (t) => `<tr>
          <td><img src="${esc(resolveCoverSrc(t.coverUrl))}" style="width:62px;height:82px;object-fit:cover;border-radius:6px;background:#0f172a;" /></td>
          <td><strong>${esc((t.platform || '').toUpperCase())}</strong></td>
          <td><span class="s-tag diff-high">${esc(t.filterCategory || '自动踢掉')}</span></td>
          <td><strong>${esc(t.title)}</strong><br/><small class="text-danger">${esc(t.vetoReason)}</small></td>
          <td>@${esc(t.authorHandle || '-')}</td>
          <td>${state.isReadOnlyCloud ? '-' : `<button class="btn btn-primary btn-xs btn-restore-trash" data-id="${esc(t.id)}">↩️ 救回好视频库</button>`}</td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="6" class="text-center muted-small">没有被踢掉的废片</td></tr>`;

    if (!state.isReadOnlyCloud) {
      document.getElementById('blk-acc-list').innerHTML = (data.blacklist?.accounts || [])
        .map((a) => `<span class="manage-chip">@${esc(a.handle)} <button data-rm-acc="${esc(a.id)}">✕</button></span>`)
        .join('');
      document.getElementById('blk-kw-list').innerHTML = (data.blacklist?.keywords || [])
        .map((k) => `<span class="manage-chip">${esc(k.word)} <button data-rm-blkkw="${esc(k.id)}">✕</button></span>`)
        .join('');
      document.getElementById('ratelimit-table-body').innerHTML = (data.rateLimitLogs || [])
        .map((r) => `<tr><td>${fmtTime(r.time)}</td><td>${esc(r.platform)}</td><td>${esc(r.proxyLabel)}</td><td>${esc(r.keyword)} → ${esc(r.fallbackKeyword)}</td><td>${r.retryCount}</td><td>${esc(r.reason)}</td></tr>`)
        .join('');
    }
    document.getElementById('oplogs-table-body').innerHTML = (data.operationLogs || [])
      .map((l) => `<tr><td>${fmtTime(l.time)}</td><td>${esc(l.operator)}</td><td>${esc(l.module)}</td><td>${esc(l.action)}</td><td>${esc(l.status)}</td><td>${esc(l.detail)}</td></tr>`)
      .join('');
  }

  async function loadSettingsExtras() {
    const tools = await api('/api/tools/status');
    const ytPill = document.getElementById('ytdlp-status-pill');
    const sideYt = document.getElementById('side-ytdlp-label');
    if (tools.ytdlp?.installed) {
      ytPill.textContent = '✅ 已安装（可高清扒封面）';
      sideYt.textContent = '高清已装';
    } else {
      ytPill.textContent = '⏳ 未安装（用网页兜底抓图中）';
      sideYt.textContent = '点设置可装';
    }

    const gh = tools.github || {};
    document.getElementById('gh-status-pill').textContent = gh.remoteUrl ? `✅ 已连仓库` : '待填仓库地址';
    if (gh.remoteUrl && !document.getElementById('cfg-gh-repo').value) {
      document.getElementById('cfg-gh-repo').value = gh.remoteUrl;
    }
    if (gh.pagesUrl) {
      document.getElementById('gh-pages-link-box').innerHTML = `全团队任何电脑可直接打开查看的地址：<a href="${esc(gh.pagesUrl)}" target="_blank">${esc(gh.pagesUrl)}</a>`;
    }

    const packBox = document.getElementById('preset-pack-buttons');
    packBox.innerHTML = (tools.presetPacks || [])
      .map((p) => `<button type="button" class="btn btn-ghost btn-sm btn-import-pack" data-packid="${esc(p.id)}">🎁 导入「${esc(p.name)}」(${p.count}个热词)</button>`)
      .join('');

    const pxRes = await api('/api/proxies');
    document.getElementById('proxy-table-body').innerHTML = (pxRes.proxies || [])
      .map((p) => `<tr><td>${esc(p.region)}</td><td><code>${esc(p.host)}:${p.port}</code></td><td>${esc(p.status)}</td><td>${p.latencyMs || '--'}ms</td><td><button class="btn btn-ghost btn-xs" data-del-proxy="${esc(p.id)}">删</button></td></tr>`)
      .join('');
  }

  function populateSettingsForm(s) {
    if (!s) return;
    document.getElementById('cfg-brand-name').value = s.brandName || 'Laya';
    document.getElementById('cfg-brand-pos').value = s.brandPositioning || '';
    document.getElementById('cfg-collector-mode').value = s.collectorMode || 'fingerprint';
    document.getElementById('cfg-apify-token').value = s.thirdPartyApi?.apifyToken || '';
    document.getElementById('cfg-custom-api-url').value = s.thirdPartyApi?.baseUrl || '';
    document.getElementById('cfg-vision-provider').value = s.visionLlm?.provider || 'local_free';
    document.getElementById('vision-key-hint').textContent = s.visionLlm?.hasApiKey ? '(已保存)' : '(0费用模式无需填写)';
    document.getElementById('cfg-vision-baseurl').value = s.visionLlm?.provider === 'openai_compatible' ? s.visionLlm?.openaiBaseUrl || 'https://api.openai.com/v1' : s.visionLlm?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    document.getElementById('cfg-vision-model').value = s.visionLlm?.provider === 'openai_compatible' ? s.visionLlm?.openaiModel || 'gpt-4o-mini' : s.visionLlm?.model || 'gemini-3.8-flash';
    document.getElementById('cfg-vision-fallback').checked = s.visionLlm?.allowOfflineFallbackForTest !== false;

    const fp = s.fingerprintBrowser || {};
    document.getElementById('cfg-fp-biturl').value = fp.bitbrowserUrl || 'http://127.0.0.1:54345';
    document.getElementById('cfg-fp-bitkey').value = '';
    document.getElementById('cfg-fp-bitkey').placeholder = fp.hasBitbrowserToken ? '已保存密钥（不改留空）' : '选填';
    document.getElementById('cfg-fp-adsurl').value = fp.adspowerUrl || 'http://127.0.0.1:50325';
    document.getElementById('cfg-fp-port').value = fp.customDebugPort ?? 9222;
    document.getElementById('cfg-fp-delay-min').value = fp.humanDelayMinSec ?? 6;
    document.getElementById('cfg-fp-delay-max').value = fp.humanDelayMaxSec ?? 14;
    document.getElementById('cfg-fp-daily-max').value = fp.maxDailySearchesPerAccount ?? 30;

    document.getElementById('cfg-sched-times').value = (s.schedule?.dailyTimes || ['08:00', '17:30']).join(', ');
    document.getElementById('cfg-min-score').value = s.thresholds?.minQualityScore ?? 60;
    document.getElementById('cfg-min-plays').value = s.thresholds?.minPlays ?? 3000;
    document.getElementById('cfg-min-likes').value = s.thresholds?.minLikes ?? 150;
    document.getElementById('cfg-min-followers').value = s.thresholds?.minAuthorFollowers ?? 1000;
    document.getElementById('cfg-int-ig').value = s.antiCrawl?.intervalsSec?.instagram ?? 12;
    document.getElementById('cfg-int-fb').value = s.antiCrawl?.intervalsSec?.facebook ?? 10;
    document.getElementById('cfg-int-x').value = s.antiCrawl?.intervalsSec?.x ?? 8;
    document.getElementById('cfg-int-th').value = s.antiCrawl?.intervalsSec?.threads ?? 10;
    document.getElementById('cfg-int-tt').value = s.antiCrawl?.intervalsSec?.tiktok ?? 10;
    document.getElementById('cfg-gh-repo').value = s.githubSync?.repoUrl || '';
    document.getElementById('cfg-gh-branch').value = s.githubSync?.branch || 'main';
    document.getElementById('cfg-gh-autopush').checked = s.githubSync?.autoPushAfterCrawl !== false;

    const rc = s.remoteControl || {};
    const rcPinEl = document.getElementById('cfg-remote-pin');
    const rcAutoEl = document.getElementById('cfg-remote-autostart');
    const rcTunnelEl = document.getElementById('cfg-remote-tunnel-label');
    if (rcPinEl) {
      rcPinEl.value = rc.pin || '';
      rcPinEl.placeholder = rc.hasPin ? '已保存口令（不改留空，默认 8888）' : '默认 8888';
    }
    if (rcAutoEl) rcAutoEl.checked = rc.autoStartEnabled ?? rc.autoStartGuardian ?? true;
    if (rcTunnelEl) {
      rcTunnelEl.textContent = rc.tunnelUrl
        ? `公网穿透已在线：${rc.tunnelUrl}`
        : '后台守护启动穿透后会自动生成（公网网址仅推送至 GitHub，口令永不上传）';
    }

    const fs = s.feishu || {};
    document.getElementById('cfg-fs-docurl').value = fs.targetDocUrl || '';
    document.getElementById('cfg-fs-mastertab').checked = fs.masterTab !== false;
    document.getElementById('cfg-fs-dailytab').checked = fs.dailyDateTab !== false;
    document.getElementById('cfg-fs-rtwebhook').value = fs.realtimeWebhookUrl || '';
    document.getElementById('cfg-fs-appid').value = fs.appId || '';
    document.getElementById('cfg-fs-secret').placeholder = fs.hasSecret ? '已保存密钥（不改留空）' : '不改可以留空';
    document.getElementById('cfg-fs-mode').value = fs.targetMode || 'spreadsheet';
    document.getElementById('cfg-fs-split').value = fs.splitBy || 'platform';
    document.getElementById('cfg-fs-folder').value = fs.folderToken || '';
    document.getElementById('cfg-fs-webhook').value = fs.alertWebhookUrl || '';
    document.getElementById('feishu-auth-badge').textContent = fs.authorized
      ? `✅ 已扫码绑定：${fs.userName}`
      : fs.hasSecret && fs.appId
      ? '✅ 应用密钥与多维表格已填好'
      : fs.realtimeWebhookUrl || fs.targetDocUrl
      ? '✅ Webhook/文档链接已填'
      : '待扫码绑定或填 Webhook';
    document.getElementById('cfg-fs-fields-box').innerHTML = (fs.syncFields || [])
      .map((f) => `<label class="check-pill"><input type="checkbox" class="fs-sync-field-chk" data-fkey="${esc(f.key)}" ${f.enabled ? 'checked' : ''} ${f.required ? 'disabled' : ''} /><span>${esc(f.label)}</span></label>`)
      .join('');
    document.getElementById('custom-fields-list').innerHTML = (state.customFields || [])
      .map((cf) => `<span class="manage-chip"><strong>${esc(cf.label)}</strong> <button data-del-cf="${esc(cf.id)}">✕</button></span>`)
      .join('');
  }

  async function saveAllSettings() {
    const provider = document.getElementById('cfg-vision-provider').value;
    const baseUrlVal = document.getElementById('cfg-vision-baseurl').value.trim();
    const modelVal = document.getElementById('cfg-vision-model').value.trim();
    const visionKey = document.getElementById('cfg-vision-key').value.trim();
    const syncFields = (state.settings.feishu?.syncFields || []).map((f) => {
      const chk = document.querySelector(`.fs-sync-field-chk[data-fkey="${f.key}"]`);
      return { ...f, enabled: f.required ? true : Boolean(chk && chk.checked) };
    });

    const fpSel = document.getElementById('fp-profile-select');
    const fpVal = fpSel ? fpSel.value : '';
    let selectedProfileId = state.settings.fingerprintBrowser?.selectedProfileId || '';
    let selectedProfileName = state.settings.fingerprintBrowser?.selectedProfileName || '';
    let fpProvider = state.settings.fingerprintBrowser?.provider || 'auto';
    if (fpVal && fpVal.includes(':')) {
      const idx = fpVal.indexOf(':');
      const src = fpVal.slice(0, idx);
      const id = fpVal.slice(idx + 1);
      selectedProfileId = id;
      selectedProfileName = fpSel.options[fpSel.selectedIndex]?.dataset?.name || selectedProfileName;
      if (src === 'dedicated') fpProvider = 'dedicated';
    }

    await api('/api/settings/save', 'POST', {
      brandName: document.getElementById('cfg-brand-name').value.trim(),
      brandPositioning: document.getElementById('cfg-brand-pos').value.trim(),
      collectorMode: document.getElementById('cfg-collector-mode').value,
      fingerprintBrowser: {
        provider: fpProvider,
        bitbrowserUrl: document.getElementById('cfg-fp-biturl').value.trim() || 'http://127.0.0.1:54345',
        bitbrowserToken: document.getElementById('cfg-fp-bitkey').value.trim() || undefined,
        adspowerUrl: document.getElementById('cfg-fp-adsurl').value.trim() || 'http://127.0.0.1:50325',
        customDebugPort: Number(document.getElementById('cfg-fp-port').value || 9222),
        humanDelayMinSec: Number(document.getElementById('cfg-fp-delay-min').value || 6),
        humanDelayMaxSec: Number(document.getElementById('cfg-fp-delay-max').value || 14),
        maxDailySearchesPerAccount: Number(document.getElementById('cfg-fp-daily-max').value || 30),
        selectedProfileId,
        selectedProfileName,
      },
      thirdPartyApi: { apifyToken: document.getElementById('cfg-apify-token').value.trim(), baseUrl: document.getElementById('cfg-custom-api-url').value.trim() },
      visionLlm: {
        provider,
        apiKey: visionKey || undefined,
        baseUrl: provider === 'gemini' ? baseUrlVal : state.settings.visionLlm?.baseUrl,
        openaiBaseUrl: provider === 'openai_compatible' ? baseUrlVal : state.settings.visionLlm?.openaiBaseUrl,
        model: provider === 'gemini' ? modelVal : state.settings.visionLlm?.model,
        openaiModel: provider === 'openai_compatible' ? modelVal : state.settings.visionLlm?.openaiModel,
        allowOfflineFallbackForTest: document.getElementById('cfg-vision-fallback').checked,
      },
      schedule: { enabled: true, dailyTimes: document.getElementById('cfg-sched-times').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) },
      thresholds: {
        minQualityScore: Number(document.getElementById('cfg-min-score').value || 60),
        minPlays: Number(document.getElementById('cfg-min-plays').value || 3000),
        minLikes: Number(document.getElementById('cfg-min-likes').value || 150),
        minAuthorFollowers: Number(document.getElementById('cfg-min-followers').value || 1000),
      },
      antiCrawl: {
        intervalsSec: {
          instagram: Number(document.getElementById('cfg-int-ig').value || 12),
          facebook: Number(document.getElementById('cfg-int-fb').value || 10),
          x: Number(document.getElementById('cfg-int-x').value || 8),
          threads: Number(document.getElementById('cfg-int-th').value || 10),
          tiktok: Number(document.getElementById('cfg-int-tt').value || 10),
        },
      },
      feishu: {
        targetDocUrl: document.getElementById('cfg-fs-docurl').value.trim(),
        masterTab: document.getElementById('cfg-fs-mastertab').checked,
        dailyDateTab: document.getElementById('cfg-fs-dailytab').checked,
        realtimeWebhookUrl: document.getElementById('cfg-fs-rtwebhook').value.trim(),
        appId: document.getElementById('cfg-fs-appid').value.trim(),
        appSecret: document.getElementById('cfg-fs-secret').value.trim() || undefined,
        targetMode: document.getElementById('cfg-fs-mode').value,
        splitBy: document.getElementById('cfg-fs-split').value,
        folderToken: document.getElementById('cfg-fs-folder').value.trim(),
        alertWebhookUrl: document.getElementById('cfg-fs-webhook').value.trim(),
        syncFields,
      },
      githubSync: {
        repoUrl: document.getElementById('cfg-gh-repo').value.trim(),
        branch: document.getElementById('cfg-gh-branch').value.trim() || 'main',
        autoPushAfterCrawl: document.getElementById('cfg-gh-autopush').checked,
      },
      remoteControl: {
        enabled: true,
        pin: document.getElementById('cfg-remote-pin')?.value.trim() || undefined,
        autoStartGuardian: Boolean(document.getElementById('cfg-remote-autostart')?.checked),
      },
    });
    const savedPin = document.getElementById('cfg-remote-pin')?.value.trim();
    if (savedPin) {
      state.remotePin = savedPin;
      localStorage.setItem(REMOTE_PIN_STORAGE_KEY, savedPin);
    }
    toast('设置已保存并生效！', 'success');
    await loadBootstrap();
  }

  /* ---------------- 全部按钮绑定 ---------------- */
  function bindEvents() {
    window.addEventListener('unhandledrejection', (e) => {
      const msg = (e && e.reason && e.reason.message) || '';
      if (msg) toast(msg, 'error');
    });
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    document.querySelectorAll('[data-goto]').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.goto)));
    document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => document.getElementById(btn.dataset.close).classList.add('hidden')));

    document.getElementById('btn-open-clone-help').addEventListener('click', () => document.getElementById('modal-clone-help').classList.remove('hidden'));
    document.getElementById('btn-set-backend-url').addEventListener('click', () => document.getElementById('modal-clone-help').classList.remove('hidden'));
    document.getElementById('btn-unlock-remote')?.addEventListener('click', () => openRemotePinModal(state.pendingRemoteUrl));

    const submitRemotePin = async () => {
      const targetUrl = (state.pendingRemoteUrl || localStorage.getItem(BACKEND_STORAGE_KEY) || state.cloudFeed?.remoteTunnelUrl || '').replace(/\/+$/, '');
      const pin = (document.getElementById('inp-remote-pin')?.value || '').trim();
      if (!targetUrl) return toast('暂未检测到主电脑在线通道，请确认主电脑开机联网且已运行工作台', 'error');
      if (!pin) return toast('请输入主电脑远程控制口令（默认 8888）', 'error');

      const btn = document.getElementById('btn-confirm-remote-pin');
      if (btn) btn.disabled = true;
      try {
        const resp = await fetch(`${targetUrl}/api/remote/verify-pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Remote-Pin': pin },
          body: JSON.stringify({ pin }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || '口令验证失败，请核对后再试');
        }
        state.remotePin = pin;
        localStorage.setItem(REMOTE_PIN_STORAGE_KEY, pin);
        state.backendBase = targetUrl;
        state.isReadOnlyCloud = false;
        state.isRemoteHost = true;
        state.pendingRemoteUrl = '';
        state.hostComputerName = data.hostComputer || state.hostComputerName;
        document.getElementById('modal-remote-pin').classList.add('hidden');
        updateConnectionBanner();
        toast(`🔓 口令通过！已连上主电脑「${state.hostComputerName || '主机'}」，现在可自由搜词同步抓取`, 'success');

        await loadBootstrap();
        await loadSamples();
        await loadCaseHistory();
        if (state.currentView === 'keywords') await loadKeywords();
        if (state.currentView === 'settings') await loadSettingsExtras();

        if (document.getElementById('chk-wake-bitbrowser-on-connect')?.checked) {
          api('/api/remote/wake-workbench', 'POST', { openProfile: true })
            .then((w) => {
              if (w && w.message) toast(w.message, w.bitbrowserOnline ? 'success' : 'info');
              loadBrowserStatus();
            })
            .catch(() => {});
        }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    document.getElementById('btn-confirm-remote-pin')?.addEventListener('click', submitRemotePin);
    document.getElementById('inp-remote-pin')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitRemotePin();
    });

    document.getElementById('btn-wake-host')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-wake-host');
      if (btn) btn.disabled = true;
      try {
        toast('正在通知主电脑检查并启动工作台和比特浏览器窗口…', 'info');
        const res = await api('/api/remote/wake-workbench', 'POST', { openProfile: true, openHostBrowser: false });
        toast(res.message || '主电脑工作台与比特浏览器已就绪', res.bitbrowserOnline ? 'success' : 'info');
        await loadBrowserStatus();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    document.getElementById('btn-save-backend-url').addEventListener('click', async () => {
      const url = document.getElementById('inp-custom-backend-url').value.trim().replace(/\/+$/, '');
      if (!url) return;
      localStorage.setItem(BACKEND_STORAGE_KEY, url);
      document.getElementById('modal-clone-help').classList.add('hidden');
      await detectConnectionMode();
      await loadBootstrap();
      if (state.isReadOnlyCloud && state.pendingRemoteUrl) {
        openRemotePinModal(state.pendingRemoteUrl);
      } else {
        toast(state.isReadOnlyCloud ? '这台地址还没连上，确认那台电脑开着工作台且浏览器未拦截HTTP' : '已成功连上后台电脑！', state.isReadOnlyCloud ? 'error' : 'success');
      }
    });

    // 一键同步到 GitHub 网页
    const pushGh = async () => {
      try {
        toast('正在把最新大封面、抓取结果和案例同步上传到 GitHub…', 'info');
        const repoUrl = document.getElementById('cfg-gh-repo').value.trim();
        const branch = document.getElementById('cfg-gh-branch').value.trim() || 'main';
        const res = await api('/api/github/push', 'POST', { repoUrl, branch });
        toast(res.pagesUrl ? `同步成功！任何电脑打开 ${res.pagesUrl} 都能看` : '已同步到 GitHub 仓库！', 'success');
        if (state.currentView === 'settings') loadSettingsExtras();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    document.getElementById('btn-top-push-github').addEventListener('click', pushGh);
    document.getElementById('btn-settings-push-gh').addEventListener('click', pushGh);

    // 抓取日期预设快速填充
    document.getElementById('mc-date-presets').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      document.querySelectorAll('#mc-date-presets .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const r = btn.dataset.range;
      const fromEl = document.getElementById('mc-date-from');
      const toEl = document.getElementById('mc-date-to');
      const today = new Date();
      if (r === 'all') {
        fromEl.value = '';
        toEl.value = '';
      } else if (r === 'today') {
        fromEl.value = fmtLocalDateYmd(today);
        toEl.value = fmtLocalDateYmd(today);
      } else if (r === '3d' || r === '7d' || r === '30d') {
        const days = parseInt(r, 10);
        const start = new Date(today.getTime() - (days - 1) * 24 * 3600 * 1000);
        fromEl.value = fmtLocalDateYmd(start);
        toEl.value = fmtLocalDateYmd(today);
      } else if (r === 'custom') {
        fromEl.focus();
      }
    });

    const openCrawl = () => document.getElementById('modal-crawl').classList.remove('hidden');
    document.getElementById('qa-manual-crawl').addEventListener('click', openCrawl);
    document.getElementById('btn-open-crawl-modal').addEventListener('click', openCrawl);

    document.getElementById('btn-confirm-crawl').addEventListener('click', async () => {
      if (state.isReadOnlyCloud && state.pendingRemoteUrl) {
        openRemotePinModal(state.pendingRemoteUrl);
        toast('请先输入一次主电脑口令，验证后点开始抓即可！', 'info');
        return;
      }
      const platforms = Array.from(document.querySelectorAll('.mc-plat:checked')).map((el) => el.value);
      const buckets = Array.from(document.querySelectorAll('.mc-bucket:checked')).map((el) => el.value);
      const customKeywords = document.getElementById('mc-custom-keywords').value.trim();
      const saveCustomKeywords = document.getElementById('mc-save-custom-kw').checked;
      const clearExisting = document.getElementById('mc-clear-old').checked;
      const maxTotalCandidates = Number(document.getElementById('mc-limit').value || 80);
      const dateFrom = document.getElementById('mc-date-from').value;
      const dateTo = document.getElementById('mc-date-to').value;
      const modeOverride = document.getElementById('mc-mode').value;
      const useAsync = Boolean(state.isRemoteHost || (state.backendBase && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(state.backendBase)));
      document.getElementById('modal-crawl').classList.add('hidden');

      connectCrawlStream();
      try {
        const res = await api('/api/crawl/run', 'POST', {
          platforms,
          buckets,
          customKeywords,
          saveCustomKeywords,
          clearExisting,
          maxTotalCandidates,
          dateFrom,
          dateTo,
          modeOverride,
          async: useAsync,
          fastTest: true,
        });
        if (res.started || res.alreadyRunning) {
          state.wasCrawlRunning = true;
          toast(
            res.alreadyRunning
              ? '主电脑当前正在抓取中，已为您同步直播进度…'
              : '🚀 已派发给主电脑开始抓词！两边页面会同步显示进度，抓完自动刷新并推送飞书与 GitHub',
            'info'
          );
          return;
        }
        const r = res.result || {};
        if (r.alreadyRunning) {
          state.wasCrawlRunning = true;
          toast('主电脑当前正在抓取中，已为您同步直播进度…', 'info');
          return;
        }
        state.lastFinishedJobId = r.id || state.lastFinishedJobId;
        state.wasCrawlRunning = false;
        toast(`抓完了！留下好内容 ${r.qualifiedAdded || 0} 条，踢掉无关/废片 ${r.filteredTrash || 0} 条`, 'success');
        await loadBootstrap();
        if (state.currentView === 'keywords') await loadKeywords();
        if (state.currentView === 'results') await loadSamples();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    // 实时封面直播条点击放大看大图
    document.getElementById('live-recent-covers').addEventListener('click', (e) => {
      const thumb = e.target.closest('.live-cover-thumb');
      if (!thumb) return;
      document.getElementById('zoom-modal-title').textContent = thumb.dataset.zoomTitle || '实时抓到的样本封面';
      document.getElementById('zoom-modal-img').src = thumb.dataset.zoomCover || '';
      document.getElementById('zoom-modal-link').href = '#';
      document.getElementById('modal-cover-zoom').classList.remove('hidden');
    });

    // 防封静默浏览器通道按钮（重新检测 / 0元防封独立窗 / 打开选中的指纹浏览器环境）
    document.getElementById('btn-fp-refresh').addEventListener('click', async () => {
      await loadBrowserStatus();
      toast('已重新检测比特浏览器 / AdsPower / 0元防封窗口状态', 'info');
    });
    document.getElementById('btn-fp-launch-free').addEventListener('click', async () => {
      const btn = document.getElementById('btn-fp-launch-free');
      btn.disabled = true;
      try {
        const res = await api('/api/browser/launch-free', 'POST', { startUrl: 'https://www.instagram.com/' });
        toast(res.message || '0元防封独立窗口已打开！请在里面登录好 IG/X/FB/Threads 账号，之后就能后台静默抓', 'success');
        await loadBrowserStatus();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
    document.getElementById('btn-fp-open-profile').addEventListener('click', async () => {
      const sel = document.getElementById('fp-profile-select');
      const val = sel ? sel.value : 'dedicated:default';
      if (!val || val.startsWith('dedicated:')) {
        return document.getElementById('btn-fp-launch-free').click();
      }
      const idx = val.indexOf(':');
      const source = val.slice(0, idx);
      const profileId = val.slice(idx + 1);
      const opt = sel.options[sel.selectedIndex];
      const profileName = (opt && opt.dataset && opt.dataset.name) || (opt && opt.textContent) || profileId;
      const btn = document.getElementById('btn-fp-open-profile');
      btn.disabled = true;
      try {
        await api('/api/browser/open-profile', 'POST', { source, profileId, profileName });
        toast(`已唤起指纹环境「${profileName}」！确认里面已登录社媒账号后点上方开抓即可`, 'success');
        await loadBrowserStatus();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    // 丢链接 / 传截图拆解案例事件
    const dropzone = document.getElementById('an-dropzone');
    const fileInput = document.getElementById('an-file-input');
    dropzone.addEventListener('click', (e) => {
      if (!e.target.closest('button')) fileInput.click();
    });
    fileInput.addEventListener('change', (e) => handleImageFiles(e.target.files));
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleImageFiles(e.dataTransfer.files);
    });
    document.addEventListener('paste', (e) => {
      if (state.currentView !== 'analyzer') return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) files.push(it.getAsFile());
      }
      if (files.length) handleImageFiles(files);
    });
    document.getElementById('an-preview-strip').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rm-img]');
      if (!btn) return;
      e.stopPropagation();
      state.caseImagesBase64.splice(Number(btn.dataset.rmImg), 1);
      renderUploadPreviews();
    });

    document.getElementById('btn-run-case-analyze').addEventListener('click', async () => {
      const url = document.getElementById('an-url-input').value.trim();
      const userNote = document.getElementById('an-note-input').value.trim();
      const btn = document.getElementById('btn-run-case-analyze');
      btn.disabled = true;
      btn.textContent = '⏳ 正在扒封面和拆解案例，稍等几秒…';
      try {
        const res = await api('/api/analyze/case', 'POST', { url, imagesBase64: state.caseImagesBase64, userNote });
        renderCaseReport(res.caseItem);
        await loadCaseHistory();
        toast('案例拆解好了！', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '✨ 开始帮我拆解这个案例';
      }
    });

    document.getElementById('an-history-grid').addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-view-case');
      if (!btn) return;
      const found = state.caseHistory.find((c) => c.id === btn.dataset.id);
      if (found) {
        renderCaseReport(found);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    // 好视频卡片区事件（点封面放大、收藏、标已用、踢掉拉黑、看指南）
    document.getElementById('samples-card-grid').addEventListener('click', async (e) => {
      const zoomBox = e.target.closest('.act-zoom-cover');
      if (zoomBox) {
        document.getElementById('zoom-modal-title').textContent = zoomBox.dataset.title || '大封面预览';
        document.getElementById('zoom-modal-img').src = zoomBox.dataset.cover;
        document.getElementById('zoom-modal-link').href = zoomBox.dataset.link || '#';
        return document.getElementById('modal-cover-zoom').classList.remove('hidden');
      }
      const guideBtn = e.target.closest('.act-guide');
      if (guideBtn) return openImplantGuideModal(guideBtn.dataset.id);
      const favBtn = e.target.closest('.act-fav');
      if (favBtn) {
        await api(`/api/samples/${favBtn.dataset.id}/action`, 'POST', { action: 'toggleFavorite' });
        return loadSamples();
      }
      const usedBtn = e.target.closest('.act-used');
      if (usedBtn) {
        await api(`/api/samples/${usedBtn.dataset.id}/action`, 'POST', { action: 'toggleUsed' });
        return loadSamples();
      }
      const spamBtn = e.target.closest('.act-spam');
      if (spamBtn) {
        if (!window.confirm(`确定要踢掉这条并拉黑账号 @${spamBtn.dataset.handle} 吗？以后他的内容会自动拦截。`)) return;
        await api(`/api/samples/${spamBtn.dataset.id}/action`, 'POST', { action: 'markSpam', blockAccount: true });
        await loadBootstrap();
        return loadSamples();
      }
    });

    // 顶部筛选栏绑定
    const syncPlatUi = () => {
      document.querySelectorAll('.plat-chip').forEach((c) => c.classList.toggle('active', state.platformsSelected.has(c.dataset.plat)));
      document.getElementById('btn-plat-all').classList.toggle('active', state.platformsSelected.size === 5);
    };
    document.getElementById('btn-plat-all').addEventListener('click', () => {
      state.platformsSelected = new Set(['instagram', 'facebook', 'x', 'threads', 'tiktok']);
      syncPlatUi();
      switchView('results');
    });
    document.querySelectorAll('.plat-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const p = chip.dataset.plat;
        if (state.platformsSelected.has(p) && state.platformsSelected.size > 1) state.platformsSelected.delete(p);
        else state.platformsSelected.add(p);
        syncPlatUi();
        switchView('results');
      });
    });
    document.querySelectorAll('#flt-time-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#flt-time-seg .seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.timePreset = btn.dataset.time;
        document.getElementById('flt-specific-date').classList.toggle('hidden', state.timePreset !== 'day');
        document.getElementById('flt-custom-range').classList.toggle('hidden', state.timePreset !== 'custom');
        if (state.currentView === 'results') loadSamples();
      });
    });
    document.getElementById('btn-apply-filter').addEventListener('click', () => { state.viralOnly = false; switchView('results'); });
    document.getElementById('flt-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.viralOnly = false;
        switchView('results');
      }
    });
    ['flt-category', 'flt-content-type', 'flt-max-diff', 'flt-used-state', 'flt-sort', 'flt-specific-date', 'flt-start-date', 'flt-end-date'].forEach((id) => {
      document.getElementById(id).addEventListener('change', () => {
        if (state.currentView === 'results') loadSamples();
      });
    });
    document.getElementById('btn-reset-filter').addEventListener('click', () => {
      state.platformsSelected = new Set(['instagram', 'facebook', 'x', 'threads', 'tiktok']);
      syncPlatUi();
      state.timePreset = 'all';
      state.viralOnly = false;
      document.querySelectorAll('#flt-time-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.time === 'all'));
      document.getElementById('flt-specific-date').classList.add('hidden');
      document.getElementById('flt-custom-range').classList.add('hidden');
      document.getElementById('flt-specific-date').value = '';
      document.getElementById('flt-start-date').value = '';
      document.getElementById('flt-end-date').value = '';
      document.getElementById('flt-category').value = 'all';
      document.getElementById('flt-content-type').value = 'all';
      document.getElementById('flt-min-likes').value = '';
      document.getElementById('flt-min-plays').value = '';
      document.getElementById('flt-max-diff').value = '0';
      document.getElementById('flt-used-state').value = 'all';
      document.getElementById('flt-sort').value = 'traffic_desc';
      document.getElementById('flt-q').value = '';
      loadSamples();
    });

    document.getElementById('qa-today-viral').addEventListener('click', () => {
      state.viralOnly = true;
      document.getElementById('flt-sort').value = 'likes_desc';
      switchView('results');
    });

    const runFeishuSyncNow = async (sampleIds = null) => {
      try {
        toast('正在把合格视频发到飞书表格…', 'info');
        const res = await api('/api/feishu/sync-now', 'POST', sampleIds ? { sampleIds } : {});
        toast(`同步处理完成：本次推了 ${res.synced || 0} 条`, 'success');
        await loadBootstrap();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    document.getElementById('qa-sync-feishu').addEventListener('click', () => runFeishuSyncNow());
    document.getElementById('btn-results-sync-feishu').addEventListener('click', () => {
      const ids = (state.samples || []).map((s) => s.id);
      runFeishuSyncNow(ids.length ? ids : null);
    });

    // 搜索词包与管理
    document.querySelectorAll('.kw-tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.kw-tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        state.activeKwBucket = t.dataset.bucket;
        state.activeKwGroup = 'ALL';
        renderKeywordManager();
      });
    });
    document.getElementById('btn-kw-pack-open').addEventListener('click', async () => {
      await loadSettingsExtras();
      document.getElementById('modal-kw-pack').classList.remove('hidden');
    });
    document.getElementById('preset-pack-buttons').addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-import-pack');
      if (!btn) return;
      const res = await api('/api/keywords/import-pack', 'POST', { packId: btn.dataset.packid });
      state.keywords = res.keywords;
      renderKeywordManager();
      loadBootstrap();
      toast(`导入「${res.packName}」成功，加了 ${res.added} 个热词！`, 'success');
    });
    document.getElementById('btn-kw-pull-url').addEventListener('click', async () => {
      const remoteUrl = document.getElementById('kw-remote-url').value.trim();
      const res = await api('/api/keywords/import-pack', 'POST', { remoteUrl, bucket: state.activeKwBucket });
      state.keywords = res.keywords;
      renderKeywordManager();
      toast(`从链接导入了 ${res.added} 个热词！`, 'success');
    });
    document.getElementById('btn-kw-add').addEventListener('click', async () => {
      const word = document.getElementById('kw-new-word').value.trim();
      const group = document.getElementById('kw-new-group').value.trim();
      const synonyms = document.getElementById('kw-new-synonyms').value.trim();
      const res = await api('/api/keywords/manage', 'POST', { bucket: state.activeKwBucket, action: 'add', word, group, synonyms });
      state.keywords = res.keywords;
      document.getElementById('kw-new-word').value = '';
      renderKeywordManager();
    });
    document.getElementById('btn-kw-batch-open').addEventListener('click', () => document.getElementById('modal-kw-import').classList.remove('hidden'));
    document.getElementById('btn-confirm-kw-import').addEventListener('click', async () => {
      const rawText = document.getElementById('kw-batch-textarea').value;
      const defaultGroup = document.getElementById('kw-batch-group').value.trim();
      const res = await api('/api/keywords/manage', 'POST', { bucket: state.activeKwBucket, action: 'batchImport', rawText, defaultGroup });
      state.keywords = res.keywords;
      document.getElementById('modal-kw-import').classList.add('hidden');
      renderKeywordManager();
      toast(`导入了 ${res.added} 个新词！`, 'success');
    });
    document.getElementById('btn-kw-crawl-enabled').addEventListener('click', () => {
      document.getElementById('mc-custom-keywords').value = '';
      document.getElementById('modal-crawl').classList.remove('hidden');
    });
    document.getElementById('kw-table-body').addEventListener('click', async (e) => {
      const runBtn = e.target.closest('[data-kwrun]');
      if (runBtn) {
        document.getElementById('mc-custom-keywords').value = runBtn.dataset.kwrun || '';
        document.getElementById('mc-save-custom-kw').checked = false;
        document.getElementById('modal-crawl').classList.remove('hidden');
        return;
      }
      const tog = e.target.closest('[data-kwtoggle]');
      if (tog) {
        const res = await api('/api/keywords/manage', 'POST', { bucket: state.activeKwBucket, action: 'toggle', id: tog.dataset.kwtoggle });
        state.keywords = res.keywords;
        return renderKeywordManager();
      }
      const del = e.target.closest('[data-kwdel]');
      if (del) {
        const res = await api('/api/keywords/manage', 'POST', { bucket: state.activeKwBucket, action: 'delete', id: del.dataset.kwdel });
        state.keywords = res.keywords;
        return renderKeywordManager();
      }
    });
    document.getElementById('kw-group-filter-bar').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-kwgrp]');
      if (!chip) return;
      state.activeKwGroup = chip.dataset.kwgrp;
      renderKeywordManager();
    });
    document.getElementById('btn-kw-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state.keywords || {}, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `laya-keywords-${fmtLocalDateYmd(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('词库备份已经导出到你电脑下载文件夹里了！', 'success');
    });

    // 废片回收站、黑名单与设置操作
    document.getElementById('btn-refresh-trash').addEventListener('click', () => loadTrashAndLogs());
    document.getElementById('btn-clear-trash').addEventListener('click', async () => {
      if (!window.confirm('确定把废片回收站彻底清空吗？清完之后里面的记录就不能救回了。')) return;
      await api('/api/trash/clear', 'POST', {});
      toast('废片回收站已清空！', 'success');
      await loadTrashAndLogs();
      await loadBootstrap();
    });
    document.getElementById('btn-add-blk-acc').addEventListener('click', async () => {
      const platform = document.getElementById('blk-acc-plat').value;
      const handle = document.getElementById('blk-acc-handle').value.trim();
      if (!handle) return toast('请先输入要拉黑的账号名', 'error');
      await api('/api/blacklist/manage', 'POST', { action: 'addAccount', platform, handle });
      document.getElementById('blk-acc-handle').value = '';
      toast(`已把 @${handle.replace(/^@/, '')} 加入黑名单`, 'success');
      loadTrashAndLogs();
    });
    document.getElementById('blk-acc-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-rm-acc]');
      if (!btn) return;
      await api('/api/blacklist/manage', 'POST', { action: 'removeAccount', id: btn.dataset.rmAcc });
      loadTrashAndLogs();
    });
    document.getElementById('btn-add-blk-kw').addEventListener('click', async () => {
      const word = document.getElementById('blk-kw-word').value.trim();
      if (!word) return toast('请先输入想屏蔽的词', 'error');
      await api('/api/blacklist/manage', 'POST', { action: 'addKeyword', word });
      document.getElementById('blk-kw-word').value = '';
      toast(`已屏蔽包含「${word}」的视频`, 'success');
      loadTrashAndLogs();
    });
    document.getElementById('blk-kw-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-rm-blkkw]');
      if (!btn) return;
      await api('/api/blacklist/manage', 'POST', { action: 'removeKeyword', id: btn.dataset.rmBlkkw });
      loadTrashAndLogs();
    });
    document.querySelectorAll('#trash-sub-tabs .sub-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#trash-sub-tabs .sub-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        ['trash-list', 'blacklist-mgr', 'ratelimit-logs', 'op-logs'].forEach((id) => {
          document.getElementById(`sub-${id}`).classList.toggle('hidden', id !== tab.dataset.sub);
        });
      });
    });
    document.getElementById('trash-table-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-restore-trash');
      if (!btn) return;
      await api('/api/trash/restore', 'POST', { id: btn.dataset.id });
      toast('已救回到「抓到的好视频」库！', 'success');
      await loadTrashAndLogs();
      await loadBootstrap();
    });

    document.getElementById('btn-save-all-settings').addEventListener('click', () => saveAllSettings().catch((err) => toast(err.message, 'error')));
    document.getElementById('btn-install-ytdlp').addEventListener('click', async () => {
      const btn = document.getElementById('btn-install-ytdlp');
      btn.disabled = true;
      btn.textContent = '⏳ 正在从 GitHub 下载安装插件（大约几十秒）…';
      try {
        await api('/api/tools/install-ytdlp', 'POST');
        toast('安装成功！现在贴视频链接都能自动扒高清封面了', 'success');
        await loadSettingsExtras();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ 一键从 GitHub 自动安装高清抓封面插件';
      }
    });
    document.getElementById('btn-test-vision').addEventListener('click', async () => {
      try {
        await saveAllSettings();
        const res = await api('/api/vision/test', 'POST', {});
        const msg =
          res.provider === 'local_free'
            ? res.message || `通了！0 费用本地引擎试审打分 ${res.sampleScore} 分（不收任何额外费用）`
            : res.ok
            ? `通了！外部 AI 试审打分 ${res.sampleScore} 分`
            : res.message;
        toast(msg, res.ok ? 'success' : 'error');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    document.getElementById('btn-feishu-oauth').addEventListener('click', async () => {
      try {
        await saveAllSettings();
        const res = await api('/api/feishu/oauth/url');
        state.feishuOAuthUrl = res.authUrl;
        document.getElementById('modal-feishu-qr').classList.remove('hidden');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    document.getElementById('btn-open-feishu-popup').addEventListener('click', () => {
      if (state.feishuOAuthUrl) window.open(state.feishuOAuthUrl, 'FeishuOAuthPopup', 'width=620,height=720');
    });
    window.addEventListener('message', async (ev) => {
      if (ev.data && ev.data.type === 'FEISHU_AUTH_SUCCESS') {
        document.getElementById('modal-feishu-qr').classList.add('hidden');
        toast(`飞书账号绑定成功：${ev.data.userName || '已授权'}`, 'success');
        await loadBootstrap();
      }
    });
    document.getElementById('btn-feishu-unbind').addEventListener('click', async () => {
      if (!window.confirm('确定要解绑当前飞书账号吗？')) return;
      await api('/api/feishu/unbind', 'POST', {});
      toast('飞书账号已解绑', 'info');
      await loadBootstrap();
    });
    document.getElementById('btn-fs-rebuild-pretty').addEventListener('click', async () => {
      const btn = document.getElementById('btn-fs-rebuild-pretty');
      btn.disabled = true;
      btn.textContent = '✨ 正在美化重整飞书总表与分表…';
      try {
        await saveAllSettings();
        const res = await api('/api/feishu/rebuild-pretty', 'POST', {});
        toast(`✨ 飞书总表与分表美化完成！「📊 全部内容总表」已同步 ${res.masterWritten || 0} 条`, 'success');
        await loadBootstrap();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '✨ 一键美化重整飞书总表 & 全部分表';
      }
    });
    document.getElementById('btn-fs-init-sheets').addEventListener('click', async () => {
      try {
        await saveAllSettings();
        const res = await api('/api/feishu/init-sheets', 'POST', {});
        toast(
          res.mode === 'bitable'
            ? '飞书多维表格里的「全部内容总表」+ 今日表 + 5 个平台分表已经自动建好！'
            : '飞书 3 张总表 + 5 个平台子表已经自动建好了！',
          'success'
        );
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    document.getElementById('btn-fs-archive-daily').addEventListener('click', async () => {
      try {
        await api('/api/feishu/archive', 'POST', { periodType: 'daily' });
        toast('今日飞书单日归档测试完成！', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    document.getElementById('cfg-vision-provider').addEventListener('change', (e) => {
      const p = e.target.value;
      if (p === 'local_free') {
        toast('已切回「本地 0 费用智能引擎」，不收任何额外 AI 费用', 'success');
      } else if (p === 'openai_compatible') {
        document.getElementById('cfg-vision-baseurl').value = state.settings.visionLlm?.openaiBaseUrl || 'https://api.openai.com/v1';
        document.getElementById('cfg-vision-model').value = state.settings.visionLlm?.openaiModel || 'gpt-4o-mini';
      } else {
        document.getElementById('cfg-vision-baseurl').value = state.settings.visionLlm?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
        document.getElementById('cfg-vision-model').value = state.settings.visionLlm?.model || 'gemini-3.8-flash';
      }
    });
    document.getElementById('btn-proxy-import').addEventListener('click', async () => {
      const rawText = document.getElementById('proxy-import-textarea').value;
      const defaultRegion = document.getElementById('proxy-default-region').value;
      const res = await api('/api/proxies/import', 'POST', { rawText, defaultRegion });
      document.getElementById('proxy-import-textarea').value = '';
      toast(`导入成功：加了 ${res.added} 条线路`, 'success');
      loadSettingsExtras();
    });
    document.getElementById('btn-proxy-check-all').addEventListener('click', async () => {
      const res = await api('/api/proxies/check', 'POST');
      toast(`检测完：能用 ${res.okCount} 条，坏掉 ${res.failCount} 条`, 'success');
      loadSettingsExtras();
    });
    document.getElementById('btn-proxy-clear-bad').addEventListener('click', async () => {
      await api('/api/proxies/manage', 'POST', { action: 'clearEvicted' });
      toast('已清掉全部连不上的坏线路', 'success');
      loadSettingsExtras();
    });
    document.getElementById('proxy-table-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del-proxy]');
      if (!btn) return;
      await api('/api/proxies/manage', 'POST', { action: 'delete', id: btn.dataset.delProxy });
      loadSettingsExtras();
    });
    document.getElementById('btn-cf-add').addEventListener('click', async () => {
      const label = document.getElementById('cf-new-label').value.trim();
      const options = document.getElementById('cf-new-options').value.trim();
      if (!label) return toast('先写好要新增的列名哦', 'error');
      const res = await api('/api/custom-fields/manage', 'POST', { action: 'add', label, options, syncToFeishu: true });
      state.customFields = res.customFields || [];
      document.getElementById('cf-new-label').value = '';
      document.getElementById('cf-new-options').value = '';
      populateSettingsForm(state.settings);
      toast(`已新增「${label}」列，飞书表格也会跟着多这一列！`, 'success');
    });
    document.getElementById('custom-fields-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del-cf]');
      if (!btn) return;
      const res = await api('/api/custom-fields/manage', 'POST', { action: 'delete', id: btn.dataset.delCf });
      state.customFields = res.customFields || [];
      populateSettingsForm(state.settings);
    });
    document.getElementById('btn-clear-demo-data').addEventListener('click', async () => {
      if (!window.confirm('确定清空演示视频准备正式抓吗？')) return;
      await api('/api/demo/clear-samples', 'POST');
      toast('已清空演示数据，可以开抓啦！', 'success');
      loadBootstrap();
    });
    document.querySelectorAll('.btn-sim-alert').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api('/api/alerts/test', 'POST', { scenario: btn.dataset.sim });
        await loadBootstrap();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    document.getElementById('top-alert-container').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-dismiss-alert]');
      if (!btn) return;
      await api('/api/alerts/dismiss', 'POST', { id: btn.dataset.dismissAlert });
      loadBootstrap();
    });
  }

  /* ---------------- 启动流程 ---------------- */
  bindEvents();
  detectConnectionMode()
    .then(() => loadBootstrap())
    .then(() => loadSamples())
    .then(() => loadCaseHistory())
    .catch((err) => toast(err.message, 'error'));
})();
