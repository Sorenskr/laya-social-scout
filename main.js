'use strict';
/**
 * 海外社媒高流量交友软广采集对标工具 —— HTTP 主服务
 * · 本地启动: node main.js  (默认端口 3080，支持双击 start.bat 一键启动自动打开浏览器)
 * · CloudBase: Dockerfile 容器直跑
 * · Vercel   : api/app.js 直接复用导出的 handler
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { PLATFORMS, PRESET_KEYWORD_PACKS, uid } = require('./lib/defaults');
const store = require('./lib/store');
const proxyPool = require('./lib/proxy_pool');
const crawlerEngine = require('./lib/crawler_engine');
const feishuSync = require('./lib/feishu_sync');
const visionAuditor = require('./lib/vision_auditor');
const scheduler = require('./lib/scheduler');
const seedDemo = require('./lib/seed_demo');
const mediaExtractor = require('./lib/media_extractor');
const caseAnalyzer = require('./lib/case_analyzer');
const githubSync = require('./lib/github_sync');
const fingerprintBrowser = require('./lib/fingerprint_browser');
const remoteControl = require('./lib/remote_control');
const similarCaseFinder = require('./lib/similar_case_finder');

const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = __dirname;
const COVERS_DIR = path.join(ROOT_DIR, 'covers');
const ALLOWED_ROOT_STATIC = new Set(['/index.html', '/style.css', '/app.js', '/public_feed.json', '/favicon.ico', '/favicon.png']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Remote-Pin',
  'Access-Control-Allow-Private-Network': 'true',
};

function sendJson(res, statusCode, payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  }, CORS_HEADERS));
  res.end(buf);
}

function sendHtml(res, statusCode, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  }, CORS_HEADERS));
  res.end(buf);
}

function readJsonBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('请求体超过大小限制'));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 格式解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function getOriginFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function getPeriodBounds() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayOfWeek = now.getDay() || 7;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dayOfWeek - 1)).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { startOfDay, startOfWeek, startOfMonth };
}

function computeDashboardStats(db, proxySummary) {
  const { startOfDay, startOfWeek, startOfMonth } = getPeriodBounds();
  const highLikeLine = Number(db.settings.thresholds?.highLikeGreenThreshold || 10000);

  const countInSince = (arr, timeField, sinceMs) =>
    arr.filter((item) => new Date(item[timeField] || item.publishedAt || 0).getTime() >= sinceMs).length;

  const dayQual = countInSince(db.samples, 'collectedAt', startOfDay);
  const dayTrash = countInSince(db.trash, 'trashedAt', startOfDay);
  const weekQual = countInSince(db.samples, 'collectedAt', startOfWeek);
  const weekTrash = countInSince(db.trash, 'trashedAt', startOfWeek);
  const monthQual = countInSince(db.samples, 'collectedAt', startOfMonth);
  const monthTrash = countInSince(db.trash, 'trashedAt', startOfMonth);

  const platformBreakdown = PLATFORMS.map((p) => {
    const list = db.samples.filter((s) => s.platform === p.id);
    const viralCount = list.filter((s) => Number(s.likes || 0) >= highLikeLine).length;
    return {
      id: p.id,
      name: p.name,
      shortName: p.shortName,
      color: p.color,
      count: list.length,
      ratioPct: db.samples.length ? Math.round((list.length / db.samples.length) * 100) : 0,
      viralCount,
    };
  });

  // 最近10条采集失败/限流告警合并视图
  const recentFailures = [
    ...db.rateLimitLogs.slice(0, 10).map((r) => ({
      id: r.id,
      time: r.time,
      platform: r.platform,
      type: r.resolved ? '限流自愈成功' : '限流换IP重试',
      detail: `词「${r.keyword}」${r.fallbackKeyword ? `→「${r.fallbackKeyword}」` : ''} · ${r.proxyLabel} · ${r.reason}`,
      level: r.resolved ? 'info' : 'warning',
    })),
    ...db.operationLogs
      .filter((l) => l.status === 'error' || l.status === 'warning')
      .slice(0, 10)
      .map((l) => ({
        id: l.id,
        time: l.time,
        platform: l.module,
        type: l.action,
        detail: l.errorReason || l.detail,
        level: l.status,
      })),
  ]
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 10);

  return {
    periods: {
      day: { total: dayQual + dayTrash, qualified: dayQual, filtered: dayTrash },
      week: { total: weekQual + weekTrash, qualified: weekQual, filtered: weekTrash },
      month: { total: monthQual + monthTrash, qualified: monthQual, filtered: monthTrash },
      allTime: {
        total: db.samples.length + db.trash.length,
        qualified: db.samples.length,
        filtered: db.trash.length,
      },
    },
    platformBreakdown,
    totalViralCount: db.samples.filter((s) => Number(s.likes || 0) >= highLikeLine).length,
    feishuStatus: {
      authorized: Boolean(db.settings.feishu?.authorized),
      hasWebhook: Boolean(db.settings.feishu?.realtimeWebhookUrl),
      hasAppConfig: Boolean((db.settings.feishu?.appId || process.env.FEISHU_APP_ID) && (db.settings.feishu?.appSecret || process.env.FEISHU_APP_SECRET)),
      userName: db.settings.feishu?.userName || '',
      targetMode: db.settings.feishu?.targetMode || 'spreadsheet',
      splitBy: db.settings.feishu?.splitBy || 'platform',
      pendingQueueCount: db.feishuQueue.length,
      lastSyncAt: db.settings.feishu?.lastSyncAt || '',
      lastSyncStatus:
        db.settings.feishu?.lastSyncStatus && db.settings.feishu?.lastSyncStatus !== '未绑定'
          ? db.settings.feishu.lastSyncStatus
          : db.settings.feishu?.realtimeWebhookUrl
            ? '✅ 极速 Webhook 实时同步已开启'
            : db.settings.feishu?.appId && db.settings.feishu?.appSecret && db.settings.feishu?.bitableAppToken
              ? '✅ 多维表格应用密钥已配好'
              : '待绑定飞书账号',
      workbooks: db.settings.feishu?.workbooks || {},
    },
    proxySummary,
    recentFailures,
  };
}

function sanitizeSettingsForClient(settings, isLocal = false) {
  const clone = JSON.parse(JSON.stringify(settings || {}));
  if (clone.visionLlm) {
    clone.visionLlm.hasApiKey = Boolean(clone.visionLlm.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
    if (clone.visionLlm.apiKey && clone.visionLlm.apiKey.length > 8) {
      clone.visionLlm.maskedKey =
        clone.visionLlm.apiKey.slice(0, 4) + '••••••••' + clone.visionLlm.apiKey.slice(-4);
    }
    delete clone.visionLlm.apiKey;
  }
  if (clone.feishu) {
    delete clone.feishu.accessToken;
    delete clone.feishu.refreshToken;
    clone.feishu.hasSecret = Boolean(clone.feishu.appSecret || process.env.FEISHU_APP_SECRET);
    delete clone.feishu.appSecret;
  }
  const tunnelState = remoteControl.getTunnelState();
  clone.remoteControl = Object.assign({ enabled: true, autoStartGuardian: true }, clone.remoteControl || {}, {
    hasPin: Boolean((clone.remoteControl && clone.remoteControl.pin) || '8888'),
    autoStartEnabled: remoteControl.getWindowsAutoStartStatus(),
    tunnelUrl: tunnelState.tunnelUrl || '',
    tunnelUpdatedAt: tunnelState.updatedAt || '',
  });
  if (!isLocal) {
    delete clone.remoteControl.pin;
  }
  return clone;
}

function filterAndSortSamples(samples, query) {
  let list = [...samples];

  // 1. 平台多选开关筛选
  if (query.platforms) {
    const allowed = String(query.platforms)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0 && allowed.length < PLATFORMS.length) {
      list = list.filter((s) => allowed.includes(s.platform));
    } else if (allowed.length === 0) {
      return [];
    }
  }

  // 2. 业务分类筛选（我方品牌 / 竞品 / 泛交友可植入）
  if (query.category && query.category !== 'all') {
    list = list.filter((s) => s.categoryGroup === query.category);
  }

  // 3. 时间筛选：支持单日（任意历史日期）、近7天、近30天、自定义起止日期
  const timePreset = query.timePreset || 'all';
  if (timePreset === 'day' && query.specificDate) {
    const start = new Date(`${query.specificDate}T00:00:00`).getTime();
    const end = start + 24 * 3600 * 1000;
    list = list.filter((s) => {
      const t = new Date(s.publishedAt || s.collectedAt).getTime();
      return t >= start && t < end;
    });
  } else if (timePreset === '7d') {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    list = list.filter((s) => new Date(s.publishedAt || s.collectedAt).getTime() >= since);
  } else if (timePreset === '30d') {
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    list = list.filter((s) => new Date(s.publishedAt || s.collectedAt).getTime() >= since);
  } else if (timePreset === 'custom') {
    if (query.startDate) {
      const sMs = new Date(`${query.startDate}T00:00:00`).getTime();
      list = list.filter((s) => new Date(s.publishedAt || s.collectedAt).getTime() >= sMs);
    }
    if (query.endDate) {
      const eMs = new Date(`${query.endDate}T23:59:59.999`).getTime();
      list = list.filter((s) => new Date(s.publishedAt || s.collectedAt).getTime() <= eMs);
    }
  }

  // 4. 内容质量二次筛选
  if (query.minLikes && Number(query.minLikes) > 0) {
    list = list.filter((s) => Number(s.likes || 0) >= Number(query.minLikes));
  }
  if (query.minPlays && Number(query.minPlays) > 0) {
    list = list.filter((s) => Number(s.plays || 0) >= Number(query.minPlays));
  }
  if (query.maxDifficulty && Number(query.maxDifficulty) > 0) {
    list = list.filter((s) => Number(s.implantDifficulty || 1) <= Number(query.maxDifficulty));
  }
  if (query.contentType && query.contentType !== 'all') {
    if (query.contentType.startsWith('media:')) {
      const targetMedia = query.contentType.slice('media:'.length);
      list = list.filter((s) => (s.mediaType || 'video') === targetMedia);
    } else {
      list = list.filter((s) => s.contentType === query.contentType);
    }
  }
  if (query.usedState === 'unused') {
    list = list.filter((s) => !s.markedUsed);
  } else if (query.usedState === 'used') {
    list = list.filter((s) => Boolean(s.markedUsed));
  } else if (query.usedState === 'favorited') {
    list = list.filter((s) => Boolean(s.favorited));
  }
  if (query.viralOnly === 'true') {
    list = list.filter((s) => Number(s.likes || 0) >= 8000 || Number(s.qualityScore || 0) >= 85);
  }
  if (query.q && query.q.trim()) {
    const kw = query.q.trim().toLowerCase();
    list = list.filter((s) =>
      `${s.title} ${s.fullText} ${(s.exposedBrands || []).join(' ')} ${s.bgm} ${s.authorHandle}`
        .toLowerCase()
        .includes(kw)
    );
  }

  // 5. 排序规则（默认：按点赞+浏览+评论综合流量从高到低）
  const sortBy = query.sortBy || 'traffic_desc';
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
    if (sortBy === 'likes_desc') return (b.likes || 0) - (a.likes || 0) || (b.plays || 0) - (a.plays || 0);
    if (sortBy === 'plays_desc') return (b.plays || 0) - (a.plays || 0) || (b.likes || 0) - (a.likes || 0);
    if (sortBy === 'comments_desc') return (b.comments || 0) - (a.comments || 0) || (b.likes || 0) - (a.likes || 0);
    if (sortBy === 'time_desc') return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
    if (sortBy === 'difficulty_asc') return (a.implantDifficulty || 3) - (b.implantDifficulty || 3) || (b.qualityScore || 0) - (a.qualityScore || 0);
    // score_time
    const scoreDiff = (b.qualityScore || 0) - (a.qualityScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  });

  return list;
}

async function handleApi(req, res, pathname, searchParams) {
  const db = store.getDb();

  // 健康检查（开放探测，返回主机名、隧道状态及远程口令校验状态，绝不返回真实口令）
  if (pathname === '/api/health') {
    const pinStatus = remoteControl.checkPinOnly(req, db, searchParams.get('pin') || '');
    const tunnelState = remoteControl.getTunnelState();
    const remotePinRequired = !pinStatus.isLocal && remoteControl.isRemotePinEnabled(db);
    return sendJson(res, 200, {
      ok: true,
      service: 'laya-social-scout',
      hostComputer: os.hostname(),
      time: new Date().toISOString(),
      isLocal: pinStatus.isLocal,
      remotePinRequired,
      pinVerified: pinStatus.ok,
      tunnelUrl: tunnelState.tunnelUrl || '',
    });
  }

  // 跨电脑远程控制口令校验接口
  if (pathname === '/api/remote/verify-pin' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const auth = remoteControl.verifyRemotePin(req, db, body.pin || '');
    if (!auth.ok) {
      return sendJson(res, auth.status || 401, { error: auth.error, needPin: true });
    }
    return sendJson(res, 200, {
      ok: true,
      hostComputer: os.hostname(),
      isLocal: auth.isLocal,
    });
  }

  // 全局远程访问守卫：除健康检查、口令验证与飞书 OAuth 回调外，非本机回环请求一律须持有 X-Remote-Pin
  if (pathname !== '/api/feishu/oauth/callback') {
    const explicitPin = pathname === '/api/crawl/stream' ? (searchParams.get('pin') || '') : '';
    const auth = remoteControl.verifyRemotePin(req, db, explicitPin);
    if (!auth.ok) {
      return sendJson(res, auth.status || 401, { error: auth.error, needPin: true });
    }
  }

  // 查询主电脑远程通道、开机守护与比特浏览器状态
  if (pathname === '/api/remote/status' && req.method === 'GET') {
    const tunnelState = remoteControl.getTunnelState();
    const fpCfg = db.settings.fingerprintBrowser || {};
    const browserStatus = await fingerprintBrowser.detectFingerprintBrowsers(fpCfg);
    return sendJson(res, 200, {
      ok: true,
      hostComputer: os.hostname(),
      tunnelUrl: tunnelState.tunnelUrl || '',
      tunnelUpdatedAt: tunnelState.updatedAt || '',
      autoStartEnabled: remoteControl.getWindowsAutoStartStatus(),
      bitbrowserOnline: browserStatus.bitbrowserOnline,
    });
  }

  // 远程一键启动/唤醒主电脑工作台（拉起比特浏览器、预热窗口，或平滑重启主服务）
  if (pathname === '/api/remote/wake-workbench' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const resWake = await remoteControl.wakeHostWorkbench(db, body || {});
    store.addOpLog({
      module: '远程唤醒',
      action: '远程启动/唤醒主电脑工作台与比特浏览器',
      status: resWake.bitbrowserOnline ? 'success' : 'warning',
      detail: resWake.message || '',
    });
    store.save(true);
    return sendJson(res, 200, resWake);
  }

  // 全局引导与仪表盘首屏聚合接口
  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    const isLocal = remoteControl.isLocalLoopbackReq(req);
    const proxySummary = await proxyPool.evaluateProxyPoolHealth(false);
    const dashboard = computeDashboardStats(db, proxySummary);
    const activeAlerts = (db.alerts || []).filter((a) => !a.dismissed).slice(0, 5);
    return sendJson(res, 200, {
      platforms: PLATFORMS,
      dashboard,
      activeAlerts,
      customFields: db.customFields || [],
      keywordsCount: {
        brand: (db.keywords.brand || []).length,
        competitor: (db.keywords.competitor || []).length,
        generic: (db.keywords.generic || []).length,
      },
      settings: (() => {
        feishuSync.upgradeSyncFieldsToPretty(db);
        return sanitizeSettingsForClient(db.settings, isLocal);
      })(),
      crawlJob: crawlerEngine.getActiveJobStatus(),
      originUrl: getOriginFromReq(req),
    });
  }

  // 结果列表筛选查询
  if (pathname === '/api/samples' && req.method === 'GET') {
    const queryObj = Object.fromEntries(searchParams.entries());
    const filtered = filterAndSortSamples(db.samples, queryObj);
    return sendJson(res, 200, {
      total: filtered.length,
      allCount: db.samples.length,
      items: filtered,
    });
  }

  // 单条样本运营操作（收藏 / 标记已使用 / 一键标记垃圾自动拉黑 / 更新自定义字段）
  if (pathname.startsWith('/api/samples/') && pathname.endsWith('/action') && req.method === 'POST') {
    const sampleId = pathname.split('/')[3];
    const body = await readJsonBody(req);
    const action = body.action;

    if (action === 'markSpam') {
      const trashed = crawlerEngine.markSampleAsSpam(
        sampleId,
        body.reason || '运营一键标记垃圾废片',
        body.blockAccount !== false,
        body.blockKeyword || '',
        body.operator
      );
      if (!trashed) return sendJson(res, 404, { error: '样本不存在' });
      return sendJson(res, 200, { ok: true, trashed });
    }

    const sample = db.samples.find((s) => s.id === sampleId);
    if (!sample) return sendJson(res, 404, { error: '样本不存在' });

    if (action === 'toggleFavorite') {
      sample.favorited = !sample.favorited;
      store.addOpLog({
        module: '样本操作',
        action: sample.favorited ? '收藏高潜软广样本' : '取消收藏样本',
        detail: sample.title.slice(0, 30),
      });
    } else if (action === 'toggleUsed') {
      sample.markedUsed = !sample.markedUsed;
      store.addOpLog({
        module: '样本操作',
        action: sample.markedUsed ? '标记样本「已使用」' : '恢复样本为「未使用」',
        detail: sample.title.slice(0, 30),
      });
    } else if (action === 'updateCustomFields' && body.customValues) {
      sample.customValues = Object.assign({}, sample.customValues || {}, body.customValues);
      store.addOpLog({
        module: '自定义字段',
        action: '更新样本扩展字段值',
        detail: `${sample.title.slice(0, 24)} -> ${JSON.stringify(body.customValues)}`,
      });
    }

    store.save();
    return sendJson(res, 200, { ok: true, sample });
  }

  // 上传参考图片 / 文案识别同款特征并生成纯简繁中文搜索词
  if (pathname === '/api/crawl/analyze-reference' && req.method === 'POST') {
    const body = await readJsonBody(req, 15 * 1024 * 1024);
    const profile = await similarCaseFinder.analyzeReferenceForSimilarCrawl({
      imagesBase64: body.imagesBase64 || [],
      referenceText: body.referenceText || '',
      url: body.url || '',
      db,
    });
    store.addOpLog({
      module: '找同款引擎',
      action: '识别上传截图/文案生成同款中文搜词',
      status: 'success',
      detail: `${profile.visualArchetypeLabel} -> [${(profile.suggestedKeywords || []).join(', ')}]`,
    });
    store.save();
    return sendJson(res, 200, { ok: true, profile });
  }

  // 手动触发采集任务（支持选定日期范围 + 指定关键词 + 传图找同款抓取）
  if (pathname === '/api/crawl/run' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const customKeywords = Array.isArray(body.customKeywords)
      ? body.customKeywords.map((s) => String(s || '').trim()).filter(Boolean)
      : String(body.customKeywords || '').split(/[,，\r\n;；]+/).map((s) => s.trim()).filter(Boolean);

    if (body.saveCustomKeywords && customKeywords.length > 0) {
      const genericList = db.keywords.generic || (db.keywords.generic = []);
      for (const word of customKeywords) {
        const existed = genericList.find((k) => String(k.word || '').toLowerCase() === word.toLowerCase());
        if (existed) {
          existed.enabled = true;
        } else {
          genericList.unshift({
            id: uid('kw'),
            word,
            group: '手动指定热词',
            synonyms: [],
            enabled: true,
            createdAt: new Date().toISOString(),
          });
        }
      }
      store.save(true);
    }

    if (body.clearExisting) {
      store.createBackupSnapshot('before_custom_crawl');
      db.samples = [];
      store.save(true);
    }

    const crawlOpts = {
      platforms: Array.isArray(body.platforms) && body.platforms.length ? body.platforms : ['instagram', 'facebook', 'x', 'threads', 'tiktok'],
      buckets: Array.isArray(body.buckets) && body.buckets.length ? body.buckets : ['brand', 'competitor', 'generic'],
      customKeywords,
      referenceProfile: body.referenceProfile || null,
      maxTotalCandidates: Number(body.maxTotalCandidates || 80),
      dateFrom: body.dateFrom || '',
      dateTo: body.dateTo || '',
      modeOverride: body.modeOverride || '',
      ignoreDailyQuota: true,
      fastTest: body.fastTest !== false,
      awaitFeishuSync: Boolean(body.awaitFeishuSync),
      operator: body.operator || db.settings.operatorName || '运营手动触发',
    };

    const currentJob = crawlerEngine.getActiveJobStatus();
    if (currentJob && currentJob.running) {
      return sendJson(res, 200, { ok: true, alreadyRunning: true, job: currentJob });
    }

    // 远程跨网请求或前端显式开启异步模式：立即返回 202 并靠 SSE 实时同步双方页面进度，彻底规避 Cloudflare 100 秒代理超时
    if (body.async || !remoteControl.isLocalLoopbackReq(req)) {
      crawlerEngine.runCrawlTask(crawlOpts).catch((err) => {
        console.error('[crawl/async] 异步采集失败:', err && err.message ? err.message : err);
      });
      await new Promise((r) => setTimeout(r, 40));
      return sendJson(res, 202, { ok: true, started: true, job: crawlerEngine.getActiveJobStatus() });
    }

    const result = await crawlerEngine.runCrawlTask(crawlOpts);
    return sendJson(res, 200, { ok: true, result });
  }

  if (pathname === '/api/crawl/status' && req.method === 'GET') {
    return sendJson(res, 200, crawlerEngine.getActiveJobStatus());
  }

  // 网页实时进度 SSE 直播流（毫秒级推状态、抓到的新封面和飞书同步条数）
  if (pathname === '/api/crawl/stream' && req.method === 'GET') {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    }, CORS_HEADERS));
    let lastSig = '';
    let tickCount = 0;
    const pushSnapshot = () => {
      const payload = JSON.stringify(crawlerEngine.getActiveJobStatus());
      if (payload !== lastSig) {
        lastSig = payload;
        res.write(`data: ${payload}\n\n`);
      } else if (++tickCount % 16 === 0) {
        res.write(': ping\n\n');
      }
    };
    pushSnapshot();
    const timer = setInterval(pushSnapshot, 600);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // 防封指纹浏览器 & 免费专属防封窗口控制接口
  if (pathname === '/api/browser/status' && req.method === 'GET') {
    const fpCfg = db.settings.fingerprintBrowser || {};
    const status = await fingerprintBrowser.detectFingerprintBrowsers(fpCfg);
    return sendJson(res, 200, {
      ok: true,
      ...status,
      selectedProfileId: fpCfg.selectedProfileId || '',
      selectedProfileName: fpCfg.selectedProfileName || '',
      todaySearchCount: Number(fpCfg.todaySearchCount || 0),
      maxDailySearchesPerAccount: Number(fpCfg.maxDailySearchesPerAccount || 30),
    });
  }

  if (pathname === '/api/browser/launch-free' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const fpCfg = db.settings.fingerprintBrowser || (db.settings.fingerprintBrowser = {});
    const resLaunch = await fingerprintBrowser.launchFreeDedicatedBrowser(fpCfg, body.startUrl || 'https://www.instagram.com/');
    fpCfg.selectedProfileId = `dedicated_${resLaunch.port}`;
    fpCfg.selectedProfileName = `免费独立防封窗口 (${resLaunch.port})`;
    store.save();
    return sendJson(res, 200, resLaunch);
  }

  if (pathname === '/api/browser/open-profile' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const fpCfg = db.settings.fingerprintBrowser || (db.settings.fingerprintBrowser = {});
    const opened = await fingerprintBrowser.openFingerprintProfile(fpCfg, body.profileId, body.source);
    fpCfg.selectedProfileId = body.profileId;
    fpCfg.selectedProfileName = body.profileName || opened.profileName;
    store.save();
    return sendJson(res, 200, { ok: true, ...opened });
  }

  // 一键导入现成热词包或从 GitHub 链接抓词单
  if (pathname === '/api/keywords/import-pack' && req.method === 'POST') {
    const body = await readJsonBody(req);
    let bucket = body.bucket || 'generic';
    let lines = [];
    let packName = '自定义词单';

    if (body.packId && PRESET_KEYWORD_PACKS[body.packId]) {
      const pack = PRESET_KEYWORD_PACKS[body.packId];
      bucket = pack.bucket;
      lines = pack.words;
      packName = pack.name;
    } else if (body.remoteUrl && /^https?:\/\//i.test(body.remoteUrl)) {
      const resp = await proxyPool.requestRaw(body.remoteUrl.trim(), { timeoutMs: 12000 }, null);
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        return sendJson(res, 400, { error: `从链接拉取词单失败（状态码 ${resp.statusCode}）` });
      }
      lines = resp.text().split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      packName = 'GitHub/网址词单';
    } else {
      return sendJson(res, 400, { error: '请选择一个预设热词包或填写有效的词单链接' });
    }

    const list = db.keywords[bucket] || (db.keywords[bucket] = []);
    let added = 0;
    for (const entry of lines) {
      const parts = String(entry).split('|').map((s) => s.trim());
      const word = parts[0];
      if (!word) continue;
      const group = parts[1] || packName;
      const synonyms = parts[2] ? parts[2].split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [];
      if (!list.some((k) => k.word.toLowerCase() === word.toLowerCase())) {
        list.push({
          id: uid('kw'),
          word,
          group,
          synonyms,
          enabled: true,
          createdAt: new Date().toISOString(),
        });
        added++;
      }
    }
    store.addOpLog({
      module: '词库管理',
      action: `一键导入「${packName}」`,
      status: 'success',
      detail: `新增 ${added} 个热词（当前该栏共 ${list.length} 个词）`,
    });
    store.save(true);
    return sendJson(res, 200, { ok: true, added, packName, keywords: db.keywords });
  }

  // 丢链接 / 传截图拆解案例接口
  if (pathname === '/api/analyze/case' && req.method === 'POST') {
    const body = await readJsonBody(req, 15 * 1024 * 1024);
    const analyzed = await caseAnalyzer.analyzeCase({
      url: body.url || '',
      imagesBase64: body.imagesBase64 || [],
      userNote: body.userNote || '',
      operator: body.operator || db.settings.operatorName || '运营同事',
    });
    return sendJson(res, 200, { ok: true, caseItem: analyzed });
  }

  if (pathname === '/api/analyze/list' && req.method === 'GET') {
    return sendJson(res, 200, { items: db.caseAnalyses || [] });
  }

  if (pathname === '/api/analyze/save-to-samples' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const saved = caseAnalyzer.saveCaseToSamples(body.id, body.operator);
    return sendJson(res, 200, { ok: true, sample: saved });
  }

  // GitHub 跨电脑同步接口
  if (pathname === '/api/github/status' && req.method === 'GET') {
    const status = await githubSync.getGithubRepoStatus(db);
    return sendJson(res, 200, status);
  }

  if (pathname === '/api/github/push' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const rawRepo = String(body.repoUrl || '').trim();
    const effectiveRepo = githubSync.normalizeGithubRepoUrl(
      rawRepo || (db.settings.githubSync && db.settings.githubSync.repoUrl) || ''
    );
    const pushRes = await githubSync.pushToGithub({
      repoUrl: effectiveRepo,
      branch: body.branch || db.settings.githubSync?.branch || 'main',
      db,
      activeJob: crawlerEngine.getActiveJobStatus(),
    });
    store.addOpLog({
      module: 'GitHub同步',
      action: '一键同步网页与最新视频封面到 GitHub',
      status: 'success',
      detail: pushRes.pagesUrl ? `同步成功！任何电脑可打开：${pushRes.pagesUrl}` : '已推送到 GitHub 仓库',
    });
    store.save(true);
    return sendJson(res, 200, pushRes);
  }

  // 开源抓封面内核状态与一键从 GitHub 安装
  if (pathname === '/api/tools/status' && req.method === 'GET') {
    const ytdlp = await mediaExtractor.getYtDlpStatus();
    const gh = await githubSync.getGithubRepoStatus(db);
    return sendJson(res, 200, { ytdlp, github: gh, presetPacks: Object.entries(PRESET_KEYWORD_PACKS).map(([id, p]) => ({ id, name: p.name, count: p.words.length })) });
  }

  if (pathname === '/api/tools/install-ytdlp' && req.method === 'POST') {
    const resInst = await mediaExtractor.installYtDlpFromGithub();
    store.addOpLog({ module: '抓封面插件', action: '从 GitHub 自动安装高清抓封面内核 (yt-dlp)', status: 'success', detail: resInst.path });
    return sendJson(res, 200, resInst);
  }

  // 关键词三库管理（查询 / 增删改 / 批量粘贴导入 / 导出）
  if (pathname === '/api/keywords' && req.method === 'GET') {
    return sendJson(res, 200, { keywords: db.keywords });
  }

  if (pathname === '/api/keywords/manage' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const bucket = body.bucket; // 'brand' | 'competitor' | 'generic'
    if (!['brand', 'competitor', 'generic'].includes(bucket)) {
      return sendJson(res, 400, { error: '无效的词库分类' });
    }
    const list = db.keywords[bucket] || (db.keywords[bucket] = []);

    if (body.action === 'add') {
      const word = String(body.word || '').trim();
      if (!word) return sendJson(res, 400, { error: '关键词不能为空' });
      const synonyms = String(body.synonyms || '')
        .split(/[,，、|]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const existing = list.find((k) => k.word.toLowerCase() === word.toLowerCase());
      if (existing) {
        existing.group = body.group || existing.group;
        if (synonyms.length) existing.synonyms = synonyms;
        existing.enabled = true;
      } else {
        list.unshift({
          id: uid('kw'),
          word,
          group: body.group || (bucket === 'brand' ? '品牌主词' : bucket === 'competitor' ? '竞品App' : '泛交友词'),
          synonyms,
          enabled: true,
          createdAt: new Date().toISOString(),
        });
      }
      store.addOpLog({ module: '词库管理', action: `新增关键词 [${bucket}]`, detail: `${word}（分组：${body.group || '默认'}）` });
    } else if (body.action === 'batchImport') {
      // 支持一行一个，也支持 "关键词 | 分组 | 近义词1,近义词2" 或逗号分隔全量粘贴
      const rawLines = String(body.rawText || '')
        .split(/\r?\n/)
        .flatMap((line) => (line.includes('|') ? [line] : line.split(/[,，;；\t]/)))
        .map((s) => s.trim())
        .filter(Boolean);

      let added = 0;
      for (const entry of rawLines) {
        const parts = entry.split('|').map((s) => s.trim());
        const word = parts[0];
        if (!word) continue;
        const group = parts[1] || body.defaultGroup || (bucket === 'competitor' ? '语音交友竞品' : '默认分组');
        const synonyms = parts[2]
          ? parts[2].split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
          : [];

        if (!list.some((k) => k.word.toLowerCase() === word.toLowerCase())) {
          list.push({
            id: uid('kw'),
            word,
            group,
            synonyms,
            enabled: true,
            createdAt: new Date().toISOString(),
          });
          added++;
        }
      }
      store.addOpLog({
        module: '词库管理',
        action: `批量导入关键词 [${bucket}]`,
        detail: `成功导入 ${added} 个新词（当前该库共 ${list.length} 个词）`,
      });
      store.save();
      return sendJson(res, 200, { ok: true, added, keywords: db.keywords });
    } else if (body.action === 'toggle') {
      const target = list.find((k) => k.id === body.id);
      if (target) target.enabled = !target.enabled;
    } else if (body.action === 'delete') {
      db.keywords[bucket] = list.filter((k) => k.id !== body.id);
      store.addOpLog({ module: '词库管理', action: `删除关键词 [${bucket}]`, detail: body.id });
    } else if (body.action === 'clearBucket') {
      db.keywords[bucket] = [];
      store.addOpLog({ module: '词库管理', action: `清空词库 [${bucket}]`, status: 'warning' });
    }

    store.save();
    return sendJson(res, 200, { ok: true, keywords: db.keywords });
  }

  // 代理 IP 池接口
  if (pathname === '/api/proxies' && req.method === 'GET') {
    const summary = await proxyPool.evaluateProxyPoolHealth(false);
    return sendJson(res, 200, { proxies: db.proxies, summary });
  }

  if (pathname === '/api/proxies/import' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const resStats = proxyPool.importProxiesBatch(body.rawText || '', body.defaultRegion || '美区', body.operator);
    const summary = await proxyPool.evaluateProxyPoolHealth(false);
    return sendJson(res, 200, { ok: true, ...resStats, proxies: db.proxies, summary });
  }

  if (pathname === '/api/proxies/check' && req.method === 'POST') {
    const checkRes = await proxyPool.checkAllProxies();
    return sendJson(res, 200, { ok: true, ...checkRes, proxies: db.proxies });
  }

  if (pathname === '/api/proxies/manage' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.action === 'delete') {
      db.proxies = db.proxies.filter((p) => p.id !== body.id);
    } else if (body.action === 'clearEvicted') {
      db.proxies = db.proxies.filter((p) => p.status !== 'evicted' && p.status !== 'failed');
    } else if (body.action === 'clearAll') {
      db.proxies = [];
    }
    store.save();
    const summary = await proxyPool.evaluateProxyPoolHealth(false);
    return sendJson(res, 200, { ok: true, proxies: db.proxies, summary });
  }

  // 飞书扫码授权与实时同步接口
  if (pathname === '/api/feishu/oauth/url' && req.method === 'GET') {
    try {
      const data = feishuSync.buildOAuthAuthorizeUrl(getOriginFromReq(req));
      return sendJson(res, 200, { ok: true, ...data });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/feishu/oauth/callback' && req.method === 'GET') {
    const code = searchParams.get('code') || '';
    const state = searchParams.get('state') || '';
    if (!code) {
      return sendHtml(res, 400, '<h3>未获取到飞书授权 code，请关闭窗口重新扫码。</h3>');
    }
    try {
      const bound = await feishuSync.handleOAuthCallback(code, state, getOriginFromReq(req));
      return sendHtml(
        res,
        200,
        `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>飞书扫码绑定成功</title></head>
        <body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center;background:#1e293b;padding:32px 44px;border-radius:16px;border:1px solid #334155;">
            <div style="font-size:44px;margin-bottom:12px;">✅</div>
            <h2 style="margin:0 0 8px;">飞书账号绑定成功！</h2>
            <p style="color:#94a3b8;margin:0 0 18px;">已授权账号：${bound.userName} · 窗口将自动关闭</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'FEISHU_AUTH_SUCCESS', userName: ${JSON.stringify(bound.userName)} }, '*');
              }
              setTimeout(() => window.close(), 1200);
            </script>
          </div>
        </body></html>`
      );
    } catch (err) {
      return sendHtml(
        res,
        500,
        `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权失败</title></head>
        <body style="font-family:sans-serif;padding:40px;"><h3>❌ 飞书授权失败：${err.message}</h3><p>请检查飞书后台重定向 URL 与 App Secret 是否填写正确。</p></body></html>`
      );
    }
  }

  if (pathname === '/api/feishu/sync-now' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const targetIds = Array.isArray(body.sampleIds) && body.sampleIds.length
      ? body.sampleIds
      : db.samples.filter((s) => !s.feishuSynced).map((s) => s.id);

    // 若全部已同步但用户点了「一键同步当前内容到飞书」，支持对传入列表加入同步队列写入
    const idsToEnqueue = targetIds.length ? targetIds : db.samples.slice(0, 10).map((s) => s.id);
    idsToEnqueue.forEach((id) => feishuSync.enqueueSampleForFeishu(id));

    const result = await feishuSync.processFeishuQueue({ forceAll: true, operator: '运营点击一键同步飞书' });
    return sendJson(res, 200, { ok: true, enqueued: idsToEnqueue.length, ...result, feishu: sanitizeSettingsForClient(db.settings).feishu });
  }

  if (pathname === '/api/feishu/init-sheets' && req.method === 'POST') {
    const token = await feishuSync.ensureValidAccessToken();
    if (db.settings.feishu && db.settings.feishu.targetMode === 'bitable') {
      const tables = await feishuSync.ensureBitableReady(token);
      store.addOpLog({
        module: '飞书同步',
        action: '初始化飞书多维表格总表与5平台分表',
        status: 'success',
        detail: '多维表格全部内容总表、今日表与5平台图标分表初始化完成',
      });
      return sendJson(res, 200, { ok: true, mode: 'bitable', tables });
    }
    const workbooks = await feishuSync.ensureSpreadsheetsReady(token);
    store.addOpLog({
      module: '飞书同步',
      action: '初始化 3总表×5子表分表结构',
      status: 'success',
      detail: '单日/周度/月度总表及5平台子表校验与表头初始化完成',
    });
    return sendJson(res, 200, { ok: true, mode: 'spreadsheet', workbooks });
  }

  if (pathname === '/api/feishu/rebuild-pretty' && req.method === 'POST') {
    const result = await feishuSync.rebuildPrettyBitableAll();
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (pathname === '/api/feishu/archive' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const resArch = await feishuSync.archivePeriodSnapshot(body.periodType || 'daily', body.label || '', '运营手动归档验证');
    return sendJson(res, 200, { ok: true, ...resArch });
  }

  if (pathname === '/api/feishu/unbind' && req.method === 'POST') {
    db.settings.feishu.authorized = false;
    db.settings.feishu.accessToken = '';
    db.settings.feishu.refreshToken = '';
    db.settings.feishu.userName = '';
    db.settings.feishu.lastSyncStatus = '已解绑';
    store.addOpLog({ module: '飞书同步', action: '解除飞书账号授权绑定', status: 'warning' });
    store.save();
    return sendJson(res, 200, { ok: true });
  }

  // 测试视觉大模型连通性
  if (pathname === '/api/vision/test' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const testRes = await visionAuditor.testVisionConnection(body);
    return sendJson(res, 200, testRes);
  }

  // 保存系统配置（保留未重新输入的密钥原值）
  if (pathname === '/api/settings/save' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const s = db.settings;

    if (body.brandName !== undefined) s.brandName = String(body.brandName).trim() || 'Laya';
    if (body.brandPositioning !== undefined) s.brandPositioning = String(body.brandPositioning).trim();
    if (body.operatorName !== undefined) s.operatorName = String(body.operatorName).trim();
    if (body.collectorMode) s.collectorMode = body.collectorMode;

    if (body.thirdPartyApi) {
      Object.assign(s.thirdPartyApi, body.thirdPartyApi);
    }
    if (body.visionLlm) {
      const nextVision = { ...body.visionLlm };
      if (!nextVision.apiKey || nextVision.apiKey.includes('••••')) {
        delete nextVision.apiKey;
      }
      Object.assign(s.visionLlm, nextVision);
    }
    if (body.antiCrawl) {
      if (body.antiCrawl.intervalsSec) {
        Object.assign(s.antiCrawl.intervalsSec, body.antiCrawl.intervalsSec);
      }
      const restAnti = { ...body.antiCrawl };
      delete restAnti.intervalsSec;
      Object.assign(s.antiCrawl, restAnti);
    }
    if (body.thresholds) {
      Object.assign(s.thresholds, body.thresholds);
    }
    if (body.schedule) {
      Object.assign(s.schedule, body.schedule);
    }
    if (body.fingerprintBrowser) {
      s.fingerprintBrowser = Object.assign({}, s.fingerprintBrowser || {}, body.fingerprintBrowser);
    }
    if (body.feishu) {
      const nextFs = { ...body.feishu };
      if (!nextFs.appSecret || nextFs.appSecret.includes('••••')) {
        delete nextFs.appSecret;
      }
      if (nextFs.targetDocUrl !== undefined) {
        const parsedDoc = feishuSync.parseFeishuTargetUrl(nextFs.targetDocUrl);
        if (parsedDoc && parsedDoc.mode === 'spreadsheet') {
          s.feishu.workbooks = s.feishu.workbooks || {};
          s.feishu.workbooks.daily = Object.assign({}, s.feishu.workbooks.daily || {}, {
            token: parsedDoc.token,
            url: String(nextFs.targetDocUrl).trim(),
          });
          nextFs.targetMode = 'spreadsheet';
        } else if (parsedDoc && parsedDoc.mode === 'bitable') {
          nextFs.bitableAppToken = parsedDoc.token;
          nextFs.targetMode = 'bitable';
        }
      }
      Object.assign(s.feishu, nextFs);
    }
    if (body.githubSync) {
      const nextGh = { ...body.githubSync };
      if (nextGh.repoUrl !== undefined) {
        nextGh.repoUrl = githubSync.normalizeGithubRepoUrl(nextGh.repoUrl);
        nextGh.pagesUrl = githubSync.computeGithubPagesUrl(nextGh.repoUrl);
      }
      s.githubSync = Object.assign({}, s.githubSync || {}, nextGh);
    }
    if (body.remoteControl) {
      const nextRc = Object.assign({}, s.remoteControl || { enabled: true, pin: '8888', autoStartGuardian: true });
      if (body.remoteControl.enabled !== undefined) {
        nextRc.enabled = Boolean(body.remoteControl.enabled);
      }
      if (body.remoteControl.pin !== undefined) {
        const cleanPin = String(body.remoteControl.pin || '').trim();
        if (cleanPin) nextRc.pin = cleanPin;
      }
      if (body.remoteControl.autoStartGuardian !== undefined) {
        nextRc.autoStartGuardian = Boolean(body.remoteControl.autoStartGuardian);
        try {
          remoteControl.setWindowsAutoStart(nextRc.autoStartGuardian, ROOT_DIR);
        } catch (err) {
          console.warn('[remote] 更新开机自启注册表失败:', err.message);
        }
      }
      s.remoteControl = nextRc;
    }

    store.addOpLog({
      module: '系统设置',
      action: '保存全局系统配置',
      detail: `采集模式=${s.collectorMode}，质量合格线=${s.thresholds.minQualityScore}分，飞书形态=${s.feishu.targetMode}`,
    });
    store.save(true);
    return sendJson(res, 200, { ok: true, settings: sanitizeSettingsForClient(db.settings, remoteControl.isLocalLoopbackReq(req)) });
  }

  // 运营免代码新增/管理自定义扩展字段
  if (pathname === '/api/custom-fields/manage' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.action === 'add') {
      const label = String(body.label || '').trim();
      if (!label) return sendJson(res, 400, { error: '字段名称不能为空' });
      const key =
        String(body.key || '')
          .trim()
          .replace(/[^a-zA-Z0-9_]/g, '') || `cf_${Date.now().toString(36)}`;
      const options = String(body.options || '')
        .split(/[,，|]/)
        .map((x) => x.trim())
        .filter(Boolean);

      const newField = {
        id: uid('cf'),
        key,
        label,
        type: body.type || (options.length ? 'select' : 'text'),
        options,
        defaultValue: body.defaultValue || (options[0] || ''),
        syncToFeishu: body.syncToFeishu !== false,
      };
      db.customFields.push(newField);
      store.addOpLog({
        module: '自定义字段',
        action: '新增运营自定义字段',
        detail: `${label} (${newField.type}) · 同步飞书=${newField.syncToFeishu ? '是' : '否'}`,
      });
    } else if (body.action === 'delete') {
      db.customFields = db.customFields.filter((f) => f.id !== body.id);
      store.addOpLog({ module: '自定义字段', action: '删除自定义字段', detail: body.id });
    } else if (body.action === 'toggleSync') {
      const f = db.customFields.find((x) => x.id === body.id);
      if (f) f.syncToFeishu = !f.syncToFeishu;
    }
    store.save();
    return sendJson(res, 200, { ok: true, customFields: db.customFields });
  }

  // 回收站、黑名单与操作/限流日志查询与管理
  if (pathname === '/api/trash-and-logs' && req.method === 'GET') {
    return sendJson(res, 200, {
      trash: db.trash,
      blacklist: db.blacklist,
      rateLimitLogs: db.rateLimitLogs,
      operationLogs: db.operationLogs.slice(0, 200),
    });
  }

  if (pathname === '/api/trash/restore' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const restored = crawlerEngine.restoreFromTrash(body.id, body.operator);
    if (!restored) return sendJson(res, 404, { error: '回收站记录不存在' });
    return sendJson(res, 200, { ok: true, restored });
  }

  if (pathname === '/api/trash/clear' && req.method === 'POST') {
    db.trash = [];
    store.addOpLog({ module: '回收站', action: '清空垃圾回收站', status: 'warning' });
    store.save();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/blacklist/manage' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.action === 'addAccount') {
      const handle = String(body.handle || '').replace(/^@/, '').trim();
      if (handle) {
        db.blacklist.accounts.unshift({
          id: uid('bla'),
          platform: body.platform || '',
          handle,
          reason: body.reason || '运营手动拉黑账号',
          createdAt: new Date().toISOString(),
        });
      }
    } else if (body.action === 'removeAccount') {
      db.blacklist.accounts = db.blacklist.accounts.filter((a) => a.id !== body.id);
    } else if (body.action === 'addKeyword') {
      const word = String(body.word || '').trim();
      if (word) {
        db.blacklist.keywords.unshift({
          id: uid('blk'),
          word,
          reason: body.reason || '运营手动新增屏蔽词',
          createdAt: new Date().toISOString(),
        });
      }
    } else if (body.action === 'removeKeyword') {
      db.blacklist.keywords = db.blacklist.keywords.filter((k) => k.id !== body.id);
    }
    store.addOpLog({ module: '黑名单管理', action: `更新黑名单 (${body.action})` });
    store.save();
    return sendJson(res, 200, { ok: true, blacklist: db.blacklist });
  }

  // 告警解除与联调告警演练测试（对应落地执行步骤4）
  if (pathname === '/api/alerts/dismiss' && req.method === 'POST') {
    const body = await readJsonBody(req);
    store.dismissAlert(body.id || 'ALL');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/alerts/test' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const scenario = body.scenario || 'proxy_low_rate';
    const map = {
      proxy_low_rate: {
        type: 'proxy_low_rate',
        title: '【演练告警】代理IP可用率低于 30%（当前模拟 20%）',
        message: '美区/台湾代理池可用节点不足，系统已触发顶部红色告警并尝试推送飞书机器人消息！',
      },
      platform_zero_2h: {
        type: 'platform_zero_2h',
        title: '【演练告警】Instagram 连续 2 小时未抓到新内容',
        message: '建议检查 IG 搜索词限流冷却状态或补充住宅代理 IP。',
      },
      feishu_sync_fail: {
        type: 'feishu_sync_fail',
        title: '【演练告警】飞书同步连续重试 3 次失败',
        message: '待同步样本已安全锁定在本地重推队列（0丢失），请核查飞书授权状态。',
      },
    };
    const chosen = map[scenario] || map.proxy_low_rate;
    const alert = await store.raiseAlert({ ...chosen, level: 'critical' });
    return sendJson(res, 200, { ok: true, alert });
  }

  // 清空演示/测试样本数据（正式上线前一键清零）
  if (pathname === '/api/demo/clear-samples' && req.method === 'POST') {
    store.createBackupSnapshot('before_clear');
    db.samples = [];
    db.trash = [];
    db.feishuQueue = [];
    db.rateLimitLogs = [];
    store.addOpLog({ module: '系统设置', action: '清空测试样本与回收站数据（已自动备份）', status: 'warning' });
    store.save(true);
    return sendJson(res, 200, { ok: true });
  }

  // Vercel Cron 被动触发采集与归档路由
  if (pathname === '/api/cron/collect') {
    const r = await crawlerEngine.runCrawlTask({
      platforms: ['instagram', 'facebook', 'x', 'threads', 'tiktok'],
      buckets: ['brand', 'competitor', 'generic'],
      maxTotalCandidates: 30,
      fastTest: false,
      operator: 'Vercel Cron 定时采集',
    });
    return sendJson(res, 200, { ok: true, result: r });
  }

  if (pathname === '/api/cron/archive') {
    const r = await feishuSync.archivePeriodSnapshot('daily', '', 'Vercel Cron 每日归档');
    return sendJson(res, 200, { ok: true, result: r });
  }

  return sendJson(res, 404, { error: `未知接口: ${pathname}` });
}

async function requestHandler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    await store.init();
    await seedDemo.ensureInitialSeedIfEmpty();

    const parsedUrl = new URL(req.url || '/', getOriginFromReq(req));
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname, parsedUrl.searchParams);
    }

    // 严格白名单静态文件托管（根目录直出，同时兼容本地访问与 GitHub Pages 网页，绝不暴露 data/db.json 或源码）
    if (pathname === '/' || ALLOWED_ROOT_STATIC.has(pathname)) {
      const targetName = pathname === '/' ? '/index.html' : pathname;
      const fullPath = path.join(ROOT_DIR, targetName.slice(1));
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, Object.assign({
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        }, CORS_HEADERS));
        return res.end(content);
      }
    }

    // 允许访问 covers/ 目录下缓存的封面图片
    if (pathname.startsWith('/covers/')) {
      const relImg = path.normalize(pathname.slice('/covers/'.length)).replace(/^(\.\.[/\\])+/, '');
      const imgPath = path.join(COVERS_DIR, relImg);
      if (imgPath.startsWith(COVERS_DIR) && fs.existsSync(imgPath) && fs.statSync(imgPath).isFile()) {
        const ext = path.extname(imgPath).toLowerCase();
        const content = fs.readFileSync(imgPath);
        res.writeHead(200, Object.assign({
          'Content-Type': MIME_TYPES[ext] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        }, CORS_HEADERS));
        return res.end(content);
      }
    }

    // 首页回退
    if (!pathname.includes('.')) {
      const indexFile = path.join(ROOT_DIR, 'index.html');
      if (fs.existsSync(indexFile)) {
        const html = fs.readFileSync(indexFile);
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, CORS_HEADERS));
        return res.end(html);
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    console.error('[server] 请求处理异常:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message || '服务器内部错误' });
    }
  }
}

function openBrowserUrl(targetUrl) {
  try {
    if (process.platform === 'win32') {
      exec(`cmd /c start "" "${targetUrl}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${targetUrl}"`);
    } else {
      exec(`xdg-open "${targetUrl}"`);
    }
  } catch (_) {
    // 忽略浏览器拉起异常
  }
}

if (require.main === module) {
  const shouldAutoOpen = process.argv.includes('--open');
  const isDryRun = process.argv.includes('--dry-run');
  const localUrl = `http://localhost:${PORT}`;

  console.log('正在启动【交友软广抓视频工作台】，请稍候…');

  store
    .init()
    .then(() => seedDemo.ensureInitialSeedIfEmpty())
    .then(() => {
      const db = store.getDb();
      let changedBootCfg = false;
      if (db && db.settings && !db.settings.remoteControl) {
        db.settings.remoteControl = { enabled: true, pin: '8888', autoStartGuardian: true };
        changedBootCfg = true;
      }
      if (changedBootCfg) store.save(true);
      if (isDryRun) {
        console.log('✅ 启动自检通过');
        process.exit(0);
      }

      scheduler.startBackgroundLoops();
      const server = http.createServer(requestHandler);
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          console.log(`✅ 工作台后台已经在运行中啦！正在直接帮你打开网页：${localUrl}`);
          if (shouldAutoOpen && !isDryRun) {
            openBrowserUrl(localUrl);
            setTimeout(() => process.exit(0), 250);
          } else {
            process.exit(0);
          }
          return;
        }
        console.error('❌ 工作台启动失败:', err && err.message ? err.message : err);
        process.exit(1);
      });

      server.listen(PORT, HOST, () => {
        console.log('==============================================================');
        console.log('  🚀 【交友软广抓视频工作台】已经启动成功！');
        console.log(`  👉 如果浏览器没自动弹出，请打开：${localUrl}`);
        console.log('  ⚠️ 用的时候请别关闭这个黑色窗口（关掉就停止抓取了）');
        console.log('==============================================================');
        if (shouldAutoOpen && !isDryRun) {
          openBrowserUrl(localUrl);
        }
      });
    })
    .catch((err) => {
      console.error('❌ 工作台初始化失败:', err && err.message ? err.message : err);
      process.exit(1);
    });
}

module.exports = {
  handler: requestHandler,
};
