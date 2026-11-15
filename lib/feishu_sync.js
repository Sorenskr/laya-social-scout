'use strict';
/**
 * 飞书开放平台实时同步与高颜值多维表格核心引擎
 * 功能全覆盖：
 *  1. 飞书 OAuth 2.0 扫码一键授权 + refresh_token 无感续期（兼容 tenant_access_token 应用身份）
 *  2. 多维表格（Bitable）高颜值全能架构：
 *     - 第 1 位固定「📊 全部内容总表」（跨平台跨日汇总）+「📅 今日新增 YYYY-MM-DD」+ 5 大平台图标分表
 *     - 原生富组件列：彩色单选胶囊（平台/形态/赛道/热度/难度/状态）、多选品牌胶囊、💯进度条、⭐好抄星级、千分位数字、超链接、日期、封面附件（有云盘权限自动启用，无则自动隐藏不留空列）
 *     - 多维立体视图：表格全览 + 按平台看板（kanban）+ 爆款卡片画册（gallery）
 *     - 按原帖 URL 幂等 Upsert，支持一键推翻重整现有旧表
 *  3. 电子表格（Spreadsheets）模式：单日/周度/月度总表 × 5 平台子表 + 原链接超链接 + 条件着色
 *  4. 报错自动重试 3 次，连续失败触发页面红色告警且本地零丢数据
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const proxyPool = require('./proxy_pool');
const store = require('./store');
const { PLATFORMS, ALL_SYNC_FIELDS, uid } = require('./defaults');
const { decodeHtmlEntities, cleanReadableTitle } = require('./collectors/base_collector');

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const ROOT_DIR = path.join(__dirname, '..');
const MASTER_TABLE_NAME = '📊 全部内容总表';

const oauthStates = new Map();
// 缓存各多维表格 appToken 是否具备 drive media upload 权限，避免反复无效上传报错
const bitableAttachmentSupportMap = new Map();

function getSplitTabs(splitBy = 'platform', targetMode = 'spreadsheet') {
  if (splitBy === 'contentType') {
    return targetMode === 'bitable'
      ? [
          { key: '聊天录屏类', title: '💬 聊天录屏类' },
          { key: '素材混剪类', title: '🎞️ 素材混剪类' },
          { key: '其他可植入泛内容', title: '✨ 其他泛软广类' },
        ]
      : [
          { key: '聊天录屏类', title: '聊天录屏类' },
          { key: '素材混剪类', title: '素材混剪类' },
          { key: '其他可植入泛内容', title: '泛软广类' },
        ];
  }
  if (targetMode === 'bitable') {
    return [
      { key: 'instagram', title: '📸 Instagram' },
      { key: 'facebook', title: '📘 Facebook' },
      { key: 'x', title: '🐦 X 推特' },
      { key: 'threads', title: '🧵 Threads' },
      { key: 'tiktok', title: '🎵 TikTok' },
    ];
  }
  return [
    { key: 'instagram', title: 'IG' },
    { key: 'facebook', title: 'FB' },
    { key: 'x', title: 'X' },
    { key: 'threads', title: 'Threads' },
    { key: 'tiktok', title: 'TikTok' },
  ];
}

function getSampleTabKey(sample, splitBy = 'platform') {
  if (splitBy === 'contentType') {
    if (sample.contentType === '聊天录屏类') return '聊天录屏类';
    if (sample.contentType === '素材混剪类') return '素材混剪类';
    return '其他可植入泛内容';
  }
  return sample.platform || 'instagram';
}

function getLocalTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function feishuRequest(apiPath, { method = 'GET', token = '', body = null, rawHeaders = null, timeoutMs = 15000 } = {}) {
  const url = apiPath.startsWith('http') ? apiPath : `${FEISHU_API_BASE}${apiPath}`;
  const isBuf = Buffer.isBuffer(body);
  const headers = Object.assign(
    isBuf ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
    rawHeaders || {}
  );
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await proxyPool.requestRaw(
    url,
    {
      method,
      headers,
      body: body ? (isBuf ? body : JSON.stringify(body)) : null,
      timeoutMs,
      noSystemProxy: true,
    },
    null
  );

  let data;
  try {
    data = resp.json();
  } catch (_) {
    throw new Error(`飞书接口非JSON响应 HTTP ${resp.statusCode}: ${resp.text().slice(0, 160)}`);
  }

  if (resp.statusCode < 200 || resp.statusCode >= 300 || (data.code !== undefined && data.code !== 0)) {
    const err = new Error(`飞书API错误 [${data.code ?? resp.statusCode}]: ${data.msg || data.error_description || '未知错误'}`);
    err.feishuCode = data.code ?? resp.statusCode;
    throw err;
  }
  return data;
}

/**
 * 生成飞书扫码授权跳转地址
 */
function buildOAuthAuthorizeUrl(originUrl) {
  const db = store.getDb();
  const cfg = db.settings.feishu || {};
  const appId = (cfg.appId || process.env.FEISHU_APP_ID || '').trim();
  if (!appId) {
    throw new Error('请先在【系统设置 -> 飞书授权管理】填入飞书企业自建应用的 App ID 与 App Secret（仅首次配置1次）');
  }
  const redirectUri = (cfg.redirectUri || `${originUrl.replace(/\/+$/, '')}/api/feishu/oauth/callback`).trim();
  const state = crypto.randomBytes(12).toString('hex');
  oauthStates.set(state, { createdAt: Date.now(), redirectUri });

  const scopes = [
    'drive:drive',
    'sheets:spreadsheet',
    'bitable:app',
    'contact:user.base:readonly',
    'offline_access',
  ].join(' ');

  const authUrl =
    `https://open.feishu.cn/open-apis/authen/v1/authorize` +
    `?app_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${encodeURIComponent(state)}`;

  return { authUrl, redirectUri, state };
}

/**
 * 获取应用级 app_access_token / tenant_access_token
 */
async function getAppAccessToken(appId, appSecret) {
  const res = await feishuRequest('/auth/v3/app_access_token/internal', {
    method: 'POST',
    body: { app_id: appId, app_secret: appSecret },
  });
  return res.app_access_token || res.tenant_access_token;
}

/**
 * 处理飞书扫码回调，换取 user_access_token + refresh_token 并绑定当前账号
 */
async function handleOAuthCallback(code, state, originUrl) {
  const db = store.getDb();
  const cfg = db.settings.feishu;
  const appId = (cfg.appId || process.env.FEISHU_APP_ID || '').trim();
  const appSecret = (cfg.appSecret || process.env.FEISHU_APP_SECRET || '').trim();
  if (!appId || !appSecret) {
    throw new Error('飞书 App ID 或 App Secret 未配置');
  }

  const stateRecord = oauthStates.get(state);
  if (stateRecord) oauthStates.delete(state);
  const redirectUri =
    (stateRecord && stateRecord.redirectUri) ||
    cfg.redirectUri ||
    `${originUrl.replace(/\/+$/, '')}/api/feishu/oauth/callback`;

  let tokenData = null;
  try {
    const resp = await proxyPool.requestRaw(
      `${FEISHU_API_BASE}/authen/v2/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: appId,
          client_secret: appSecret,
          code,
          redirect_uri: redirectUri,
        }),
        noSystemProxy: true,
      },
      null
    );
    const parsed = resp.json();
    if (parsed.access_token) {
      tokenData = parsed;
    }
  } catch (_) { /* fallback to v1 */ }

  if (!tokenData) {
    const appToken = await getAppAccessToken(appId, appSecret);
    const v1Res = await feishuRequest('/authen/v1/oidc/access_token', {
      method: 'POST',
      token: appToken,
      body: { grant_type: 'authorization_code', code },
    });
    tokenData = v1Res.data || v1Res;
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token || '';
  const expiresIn = Number(tokenData.expires_in || 7200);

  let userName = '飞书授权运营账号';
  let userOpenId = '';
  let userAvatar = '';
  try {
    const uRes = await feishuRequest('/authen/v1/user_info', { method: 'GET', token: accessToken });
    const u = uRes.data || {};
    userName = u.name || userName;
    userOpenId = u.open_id || '';
    userAvatar = u.avatar_thumb || u.avatar_url || '';
  } catch (_) { /* ignore profile fetch failure */ }

  cfg.authorized = true;
  cfg.accessToken = accessToken;
  cfg.refreshToken = refreshToken;
  cfg.tokenExpiresAt = Date.now() + (expiresIn - 180) * 1000;
  cfg.userName = userName;
  cfg.userOpenId = userOpenId;
  cfg.userAvatar = userAvatar;
  cfg.consecutiveFailures = 0;
  cfg.lastSyncStatus = `已扫码授权（${userName}）`;

  store.addOpLog({
    module: '飞书同步',
    action: '飞书扫码一键授权成功',
    operator: userName,
    status: 'success',
    detail: `已绑定飞书账号「${userName}」，支持总表+每日表+5平台分表高颜值同步`,
  });
  store.save(true);
  return { userName, userAvatar };
}

/**
 * 确保获得可用的飞书访问令牌（过期自动使用 refresh_token 刷新；若未扫码但配了应用密钥可降级用 tenant_access_token）
 */
async function ensureValidAccessToken() {
  const db = store.getDb();
  const cfg = db.settings.feishu || {};
  const now = Date.now();

  if (cfg.accessToken && cfg.tokenExpiresAt > now) {
    return cfg.accessToken;
  }

  const appId = (cfg.appId || process.env.FEISHU_APP_ID || '').trim();
  const appSecret = (cfg.appSecret || process.env.FEISHU_APP_SECRET || '').trim();

  if (cfg.refreshToken && appId && appSecret) {
    try {
      const resp = await proxyPool.requestRaw(
        `${FEISHU_API_BASE}/authen/v2/oauth/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: appId,
            client_secret: appSecret,
            refresh_token: cfg.refreshToken,
          }),
          noSystemProxy: true,
        },
        null
      );
      const parsed = resp.json();
      if (parsed.access_token) {
        cfg.accessToken = parsed.access_token;
        if (parsed.refresh_token) cfg.refreshToken = parsed.refresh_token;
        cfg.tokenExpiresAt = Date.now() + (Number(parsed.expires_in || 7200) - 180) * 1000;
        store.save();
        return cfg.accessToken;
      }
    } catch (_) {
      try {
        const appToken = await getAppAccessToken(appId, appSecret);
        const v1 = await feishuRequest('/authen/v1/oidc/refresh_access_token', {
          method: 'POST',
          token: appToken,
          body: { grant_type: 'refresh_token', refresh_token: cfg.refreshToken },
        });
        const d = v1.data || {};
        if (d.access_token) {
          cfg.accessToken = d.access_token;
          if (d.refresh_token) cfg.refreshToken = d.refresh_token;
          cfg.tokenExpiresAt = Date.now() + (Number(d.expires_in || 7200) - 180) * 1000;
          store.save();
          return cfg.accessToken;
        }
      } catch (_e) { /* fallthrough */ }
    }
  }

  if (appId && appSecret) {
    const tRes = await feishuRequest('/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      body: { app_id: appId, app_secret: appSecret },
    });
    return tRes.tenant_access_token;
  }

  throw new Error('飞书尚未授权绑定，请前往【系统设置 -> 飞书授权管理】扫码绑定账号');
}

/**
 * 将历史 db.settings.feishu.syncFields 无损迁移到高颜值新字段定义，保留用户手工开关
 */
function upgradeSyncFieldsToPretty(db) {
  if (!db.settings.feishu) db.settings.feishu = {};
  const oldList = Array.isArray(db.settings.feishu.syncFields) ? db.settings.feishu.syncFields : [];
  const oldMap = new Map(oldList.map((f) => [f.key, f]));
  const legacyDefaultDisabledKeys = new Set(['durationSec', 'bgm', 'shares', 'bookmarks', 'topCommentsText', 'replicationStepsText']);
  const needV3Reset = Number(db.settings.feishu.prettySchemaVersion || 0) < 3;
  const isOldVersion = !oldMap.has('mediaFormat')
    || !oldMap.has('viralLevel')
    || (oldMap.get('title') && oldMap.get('title').label === '作品名称')
    || (oldMap.get('publishedAt') && oldMap.get('publishedAt').label !== '📅 发布日期');
  const expectedTopOrder = ALL_SYNC_FIELDS.slice(0, 6).map((f) => f.key).join(',');
  const currentTopOrder = oldList.slice(0, 6).map((f) => f.key).join(',');
  const isOrderDrifted = currentTopOrder !== expectedTopOrder;

  db.settings.feishu.syncFields = ALL_SYNC_FIELDS.map((def) => {
    const prev = oldMap.get(def.key);
    let enabled = def.enabled;
    if (def.required) {
      enabled = true;
    } else if (needV3Reset) {
      enabled = Boolean(def.enabled);
    } else if (prev && typeof prev.enabled === 'boolean') {
      enabled = (isOldVersion && legacyDefaultDisabledKeys.has(def.key)) ? false : prev.enabled;
    } else if (isOrderDrifted && typeof def.enabled === 'boolean') {
      enabled = def.enabled;
    }
    return { ...def, enabled };
  });

  if (needV3Reset && Array.isArray(db.customFields)) {
    const samples = Array.isArray(db.samples) ? db.samples : [];
    for (const cf of db.customFields) {
      const hasAnyValue = samples.some((s) => s && s.customValues && String(s.customValues[cf.key] || '').trim() !== '');
      if (!hasAnyValue || cf.id === 'cf_hook_style') {
        cf.syncToFeishu = false;
      }
    }
  }
  db.settings.feishu.prettySchemaVersion = 3;

  if (db.settings.feishu.masterTab === undefined) {
    db.settings.feishu.masterTab = true;
  }
  return db.settings.feishu.syncFields;
}

/**
 * 获取当前勾选需要同步的列定义（标准勾选字段 + 勾选同步的运营自定义字段）
 */
function getActiveSyncColumns(db, { includeAttachment = true } = {}) {
  upgradeSyncFieldsToPretty(db);
  const stdCols = (db.settings.feishu.syncFields || []).filter(
    (f) => f.enabled && (includeAttachment || f.key !== 'coverImage')
  );
  const customCols = (db.customFields || [])
    .filter((cf) => cf.syncToFeishu !== false)
    .map((cf) => ({
      key: `custom:${cf.key}`,
      label: cf.label,
      isCustom: true,
      customKey: cf.key,
    }));
  return [...stdCols, ...customCols];
}

function colIndexToLetter(idxZeroBased) {
  let n = idxZeroBased + 1;
  let str = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str || 'A';
}

function formatDifficultyLabel(diffVal) {
  const d = Math.max(1, Math.min(5, Math.round(Number(diffVal || 2))));
  const labels = {
    1: '🟢 1星·极易照抄',
    2: '🟢 2星·简单改字',
    3: '🟡 3星·中等剪辑',
    4: '🟠 4星·较难重制',
    5: '🔴 5星·高难实拍',
  };
  return labels[d] || '🟢 2星·简单改字';
}

function formatPlatformCapsule(sample) {
  const p = String(sample.platform || 'instagram').toLowerCase();
  const map = {
    tiktok: '🎵 TikTok',
    instagram: '📸 Instagram',
    facebook: '📘 Facebook',
    x: '🐦 X (Twitter)',
    threads: '🧵 Threads',
  };
  return map[p] || '📸 Instagram';
}

function formatMediaFormatCapsule(sample) {
  if (sample.mediaType === 'image') return '🖼️ 图文帖';
  if (sample.mediaType === 'text') return '📝 纯文字';
  return '🎬 短视频';
}

function formatCategoryCapsule(sample) {
  if (sample.categoryGroup === 'brand') return '🔥 Laya 品牌';
  if (sample.categoryGroup === 'competitor') return '⚔️ 竞品对标';
  return '💡 泛交友爆款';
}

function formatContentTypeCapsule(sample) {
  const ct = String(sample.contentType || '');
  if (ct.includes('图文')) return '🖼️ 图文聊天/配图类';
  if (ct.includes('纯文字') || ct.includes('串文')) return '📝 纯文字热帖/串文类';
  if (ct.includes('混剪')) return '🎞️ 素材混剪类';
  if (ct.includes('聊天录屏')) return '💬 聊天录屏类';
  if (sample.mediaType === 'text') return '📝 纯文字热帖/串文类';
  if (sample.mediaType === 'image') return '🖼️ 图文聊天/配图类';
  return '✨ 其他泛软广类';
}

function formatViralLevelCapsule(sample) {
  const likes = Number(sample.likes || 0);
  const plays = Number(sample.plays || 0);
  if (likes >= 10000 || plays >= 50000) return '💥 万赞大爆款';
  if (likes >= 500 || plays >= 5000) return '🔥 千赞高热帖';
  if (likes > 0 || plays > 0) return '📈 潜力验证帖';
  return '🆕 最新收录';
}

function formatSampleFieldValue(sample, colKey, forSpreadsheetRichLink = true) {
  if (colKey.startsWith('custom:')) {
    const ck = colKey.slice('custom:'.length);
    return (sample.customValues && sample.customValues[ck]) || '';
  }
  const pObj = PLATFORMS.find((p) => p.id === sample.platform);
  const likes = Number(sample.likes || 0);
  const plays = Number(sample.plays || 0);
  const comments = Number(sample.comments || 0);

  switch (colKey) {
    case 'title': {
      const cleanT = cleanReadableTitle(sample.title || '', {
        fallbackText: sample.fullText || '',
        authorHandle: sample.authorHandle || '',
        platform: sample.platform || '',
      });
      if (forSpreadsheetRichLink) {
        if (sample.mediaType === 'image' && !/^\[图文\]/.test(cleanT)) return `[图文] ${cleanT}`;
        if (sample.mediaType === 'text' && !/^\[纯文字\]/.test(cleanT)) return `[纯文字] ${cleanT}`;
      }
      return cleanT;
    }
    case 'coverImage': {
      if (forSpreadsheetRichLink) return sample.coverUrl || '';
      return sample._feishuCoverToken ? [{ file_token: sample._feishuCoverToken }] : null;
    }
    case 'videoUrl': {
      if (!sample.videoUrl) return forSpreadsheetRichLink ? '' : null;
      if (forSpreadsheetRichLink) {
        return [{ type: 'url', text: '点击跳转原视频', link: sample.videoUrl }];
      }
      const btnText =
        sample.mediaType === 'image'
          ? '🖼️ 点击查看原图文'
          : sample.mediaType === 'text'
            ? '📄 点击查看原帖子'
            : '▶️ 点击观看原视频';
      return { text: btnText, link: sample.videoUrl };
    }
    case 'platformLabel':
      if (!forSpreadsheetRichLink) return formatPlatformCapsule(sample);
      return sample.mergedPlatforms && sample.mergedPlatforms.length > 1
        ? `${pObj ? pObj.shortName : sample.platform} (含跨平台:${sample.mergedPlatforms.join('/')})`
        : pObj
          ? pObj.name
          : sample.platform;
    case 'mediaFormat':
      return formatMediaFormatCapsule(sample);
    case 'categoryLabel':
      return formatCategoryCapsule(sample);
    case 'contentType':
      return forSpreadsheetRichLink ? (sample.contentType || '聊天录屏类') : formatContentTypeCapsule(sample);
    case 'viralLevel':
      return formatViralLevelCapsule(sample);
    case 'qualityScore':
      return Math.max(0, Math.min(100, Math.round(Number(sample.qualityScore || 80))));
    case 'easyStarRating': {
      const d = Math.max(1, Math.min(5, Math.round(Number(sample.implantDifficulty || 2))));
      return Math.max(1, Math.min(5, 6 - d));
    }
    case 'implantDifficulty':
      return forSpreadsheetRichLink
        ? `${'★'.repeat(Number(sample.implantDifficulty || 2))} (${sample.implantDifficulty || 2}星)`
        : formatDifficultyLabel(sample.implantDifficulty);
    case 'plays':
      return Math.max(0, Math.round(plays));
    case 'likes':
      return Math.max(0, Math.round(likes));
    case 'comments':
      return Math.max(0, Math.round(comments));
    case 'shares':
      return Number(sample.shares || 0);
    case 'bookmarks':
      return Number(sample.bookmarks || 0);
    case 'exposedBrandsText': {
      const list = Array.isArray(sample.exposedBrands)
        ? sample.exposedBrands.map((b) => String(b || '').trim()).filter(Boolean)
        : [];
      const uniq = Array.from(new Set(list));
      if (!forSpreadsheetRichLink) {
        return uniq.length ? uniq : ['泛流量无竞品'];
      }
      return uniq.length ? uniq.join(' / ') : '无（泛流量可植入）';
    }
    case 'implantGuideText': {
      const g = sample.implantGuide || {};
      return [
        g.exactTiming ? `⏱️ 植入时机：${g.exactTiming}` : '',
        g.visualHook ? `🎨 画面细节：${g.visualHook}` : '',
        g.copyScript ? `✍️ 改写话术：${g.copyScript}` : '',
        g.commentSeedScript ? `💬 评论双簧：${g.commentSeedScript}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'fullText': {
      const txt = decodeHtmlEntities(sample.fullText || '').replace(/\s+/g, ' ').trim();
      return txt.slice(0, 650);
    }
    case 'publishedAt': {
      const ts = new Date(sample.publishedAt || sample.collectedAt || Date.now()).getTime();
      if (!forSpreadsheetRichLink) {
        return Number.isFinite(ts) && ts > 0 ? Math.round(ts) : Date.now();
      }
      return sample.publishedAt ? sample.publishedAt.replace('T', ' ').slice(0, 19) : getLocalTodayStr();
    }
    case 'usedStatusText':
      if (!forSpreadsheetRichLink) {
        return sample.markedUsed ? '✅ 已投产上线' : sample.favorited ? '⭐ 重点收藏' : '🆕 待翻拍';
      }
      return sample.markedUsed ? '已使用' : sample.favorited ? '已收藏待用' : '未使用';
    case 'durationSec':
      if (sample.mediaType === 'text') return '纯文字帖';
      if (sample.mediaType === 'image') return '图文帖';
      return `${sample.durationSec || 15}秒`;
    case 'bgm':
      return sample.bgm || '';
    case 'topCommentsText':
      return (sample.topComments || [])
        .slice(0, 3)
        .map((c, i) => `Top${i + 1}[赞${c.likes || 0}]: ${c.text || ''}`)
        .join('\n');
    case 'replicationStepsText':
      return Array.isArray(sample.replicationSteps) ? sample.replicationSteps.join('\n') : String(sample.replicationSteps || '');
    default:
      return sample[colKey] !== undefined ? String(sample[colKey]) : '';
  }
}

/**
 * 尝试把样本真实封面图 (.jpg/.png/.webp) 上传至飞书多维表格素材库并返回 file_token；
 * 若应用无云盘上传权限，立即记住结果并静默跳过
 */
async function uploadCoverForBitable(token, appToken, sample) {
  if (!sample || !appToken) return '';
  if (bitableAttachmentSupportMap.get(appToken) === false) return '';

  if (sample.feishuCoverTokens && sample.feishuCoverTokens[appToken]) {
    sample._feishuCoverToken = sample.feishuCoverTokens[appToken];
    return sample._feishuCoverToken;
  }

  const rawCover = String(sample.coverUrl || '').trim();
  if (!rawCover || rawCover.startsWith('data:')) return '';
  const rel = rawCover.replace(/^\.\//, '').replace(/^\//, '');
  const absPath = path.isAbsolute(rel) ? rel : path.join(ROOT_DIR, rel);
  if (!fs.existsSync(absPath)) return '';

  const ext = path.extname(absPath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return '';
  const stat = fs.statSync(absPath);
  if (stat.size < 100 || stat.size > 15 * 1024 * 1024) return '';

  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const fileName = path.basename(absPath);
  const fileBuf = fs.readFileSync(absPath);
  const boundary = `----LayaFeishuBoundary${crypto.randomBytes(8).toString('hex')}`;

  const textPart = (name, val) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`, 'utf8');
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`,
    'utf8'
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  const bodyBuf = Buffer.concat([
    textPart('file_name', fileName),
    textPart('parent_type', 'bitable_image'),
    textPart('parent_node', appToken),
    textPart('size', String(stat.size)),
    fileHeader,
    fileBuf,
    closing,
  ]);

  try {
    const res = await feishuRequest('/drive/v1/medias/upload_all', {
      method: 'POST',
      token,
      body: bodyBuf,
      rawHeaders: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      timeoutMs: 25000,
    });
    const ft = (res.data && res.data.file_token) || '';
    if (ft) {
      bitableAttachmentSupportMap.set(appToken, true);
      if (!sample.feishuCoverTokens) sample.feishuCoverTokens = {};
      sample.feishuCoverTokens[appToken] = ft;
      sample._feishuCoverToken = ft;
      return ft;
    }
  } catch (err) {
    // 权限不足（常见错误码 99991663 / 1061004 / 99991672）时缓存状态避免重复报错拖慢同步
    const msg = String(err.message || '');
    if (/permission|scope|denied|forbidden|1061004|99991672|99991663|403/i.test(msg)) {
      bitableAttachmentSupportMap.set(appToken, false);
    }
  }
  return '';
}

/**
 * 构建飞书多维表格富组件字段定义
 */
function buildBitableFieldSpec(col, { simplifyUi = false } = {}) {
  switch (col.key) {
    case 'title':
      return { field_name: col.label, type: 1 };
    case 'coverImage':
      return simplifyUi ? { field_name: col.label, type: 17 } : { field_name: col.label, type: 17, ui_type: 'Attachment' };
    case 'platformLabel':
      return {
        field_name: col.label,
        type: 3,
        ui_type: 'SingleSelect',
        property: {
          options: [
            { name: '🎵 TikTok', color: 0 },
            { name: '📸 Instagram', color: 5 },
            { name: '📘 Facebook', color: 4 },
            { name: '🐦 X (Twitter)', color: 7 },
            { name: '🧵 Threads', color: 6 },
          ],
        },
      };
    case 'mediaFormat':
      return {
        field_name: col.label,
        type: 3,
        ui_type: 'SingleSelect',
        property: {
          options: [
            { name: '🎬 短视频', color: 4 },
            { name: '🖼️ 图文帖', color: 2 },
            { name: '📝 纯文字', color: 6 },
          ],
        },
      };
    case 'categoryLabel':
      return {
        field_name: col.label,
        type: 3,
        ui_type: 'SingleSelect',
        property: {
          options: [
            { name: '🔥 Laya 品牌', color: 0 },
            { name: '⚔️ 竞品对标', color: 1 },
            { name: '💡 泛交友爆款', color: 3 },
          ],
        },
      };
    case 'contentType':
      return {
        field_name: col.label,
        type: 3,
        ui_type: 'SingleSelect',
        property: {
          options: [
            { name: '💬 聊天录屏类', color: 4 },
            { name: '🖼️ 图文聊天/配图类', color: 2 },
            { name: '📝 纯文字热帖/串文类', color: 6 },
            { name: '🎞️ 素材混剪类', color: 1 },
            { name: '✨ 其他泛软广类', color: 3 },
          ],
        },
      };
    case 'videoUrl':
      return simplifyUi ? { field_name: col.label, type: 15 } : { field_name: col.label, type: 15, ui_type: 'Url' };
    case 'qualityScore':
      return simplifyUi
        ? { field_name: col.label, type: 2, property: { formatter: '0' } }
        : { field_name: col.label, type: 2, ui_type: 'Progress', property: { formatter: '0', min: 0, max: 100, range_customize: true } };
    case 'easyStarRating':
      return simplifyUi
        ? { field_name: col.label, type: 2, property: { formatter: '0' } }
        : { field_name: col.label, type: 2, ui_type: 'Rating', property: { formatter: '0', min: 1, max: 5, rating: { symbol: 'star' } } };
    case 'viralLevel':
      return {
        field_name: col.label,
        type: 3,
        ui_type: 'SingleSelect',
        property: {
          options: [
            { name: '💥 万赞大爆款', color: 0 },
            { name: '🔥 千赞高热帖', color: 1 },
            { name: '📈 潜力验证帖', color: 3 },
            { name: '🆕 最新收录', color: 4 },
          ],
        },
      };
    case 'implantDifficulty':
      return {
        field_name: col.label,
        type: 3,
        ui_type: 'SingleSelect',
        property: {
          options: [
            { name: '🟢 1星·极易照抄', color: 3 },
            { name: '🟢 2星·简单改字', color: 2 },
            { name: '🟡 3星·中等剪辑', color: 1 },
            { name: '🟠 4星·较难重制', color: 5 },
            { name: '🔴 5星·高难实拍', color: 0 },
          ],
        },
      };
    case 'likes':
    case 'plays':
    case 'comments':
    case 'shares':
    case 'bookmarks':
      return simplifyUi
        ? { field_name: col.label, type: 2 }
        : { field_name: col.label, type: 2, ui_type: 'Number', property: { formatter: '#,##0' } };
    case 'exposedBrandsText':
      return simplifyUi
        ? { field_name: col.label, type: 4, property: { options: [{ name: 'Laya', color: 0 }, { name: '泛流量无竞品', color: 3 }] } }
        : {
            field_name: col.label,
            type: 4,
            ui_type: 'MultiSelect',
            property: {
              options: [
                { name: 'Laya', color: 0 },
                { name: 'Laya Couples', color: 5 },
                { name: 'Litmatch', color: 4 },
                { name: 'Goodnight', color: 1 },
                { name: 'Cheers', color: 2 },
                { name: 'Omi', color: 6 },
                { name: 'Soul', color: 7 },
                { name: '泛流量无竞品', color: 3 },
              ],
            },
          };
    case 'publishedAt':
      return simplifyUi ? { field_name: col.label, type: 5 } : { field_name: col.label, type: 5, ui_type: 'DateTime' };
    case 'usedStatusText':
      return {
        field_name: col.label,
        type: 3,
        ui_type: 'SingleSelect',
        property: {
          options: [
            { name: '🆕 待翻拍', color: 4 },
            { name: '⭐ 重点收藏', color: 1 },
            { name: '✅ 已投产上线', color: 3 },
            { name: '⏸️ 暂缓', color: 7 },
          ],
        },
      };
    default:
      return { field_name: col.label, type: 1 };
  }
}

function buildBitableFieldsDef(cols, { simplifyUi = false } = {}) {
  return cols.map((c, idx) => {
    if (idx === 0) return { field_name: c.label, type: 1 };
    return buildBitableFieldSpec(c, { simplifyUi });
  });
}

async function createBitableFieldSafe(token, appToken, tableId, col) {
  const spec = buildBitableFieldSpec(col, { simplifyUi: false });
  try {
    await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
      method: 'POST',
      token,
      body: spec,
    });
    return true;
  } catch (_) {
    try {
      const fallbackSpec = buildBitableFieldSpec(col, { simplifyUi: true });
      delete fallbackSpec.ui_type;
      await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        method: 'POST',
        token,
        body: fallbackSpec,
      });
      return true;
    } catch (_e) {
      try {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
          method: 'POST',
          token,
          body: { field_name: col.label, type: spec.type === 17 ? 1 : spec.type },
        });
        return true;
      } catch (_ee) {
        return false;
      }
    }
  }
}

/**
 * 为多维表格数据表配置高颜值多视图（综合流量总榜 + 按浏览量 + 按评论热议 + 按平台看板 + 卡片画册）
 */
async function ensureTablePrettyViews(token, appToken, tableId, { isMaster = false } = {}) {
  if (!appToken || !tableId) return [];
  try {
    const [viewsRes, fieldsRes] = await Promise.all([
      feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/views?page_size=50`, { method: 'GET', token }),
      feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`, { method: 'GET', token }).catch(() => ({ data: { items: [] } })),
    ]);
    let views = (viewsRes.data && viewsRes.data.items) || [];
    const fieldItems = (fieldsRes.data && fieldsRes.data.items) || [];
    const findFid = (name, altRe) => {
      const f = fieldItems.find((it) => it.field_name === name || (altRe && altRe.test(String(it.field_name || ''))));
      return f ? f.field_id : '';
    };
    const likesFid = findFid('👍 点赞数', /点赞/i);
    const playsFid = findFid('▶️ 浏览/播放量', /浏览|播放/i);
    const commentsFid = findFid('💬 评论数', /评论/i);

    const gridView = views.find((v) => v.view_type === 'grid') || views[0];
    const targetGridName = isMaster ? '🔥 综合流量总榜' : '🔥 本周流量总榜';

    const applyViewSort = async (viewId, sortInfo) => {
      if (!viewId || !Array.isArray(sortInfo) || !sortInfo.length) return;
      try {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/views/${viewId}`, {
          method: 'PATCH',
          token,
          body: { property: { sort_info: sortInfo } },
        });
      } catch (_) {}
    };

    if (gridView && gridView.view_id) {
      if (gridView.view_name !== targetGridName) {
        try {
          await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/views/${gridView.view_id}`, {
            method: 'PATCH',
            token,
            body: { view_name: targetGridName },
          });
        } catch (_) {}
      }
      const primarySorts = [
        likesFid ? { field_id: likesFid, desc: true } : null,
        playsFid ? { field_id: playsFid, desc: true } : null,
        commentsFid ? { field_id: commentsFid, desc: true } : null,
      ].filter(Boolean);
      await applyViewSort(gridView.view_id, primarySorts);
    }

    const extraGridSpecs = [
      {
        name: '▶️ 按浏览量排序',
        sorts: [
          playsFid ? { field_id: playsFid, desc: true } : null,
          likesFid ? { field_id: likesFid, desc: true } : null,
        ].filter(Boolean),
      },
      {
        name: '💬 按评论热议榜',
        sorts: [
          commentsFid ? { field_id: commentsFid, desc: true } : null,
          likesFid ? { field_id: likesFid, desc: true } : null,
        ].filter(Boolean),
      },
    ];

    for (const spec of extraGridSpecs) {
      let existing = views.find((v) => v.view_name === spec.name);
      if (!existing) {
        try {
          const created = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/views`, {
            method: 'POST',
            token,
            body: { view_name: spec.name, view_type: 'grid' },
          });
          existing = (created.data && created.data.view) || null;
          if (existing) views.push(existing);
        } catch (_) {}
      }
      if (existing && existing.view_id) {
        await applyViewSort(existing.view_id, spec.sorts);
      }
    }

    if (isMaster && !views.some((v) => v.view_type === 'kanban')) {
      try {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/views`, {
          method: 'POST',
          token,
          body: { view_name: '📌 按平台看板', view_type: 'kanban' },
        });
      } catch (_) {}
    }

    if (!views.some((v) => v.view_type === 'gallery')) {
      try {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/views`, {
          method: 'POST',
          token,
          body: { view_name: isMaster ? '🖼️ 爆款卡片画册' : '🖼️ 卡片画册', view_type: 'gallery' },
        });
      } catch (_) {}
    }

    const latest = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/views?page_size=50`, {
      method: 'GET',
      token,
    });
    return (latest.data && latest.data.items) || [];
  } catch (_) {
    return [];
  }
}

async function ensureBitableTableWithFields(token, appToken, tableName, cols, cacheMap = {}, cacheKey = '', { isMaster = false } = {}) {
  const key = cacheKey || tableName;
  if (cacheMap && cacheMap[key]) {
    return cacheMap[key];
  }

  const listRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables?page_size=100`, {
    method: 'GET',
    token,
  });
  const items = (listRes.data && listRes.data.items) || [];
  const existing = items.find((t) => t.name === tableName);
  let tableId = existing && existing.table_id;

  if (tableId) {
    try {
      const fRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`, {
        method: 'GET',
        token,
      });
      const existingNames = new Set(((fRes.data && fRes.data.items) || []).map((f) => f.field_name));
      for (let i = 0; i < cols.length; i++) {
        if (!existingNames.has(cols[i].label)) {
          await createBitableFieldSafe(token, appToken, tableId, cols[i]);
        }
      }
    } catch (_) {
      // 补齐缺失列容错
    }
    await ensureTablePrettyViews(token, appToken, tableId, { isMaster });
  } else {
    const fieldsDef = buildBitableFieldsDef(cols, { simplifyUi: false });
    try {
      const tRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables`, {
        method: 'POST',
        token,
        body: {
          table: {
            name: tableName,
            default_view_name: isMaster ? '📋 全景精编总览' : '📋 精选列表',
            fields: fieldsDef,
          },
        },
      });
      tableId = tRes.data && tRes.data.table_id;
    } catch (_) {
      // 若批量字段带高级 ui_type 被拒绝，则先建主列空表，再逐列容错添加富字段
      const tRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables`, {
        method: 'POST',
        token,
        body: {
          table: {
            name: tableName,
            default_view_name: isMaster ? '📋 全景精编总览' : '📋 精选列表',
            fields: [{ field_name: cols[0].label, type: 1 }],
          },
        },
      });
      tableId = tRes.data && tRes.data.table_id;
      if (tableId) {
        for (let i = 1; i < cols.length; i++) {
          await createBitableFieldSafe(token, appToken, tableId, cols[i]);
        }
      }
    }
    if (tableId) {
      await ensureTablePrettyViews(token, appToken, tableId, { isMaster });
    }
  }

  if (tableId && cacheMap) {
    cacheMap[key] = tableId;
  }
  return tableId;
}

/**
 * 构建样本写入多维表格记录的字段对象
 */
function buildBitableRecordFields(sample, cols) {
  const recordFields = {};
  for (const col of cols) {
    const val = formatSampleFieldValue(sample, col.key, false);
    if (val !== '' && val !== undefined && val !== null) {
      if (Array.isArray(val) && val.length === 0) continue;
      recordFields[col.label] = val;
    }
  }
  return recordFields;
}

/**
 * 按原帖链接幂等写入或更新单张多维表格记录
 */
async function upsertBitableRecord(token, appToken, tableId, sample, cols) {
  if (!tableId || !sample) return;
  const recordFields = buildBitableRecordFields(sample, cols);
  const urlCol = cols.find((c) => c.key === 'videoUrl');
  const urlColName = urlCol ? urlCol.label : '🔗 原帖直达';
  const targetUrl = String(sample.videoUrl || '').trim();

  let matchedRecordId = '';
  if (targetUrl) {
    try {
      const listRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=200`, {
        method: 'GET',
        token,
      });
      const recs = (listRes.data && listRes.data.items) || [];
      const hit = recs.find((r) => {
        const v = r.fields && (r.fields[urlColName] || r.fields['原视频直链（超链接）']);
        const link = typeof v === 'string' ? v : v && v.link;
        return link && link === targetUrl;
      });
      if (hit && hit.record_id) matchedRecordId = hit.record_id;
    } catch (_) {}
  }

  if (matchedRecordId) {
    await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${matchedRecordId}`, {
      method: 'PUT',
      token,
      body: { fields: recordFields },
    });
  } else {
    await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
      method: 'POST',
      token,
      body: { fields: recordFields },
    });
  }
}

/**
 * 按「Laya 品牌优先 + 竞品其次 + 综合点赞/播放/质量分倒序」排列全库样本
 */
function sortSamplesPretty(samples) {
  return [...(samples || [])].sort((a, b) => {
    const likesDiff = Number(b.likes || 0) - Number(a.likes || 0);
    if (likesDiff !== 0) return likesDiff;
    const playsDiff = Number(b.plays || 0) - Number(a.plays || 0);
    if (playsDiff !== 0) return playsDiff;
    const commentsDiff = Number(b.comments || 0) - Number(a.comments || 0);
    if (commentsDiff !== 0) return commentsDiff;
    const qDiff = Number(b.qualityScore || 0) - Number(a.qualityScore || 0);
    if (qDiff !== 0) return qDiff;
    return String(b.publishedAt || b.collectedAt || '').localeCompare(String(a.publishedAt || a.collectedAt || ''));
  });
}

/**
 * 尝试开启多维表格默认组织内链接可编辑权限（失败静默容错）
 */
async function tryEnableDefaultBitablePermissions(token, appToken) {
  try {
    await feishuRequest(`/drive/v1/permissions/${appToken}/public?type=bitable`, {
      method: 'PATCH',
      token,
      body: {
        external_access: true,
        security_entity: 'anyone_can_edit',
        comment_entity: 'anyone_can_edit',
        share_entity: 'anyone',
        link_share_entity: 'tenant_editable',
      },
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 一键推翻重整现有多维表格：
 *  - 将最左侧第 1 张表原地改名为「📊 全部内容总表」并配置富组件列 + 全景/看板/画册视图
 *  - 清理旧纯文本丑表
 *  - 新建「📅 今日新增 YYYY-MM-DD」与 5 大平台图标分表
 *  - 上传真封面图片（若具备云盘上传权限，否则自动省略附件列不留空列）并按 Laya 优先全量写入
 */
async function rebuildPrettyBitableAll(samplesOverride = null) {
  const db = store.getDb();
  const cfg = db.settings.feishu || {};
  const token = await ensureValidAccessToken();
  upgradeSyncFieldsToPretty(db);

  if (!cfg.bitableAppToken) {
    const createRes = await feishuRequest('/bitable/v1/apps', {
      method: 'POST',
      token,
      body: {
        name: '海外社媒高流量交友软广样本库',
        folder_token: cfg.folderToken || undefined,
      },
    });
    cfg.bitableAppToken = createRes.data && createRes.data.app && createRes.data.app.app_token;
  }
  const appToken = cfg.bitableAppToken;
  await tryEnableDefaultBitablePermissions(token, appToken);

  const rawSamples = Array.isArray(samplesOverride) ? samplesOverride : (db.samples || []);
  const sortedSamples = sortSamplesPretty(rawSamples);

  // 先清洗每条样本并探测真实图片附件上传能力
  let uploadedCoverCount = 0;
  for (const s of sortedSamples) {
    s.title = cleanReadableTitle(s.title || '', { fallbackText: s.fullText, authorHandle: s.authorHandle, platform: s.platform });
    s.fullText = decodeHtmlEntities(s.fullText || '').trim() || s.title;
    if (!['video', 'image', 'text'].includes(s.mediaType)) {
      s.mediaType = s.platform === 'x' || s.platform === 'threads' ? 'text' : 'video';
    }
    const ft = await uploadCoverForBitable(token, appToken, s);
    if (ft) uploadedCoverCount++;
  }

  const enableAttachment = uploadedCoverCount > 0 || bitableAttachmentSupportMap.get(appToken) === true;
  const cols = getActiveSyncColumns(db, { includeAttachment: enableAttachment });

  // 1. 查出现有多维表格全部工作表
  const listRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables?page_size=100`, {
    method: 'GET',
    token,
  });
  const existingTables = (listRes.data && listRes.data.items) || [];
  let masterTableId = '';

  if (existingTables.length > 0) {
    // 优先复用已有总表或空默认「数据表」，否则直接原地升级第 1 张表，确保它永远居于最左侧第 1 个 Tab！
    const firstTable =
      existingTables.find((t) => t.name === MASTER_TABLE_NAME) ||
      existingTables.find((t) => t.name === '数据表') ||
      existingTables[0];
    masterTableId = firstTable.table_id;

    // 1a. 重命名为 📊 全部内容总表
    if (firstTable.name !== MASTER_TABLE_NAME) {
      await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}`, {
        method: 'PATCH',
        token,
        body: { name: MASTER_TABLE_NAME },
      });
    }

    // 1b. 删除该表外其余旧表（必须先保留第 1 张表再删其余，避免违反至少留 1 表限制）
    for (const tb of existingTables) {
      if (tb.table_id === masterTableId) continue;
      try {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tb.table_id}`, {
          method: 'DELETE',
          token,
        });
      } catch (_) {}
    }

    // 1c. 清空第 1 张表旧记录
    const recRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/records?page_size=500`, {
      method: 'GET',
      token,
    });
    const oldRecIds = ((recRes.data && recRes.data.items) || []).map((r) => r.record_id).filter(Boolean);
    for (let i = 0; i < oldRecIds.length; i += 400) {
      const chunk = oldRecIds.slice(i, i + 400);
      if (chunk.length === 1) {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/records/${chunk[0]}`, {
          method: 'DELETE',
          token,
        });
      } else if (chunk.length > 1) {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/records/batch_delete`, {
          method: 'POST',
          token,
          body: { records: chunk },
        });
      }
    }

    // 1d. 重塑第 1 张表列结构：先删非主列，再将主列改名为 📌 作品标题，再按新顺序建立全部富组件列
    const fRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/fields?page_size=100`, {
      method: 'GET',
      token,
    });
    const curFields = (fRes.data && fRes.data.items) || [];
    const primaryField = curFields.find((f) => f.is_primary) || curFields[0];
    for (const f of curFields) {
      if (primaryField && f.field_id === primaryField.field_id) continue;
      try {
        await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/fields/${f.field_id}`, {
          method: 'DELETE',
          token,
        });
      } catch (_) {}
    }
    if (primaryField && primaryField.field_name !== cols[0].label) {
      await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/fields/${primaryField.field_id}`, {
        method: 'PUT',
        token,
        body: { field_name: cols[0].label, type: 1 },
      });
    }
    // 查询清理后的剩余字段名
    const fResAfter = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/fields?page_size=100`, {
      method: 'GET',
      token,
    });
    const remainNames = new Set(((fResAfter.data && fResAfter.data.items) || []).map((f) => f.field_name));
    for (let i = 1; i < cols.length; i++) {
      if (!remainNames.has(cols[i].label)) {
        await createBitableFieldSafe(token, appToken, masterTableId, cols[i]);
      }
    }
    try {
      const oldViewsRes = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/views?page_size=50`, {
        method: 'GET',
        token,
      });
      const oldViews = (oldViewsRes.data && oldViewsRes.data.items) || [];
      const keepGrid = oldViews.find((v) => v.view_type === 'grid') || oldViews[0];
      for (const v of oldViews) {
        if (!v.view_id || (keepGrid && v.view_id === keepGrid.view_id)) continue;
        try {
          await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${masterTableId}/views/${v.view_id}`, {
            method: 'DELETE',
            token,
          });
        } catch (_) {}
      }
    } catch (_) {}
    await ensureTablePrettyViews(token, appToken, masterTableId, { isMaster: true });
  } else {
    masterTableId = await ensureBitableTableWithFields(token, appToken, MASTER_TABLE_NAME, cols, {}, 'master', { isMaster: true });
  }

  // 2. 重建缓存映射与全部今日分表 + 5 平台图标分表
  const newTableMap = { master: masterTableId };
  const todayStr = getLocalTodayStr();
  const dateTableName = `📅 今日新增 ${todayStr}`;
  const dateTableId = await ensureBitableTableWithFields(token, appToken, dateTableName, cols, newTableMap, `date:${todayStr}`, { isMaster: false });

  const tabsMeta = getSplitTabs(cfg.splitBy, 'bitable');
  for (const tm of tabsMeta) {
    await ensureBitableTableWithFields(token, appToken, tm.title, cols, newTableMap, tm.key, { isMaster: false });
  }

  // 3. 批量按 Laya 优先顺序写入全部记录
  const batchWriteTable = async (tableId, list) => {
    if (!tableId || !list.length) return 0;
    const recordsPayload = list.map((s) => ({ fields: buildBitableRecordFields(s, cols) }));
    let written = 0;
    for (let i = 0; i < recordsPayload.length; i += 400) {
      const chunk = recordsPayload.slice(i, i + 400);
      try {
        const res = await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
          method: 'POST',
          token,
          body: { records: chunk },
        });
        written += ((res.data && res.data.records) || chunk).length;
      } catch (_) {
        for (const rec of chunk) {
          try {
            await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
              method: 'POST',
              token,
              body: { fields: rec.fields },
            });
            written++;
          } catch (_e) {
            if (rec.fields && rec.fields['🖼️ 画面封面']) {
              try {
                const fallbackFields = { ...rec.fields };
                delete fallbackFields['🖼️ 画面封面'];
                await feishuRequest(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
                  method: 'POST',
                  token,
                  body: { fields: fallbackFields },
                });
                written++;
              } catch (_e2) {}
            }
          }
        }
      }
    }
    return written;
  };

  const masterWritten = await batchWriteTable(masterTableId, sortedSamples);
  const dateWritten = cfg.dailyDateTab !== false ? await batchWriteTable(dateTableId, sortedSamples) : 0;

  const perTabCounts = {};
  for (const tm of tabsMeta) {
    const tid = newTableMap[tm.key];
    const sub = sortedSamples.filter((s) => getSampleTabKey(s, cfg.splitBy) === tm.key);
    perTabCounts[tm.title] = await batchWriteTable(tid, sub);
  }

  cfg.bitableTables = newTableMap;
  cfg.masterTab = true;
  cfg.lastSyncAt = new Date().toISOString();
  cfg.lastSyncStatus = `已美化重整（总表 ${masterWritten} 条 · ${enableAttachment ? '含高清封面' : '无封面列'}）`;
  cfg.consecutiveFailures = 0;

  for (const s of sortedSamples) {
    s.feishuSynced = true;
    s.feishuSyncedAt = cfg.lastSyncAt;
    delete s._feishuCoverToken;
  }
  db.feishuQueue = [];

  store.addOpLog({
    module: '飞书同步',
    action: '飞书多维表格高颜值重构与总表同步',
    status: 'success',
    detail: `已重建「${MASTER_TABLE_NAME}」(${masterWritten}条) +「${dateTableName}」(${dateWritten}条) + ${tabsMeta.length}个平台分表`,
  });
  store.save(true);

  return {
    appToken,
    enableAttachment,
    uploadedCoverCount,
    masterTableId,
    dateTableId,
    tables: newTableMap,
    masterWritten,
    dateWritten,
    perTabCounts,
    columnLabels: cols.map((c) => c.label),
  };
}

/**
 * 确保电子表格（单日/周度/月度 3个总表 × 5个工作表）全部创建就绪并写入表头
 */
async function ensureSpreadsheetsReady(token) {
  const db = store.getDb();
  const cfg = db.settings.feishu;
  const tabs = getSplitTabs(cfg.splitBy, 'spreadsheet');
  const cols = getActiveSyncColumns(db, { includeAttachment: false });
  const endColLetter = colIndexToLetter(Math.max(0, cols.length - 1));

  const workbookKeys = ['daily', 'weekly', 'monthly'];
  for (const wbKey of workbookKeys) {
    const wb = cfg.workbooks[wbKey];
    if (!wb.token) {
      const createBody = { title: wb.title };
      if (cfg.folderToken) createBody.folder_token = cfg.folderToken;
      const created = await feishuRequest('/sheets/v3/spreadsheets', {
        method: 'POST',
        token,
        body: createBody,
      });
      const sp = (created.data && created.data.spreadsheet) || {};
      wb.token = sp.spreadsheet_token;
      wb.url = sp.url || `https://feishu.cn/sheets/${sp.spreadsheet_token}`;
      wb.sheets = {};
    }

    const metaRes = await feishuRequest(`/sheets/v3/spreadsheets/${wb.token}/sheets/query`, {
      method: 'GET',
      token,
    });
    const existingSheets = (metaRes.data && metaRes.data.sheets) || [];
    const titleToSheetId = {};
    existingSheets.forEach((s) => {
      titleToSheetId[s.title] = s.sheet_id;
    });

    const addRequests = [];
    for (const tab of tabs) {
      if (titleToSheetId[tab.title]) {
        wb.sheets[tab.key] = titleToSheetId[tab.title];
      } else {
        addRequests.push({
          addSheet: {
            properties: {
              title: tab.title,
            },
          },
        });
      }
    }

    if (addRequests.length > 0) {
      const batchRes = await feishuRequest(`/sheets/v2/spreadsheets/${wb.token}/sheets_batch_update`, {
        method: 'POST',
        token,
        body: { requests: addRequests },
      });
      const replies = (batchRes.data && batchRes.data.replies) || [];
      replies.forEach((rep) => {
        const p = rep.addSheet && rep.addSheet.properties;
        if (p && p.title && p.sheetId) {
          const matched = tabs.find((t) => t.title === p.title);
          if (matched) wb.sheets[matched.key] = p.sheetId;
        }
      });

      for (const tab of tabs) {
        const sid = wb.sheets[tab.key];
        if (!sid) continue;
        await feishuRequest(`/sheets/v2/spreadsheets/${wb.token}/values`, {
          method: 'PUT',
          token,
          body: {
            valueRange: {
              range: `${sid}!A1:${endColLetter}1`,
              values: [cols.map((c) => c.label)],
            },
          },
        });
        try {
          await feishuRequest(`/sheets/v2/spreadsheets/${wb.token}/style`, {
            method: 'PUT',
            token,
            body: {
              appendStyle: {
                range: `${sid}!A1:${endColLetter}1`,
                style: {
                  font: { bold: true, size: '11pt' },
                  backColor: '#eef2ff',
                },
              },
            },
          });
        } catch (_) {}
      }
    }
  }
  store.save();
  return cfg.workbooks;
}

/**
 * 向单张飞书电子表格工作表追加一行样本，并自动设置【高赞>1万标绿 / 高难度标红】条件高亮
 */
async function appendRowToSpreadsheet(token, spreadsheetToken, sheetId, sample, cols, thresholds) {
  const endColLetter = colIndexToLetter(Math.max(0, cols.length - 1));
  const rowValues = cols.map((c) => formatSampleFieldValue(sample, c.key, true));

  const appendRes = await feishuRequest(
    `/sheets/v2/spreadsheets/${spreadsheetToken}/values_append?insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      token,
      body: {
        valueRange: {
          range: `${sheetId}!A1:${endColLetter}1`,
          values: [rowValues],
        },
      },
    }
  );

  const updatedRange =
    (appendRes.data && appendRes.data.tableRange) ||
    (appendRes.data && appendRes.data.updates && appendRes.data.updates.updatedRange) ||
    '';
  const rowMatch = updatedRange.match(/![A-Z]+(\d+):/i);
  const rowNum = rowMatch ? Number(rowMatch[1]) : 0;

  if (rowNum > 0) {
    const greenLikeThreshold = Number(thresholds.highLikeGreenThreshold || 10000);
    const redDiffStar = Number(thresholds.highDifficultyRedStar || 4);
    const styleTasks = [];

    const likeColIdx = cols.findIndex((c) => c.key === 'likes');
    if (likeColIdx >= 0 && Number(sample.likes || 0) >= greenLikeThreshold) {
      const colLet = colIndexToLetter(likeColIdx);
      styleTasks.push({
        range: `${sheetId}!A${rowNum}:${endColLetter}${rowNum}`,
        style: { backColor: '#e6ffed' },
      });
      styleTasks.push({
        range: `${sheetId}!${colLet}${rowNum}:${colLet}${rowNum}`,
        style: { backColor: '#b7eb8f', foreColor: '#135200', font: { bold: true } },
      });
    }

    const diffColIdx = cols.findIndex((c) => c.key === 'implantDifficulty');
    if (diffColIdx >= 0 && Number(sample.implantDifficulty || 0) >= redDiffStar) {
      const colLet = colIndexToLetter(diffColIdx);
      styleTasks.push({
        range: `${sheetId}!${colLet}${rowNum}:${colLet}${rowNum}`,
        style: { backColor: '#ffa39e', foreColor: '#a8071a', font: { bold: true } },
      });
    }

    for (const st of styleTasks) {
      try {
        await feishuRequest(`/sheets/v2/spreadsheets/${spreadsheetToken}/style`, {
          method: 'PUT',
          token,
          body: { appendStyle: st },
        });
      } catch (_) {}
    }
  }
}

/**
 * 一键初始化多维表格下【📊 全部内容总表 + 📅 今日新增表 + 5 平台图标分表】
 */
async function ensureBitableReady(token) {
  const db = store.getDb();
  const cfg = db.settings.feishu;
  const allowAtt = cfg.bitableAppToken ? bitableAttachmentSupportMap.get(cfg.bitableAppToken) === true : false;
  const cols = getActiveSyncColumns(db, { includeAttachment: allowAtt });

  if (!cfg.bitableAppToken) {
    const createRes = await feishuRequest('/bitable/v1/apps', {
      method: 'POST',
      token,
      body: {
        name: '海外社媒高流量交友软广样本库',
        folder_token: cfg.folderToken || undefined,
      },
    });
    cfg.bitableAppToken = createRes.data && createRes.data.app && createRes.data.app.app_token;
  }

  if (!cfg.bitableTables) cfg.bitableTables = {};
  if (cfg.masterTab !== false) {
    await ensureBitableTableWithFields(token, cfg.bitableAppToken, MASTER_TABLE_NAME, cols, cfg.bitableTables, 'master', { isMaster: true });
  }
  if (cfg.dailyDateTab !== false) {
    const todayStr = getLocalTodayStr();
    await ensureBitableTableWithFields(token, cfg.bitableAppToken, `📅 今日新增 ${todayStr}`, cols, cfg.bitableTables, `date:${todayStr}`, { isMaster: false });
  }
  for (const tabMeta of getSplitTabs(cfg.splitBy, 'bitable')) {
    await ensureBitableTableWithFields(token, cfg.bitableAppToken, tabMeta.title, cols, cfg.bitableTables, tabMeta.key, { isMaster: false });
  }
  store.save();
  return cfg.bitableTables;
}

/**
 * 多维表格（Bitable）写入通道（同时幂等写入 全部内容总表 + 今日新增表 + 所属平台分表）
 */
async function syncSampleToBitable(token, sample, colsInput) {
  const db = store.getDb();
  const cfg = db.settings.feishu;

  if (!cfg.bitableAppToken) {
    const createRes = await feishuRequest('/bitable/v1/apps', {
      method: 'POST',
      token,
      body: {
        name: '海外社媒高流量交友软广样本库',
        folder_token: cfg.folderToken || undefined,
      },
    });
    cfg.bitableAppToken = createRes.data && createRes.data.app && createRes.data.app.app_token;
  }

  if (!cfg.bitableTables) cfg.bitableTables = {};
  const ft = await uploadCoverForBitable(token, cfg.bitableAppToken, sample);
  const allowAtt = Boolean(ft) || bitableAttachmentSupportMap.get(cfg.bitableAppToken) === true;
  const cols = colsInput && allowAtt ? colsInput : getActiveSyncColumns(db, { includeAttachment: allowAtt });

  // 1. 写入/更新总表 📊 全部内容总表
  if (cfg.masterTab !== false) {
    const masterTableId = await ensureBitableTableWithFields(
      token,
      cfg.bitableAppToken,
      MASTER_TABLE_NAME,
      cols,
      cfg.bitableTables,
      'master',
      { isMaster: true }
    );
    await upsertBitableRecord(token, cfg.bitableAppToken, masterTableId, sample, cols);
  }

  // 2. 开启按天分表时，写入今日新增子表
  if (cfg.dailyDateTab !== false) {
    const todayStr = getLocalTodayStr();
    const dateTableId = await ensureBitableTableWithFields(
      token,
      cfg.bitableAppToken,
      `📅 今日新增 ${todayStr}`,
      cols,
      cfg.bitableTables,
      `date:${todayStr}`,
      { isMaster: false }
    );
    await upsertBitableRecord(token, cfg.bitableAppToken, dateTableId, sample, cols);
  }

  // 3. 写入对应平台 / 内容类型分表
  const tabKey = getSampleTabKey(sample, cfg.splitBy);
  const tabMeta = getSplitTabs(cfg.splitBy, 'bitable').find((t) => t.key === tabKey) || { key: tabKey, title: tabKey };
  const tabTableId = await ensureBitableTableWithFields(
    token,
    cfg.bitableAppToken,
    tabMeta.title,
    cols,
    cfg.bitableTables,
    tabKey,
    { isMaster: false }
  );
  await upsertBitableRecord(token, cfg.bitableAppToken, tabTableId, sample, cols);

  delete sample._feishuCoverToken;
  store.save();
}

function parseFeishuTargetUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return null;
  const sheetsMatch = url.match(/\/sheets\/([a-zA-Z0-9_-]+)/i);
  if (sheetsMatch) {
    return { mode: 'spreadsheet', token: sheetsMatch[1] };
  }
  const baseMatch = url.match(/\/base\/([a-zA-Z0-9_-]+)/i);
  if (baseMatch) {
    return { mode: 'bitable', token: baseMatch[1] };
  }
  return null;
}

async function ensureDailyDateTabReady(token, dailyWb, dateStr, cols) {
  if (!dailyWb || !dailyWb.token) return '';
  if (!dailyWb.dateSheets) dailyWb.dateSheets = {};
  if (dailyWb.dateSheets[dateStr]) return dailyWb.dateSheets[dateStr];

  const metaRes = await feishuRequest(`/sheets/v3/spreadsheets/${dailyWb.token}/sheets/query`, {
    method: 'GET',
    token,
  });
  const existing = (metaRes.data && metaRes.data.sheets) || [];
  const found = existing.find((s) => s.title === dateStr);
  if (found && found.sheet_id) {
    dailyWb.dateSheets[dateStr] = found.sheet_id;
    return found.sheet_id;
  }

  const batchRes = await feishuRequest(`/sheets/v2/spreadsheets/${dailyWb.token}/sheets_batch_update`, {
    method: 'POST',
    token,
    body: { requests: [{ addSheet: { properties: { title: dateStr } } }] },
  });
  const rep = batchRes.data && batchRes.data.replies && batchRes.data.replies[0];
  const newSheetId = rep && rep.addSheet && rep.addSheet.properties && rep.addSheet.properties.sheetId;
  if (!newSheetId) return '';

  dailyWb.dateSheets[dateStr] = newSheetId;
  const endColLetter = colIndexToLetter(Math.max(0, cols.length - 1));
  await feishuRequest(`/sheets/v2/spreadsheets/${dailyWb.token}/values`, {
    method: 'PUT',
    token,
    body: {
      valueRange: {
        range: `${newSheetId}!A1:${endColLetter}1`,
        values: [cols.map((c) => c.label)],
      },
    },
  });
  try {
    await feishuRequest(`/sheets/v2/spreadsheets/${dailyWb.token}/style`, {
      method: 'PUT',
      token,
      body: {
        appendStyle: {
          range: `${newSheetId}!A1:${endColLetter}1`,
          style: { font: { bold: true, size: '11pt' }, backColor: '#dcfce7' },
        },
      },
    });
  } catch (_) {}
  return newSheetId;
}

async function pushSampleToRealtimeWebhook(webhookUrl, sample, todayCount = 1) {
  const g = sample.implantGuide || {};
  const payload = {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: `🎬 [${getLocalTodayStr()} 第${todayCount}条好视频] ${(sample.platform || '').toUpperCase()} · ${sample.qualityScore}分`,
          content: [
            [{ tag: 'text', text: `📌 标题：${sample.title || ''}\n` }],
            [{ tag: 'text', text: `👍 点赞 ${sample.likes || 0} | ▶ 播放 ${sample.plays || 0} | 类型：${sample.contentType || ''}\n` }],
            [{ tag: 'text', text: `⏱️ 怎么改：${g.exactTiming || ''}\n✍️ 话术：${g.copyScript || ''}\n` }],
            [{ tag: 'a', text: '🔗 点击直接打开原视频', href: sample.videoUrl || 'https://github.com' }],
          ],
        },
      },
    },
    date: getLocalTodayStr(),
    todayCount,
    platform: sample.platform,
    title: sample.title,
    videoUrl: sample.videoUrl,
    fullText: sample.fullText,
    plays: Number(sample.plays || 0),
    likes: Number(sample.likes || 0),
    comments: Number(sample.comments || 0),
    qualityScore: Number(sample.qualityScore || 0),
    contentType: sample.contentType || '',
    implantTiming: g.exactTiming || '',
    copyScript: g.copyScript || '',
  };

  const resp = await proxyPool.requestRaw(
    webhookUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      timeoutMs: 12000,
    },
    null
  );
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`飞书实时 Webhook 返回 HTTP ${resp.statusCode}`);
  }
}

async function writeSampleToFeishuNow(sample) {
  const db = store.getDb();
  const cfg = db.settings.feishu;
  const cols = getActiveSyncColumns(db, { includeAttachment: false });
  const thresholds = db.settings.thresholds || {};
  const hasAppCreds = Boolean(cfg.authorized || ((cfg.appId || process.env.FEISHU_APP_ID) && (cfg.appSecret || process.env.FEISHU_APP_SECRET)));
  const todayStr = getLocalTodayStr();
  const todayCount = (db.samples || []).filter((s) => String(s.collectedAt || '').startsWith(todayStr) || s.feishuSynced).length;

  let wroteAny = false;

  if (cfg.realtimeWebhookUrl) {
    await pushSampleToRealtimeWebhook(cfg.realtimeWebhookUrl, sample, Math.max(1, todayCount));
    wroteAny = true;
  }

  if (hasAppCreds) {
    const token = await ensureValidAccessToken();
    if (cfg.targetMode === 'bitable') {
      await syncSampleToBitable(token, sample, null);
    } else {
      const workbooks = await ensureSpreadsheetsReady(token);
      const tabKey = getSampleTabKey(sample, cfg.splitBy);
      if (cfg.dailyDateTab !== false && workbooks.daily && workbooks.daily.token) {
        const dateSheetId = await ensureDailyDateTabReady(token, workbooks.daily, todayStr, cols);
        if (dateSheetId) {
          await appendRowToSpreadsheet(token, workbooks.daily.token, dateSheetId, sample, cols, thresholds);
        }
      }
      for (const wbKey of ['daily', 'weekly', 'monthly']) {
        const wb = workbooks[wbKey];
        const sheetId = wb.sheets && wb.sheets[tabKey];
        if (wb.token && sheetId) {
          await appendRowToSpreadsheet(token, wb.token, sheetId, sample, cols, thresholds);
        }
      }
    }
    wroteAny = true;
  }

  if (!wroteAny) {
    throw new Error('飞书尚未授权或配置实时 Webhook');
  }

  sample.feishuSynced = true;
  sample.feishuSyncedAt = new Date().toISOString();
  cfg.lastSyncAt = sample.feishuSyncedAt;
  cfg.lastSyncStatus = `实时同步正常 (${todayStr})`;
  cfg.consecutiveFailures = 0;
  store.save();
}

function enqueueSampleForFeishu(sampleId) {
  const db = store.getDb();
  if (!sampleId) return;
  const exists = db.feishuQueue.find((q) => q.sampleId === sampleId && q.status !== 'synced');
  if (exists) return;

  db.feishuQueue.push({
    id: uid('fsq'),
    sampleId,
    attempts: 0,
    maxAttempts: 3,
    nextRetryAt: Date.now(),
    status: 'pending',
    lastError: '',
    createdAt: new Date().toISOString(),
  });
  store.save();
}

let queueProcessing = false;
async function processFeishuQueue({ forceAll = false, operator = '实时同步守护' } = {}) {
  if (queueProcessing) return { synced: 0, failed: 0, skipped: true };
  const db = store.getDb();
  const cfg = db.settings.feishu || {};

  const hasCredentials = Boolean(
    cfg.authorized ||
      cfg.realtimeWebhookUrl ||
      ((cfg.appId || process.env.FEISHU_APP_ID) && (cfg.appSecret || process.env.FEISHU_APP_SECRET))
  );
  if (!hasCredentials) {
    return { synced: 0, failed: 0, reason: '尚未绑定飞书账号，样本已安全暂存在待同步队列' };
  }

  queueProcessing = true;
  let synced = 0;
  let failed = 0;
  const now = Date.now();

  try {
    const dueItems = db.feishuQueue.filter((item) => {
      if (item.status === 'synced') return false;
      if (forceAll) return true;
      if (item.status === 'failed_exhausted') return false;
      return (item.nextRetryAt || 0) <= now;
    });

    for (const qItem of dueItems) {
      const sample = db.samples.find((s) => s.id === qItem.sampleId);
      if (!sample) {
        qItem.status = 'synced';
        continue;
      }

      try {
        await writeSampleToFeishuNow(sample);
        qItem.status = 'synced';
        qItem.lastError = '';
        synced++;
      } catch (err) {
        qItem.attempts = (qItem.attempts || 0) + 1;
        qItem.lastError = err.message || '飞书接口写入异常';
        cfg.consecutiveFailures = (cfg.consecutiveFailures || 0) + 1;

        if (qItem.attempts >= 3) {
          qItem.status = 'failed_exhausted';
          failed++;
          cfg.lastSyncStatus = `同步异常：${qItem.lastError}`;
          store.addOpLog({
            module: '飞书同步',
            action: '自动重试3次后仍失败',
            operator,
            status: 'error',
            detail: `样本「${(sample.title || '').slice(0, 26)}」已保留在待补推队列，零数据丢失`,
            errorReason: qItem.lastError,
          });
          await store.raiseAlert({
            type: 'feishu_sync_fail',
            level: 'critical',
            title: '飞书实时同步连续重试 3 次失败',
            message: `错误原因：${qItem.lastError}。未同步样本已安全保留在本地队列，恢复授权或网络后可一键补推。`,
          });
        } else {
          qItem.status = 'retrying';
          const backoffMs = qItem.attempts === 1 ? 3000 : 8000;
          qItem.nextRetryAt = Date.now() + backoffMs;
        }
      }
    }

    db.feishuQueue = db.feishuQueue.filter((q) => q.status !== 'synced');
    if (synced > 0) {
      store.addOpLog({
        module: '飞书同步',
        action: '批量写入飞书表格',
        operator,
        status: 'success',
        detail: `成功同步 ${synced} 条合格样本至飞书总表及分表`,
      });
    }
    store.save();
    return { synced, failed, remaining: db.feishuQueue.length };
  } finally {
    queueProcessing = false;
  }
}

async function archivePeriodSnapshot(periodType = 'daily', archiveLabel = '', operator = '自动归档任务') {
  const db = store.getDb();
  const cfg = db.settings.feishu || {};
  const cols = getActiveSyncColumns(db, { includeAttachment: false });
  const thresholds = db.settings.thresholds || {};
  const endColLetter = colIndexToLetter(Math.max(0, cols.length - 1));

  const now = new Date();
  let label = archiveLabel;
  let filterStartMs = 0;
  let filterEndMs = now.getTime();

  if (periodType === 'daily') {
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    const yStr = y.toISOString().slice(0, 10);
    label = label || `日归档_${yStr}`;
    filterStartMs = new Date(`${yStr}T00:00:00`).getTime();
    filterEndMs = filterStartMs + 24 * 3600 * 1000;
  } else if (periodType === 'weekly') {
    label = label || `周归档_${now.toISOString().slice(0, 10)}`;
    filterStartMs = now.getTime() - 7 * 24 * 3600 * 1000;
  } else {
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const ym = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
    label = label || `月归档_${ym}`;
    filterStartMs = prevMonth.getTime();
  }

  const periodSamples = db.samples.filter((s) => {
    const ts = new Date(s.collectedAt || s.publishedAt || 0).getTime();
    return ts >= filterStartMs && ts <= filterEndMs;
  });

  const hasCredentials = Boolean(cfg.authorized || ((cfg.appId || process.env.FEISHU_APP_ID) && (cfg.appSecret || process.env.FEISHU_APP_SECRET)));
  let remoteSheetUrl = '';

  if (hasCredentials && cfg.targetMode === 'spreadsheet') {
    const token = await ensureValidAccessToken();
    const workbooks = await ensureSpreadsheetsReady(token);
    const wb = workbooks[periodType] || workbooks.daily;

    const addRes = await feishuRequest(`/sheets/v2/spreadsheets/${wb.token}/sheets_batch_update`, {
      method: 'POST',
      token,
      body: {
        requests: [
          {
            addSheet: {
              properties: { title: label.slice(0, 28) },
            },
          },
        ],
      },
    });
    const newSheetId =
      addRes.data &&
      addRes.data.replies &&
      addRes.data.replies[0] &&
      addRes.data.replies[0].addSheet &&
      addRes.data.replies[0].addSheet.properties &&
      addRes.data.replies[0].addSheet.properties.sheetId;

    if (newSheetId) {
      await feishuRequest(`/sheets/v2/spreadsheets/${wb.token}/values`, {
        method: 'PUT',
        token,
        body: {
          valueRange: {
            range: `${newSheetId}!A1:${endColLetter}1`,
            values: [cols.map((c) => c.label)],
          },
        },
      });
      for (const s of periodSamples) {
        await appendRowToSpreadsheet(token, wb.token, newSheetId, s, cols, thresholds);
      }
      remoteSheetUrl = `${wb.url}?sheet=${newSheetId}`;
    }
  }

  if (periodType === 'daily') cfg.lastArchiveDailyDate = new Date().toISOString().slice(0, 10);
  if (periodType === 'weekly') cfg.lastArchiveWeeklyKey = label;
  if (periodType === 'monthly') cfg.lastArchiveMonthlyKey = label;

  store.addOpLog({
    module: '飞书归档',
    action: `执行${periodType === 'daily' ? '单日' : periodType === 'weekly' ? '周度' : '月度'}自动分表归档`,
    operator,
    status: 'success',
    detail: `归档子表「${label}」，归档样本数 ${periodSamples.length} 条${remoteSheetUrl ? '（已写入飞书云端）' : '（本地归档快照已完成）'}`,
  });
  store.save();

  return { periodType, label, archivedCount: periodSamples.length, remoteSheetUrl };
}

module.exports = {
  MASTER_TABLE_NAME,
  parseFeishuTargetUrl,
  buildOAuthAuthorizeUrl,
  handleOAuthCallback,
  ensureValidAccessToken,
  feishuRequest,
  getLocalTodayStr,
  ensureSpreadsheetsReady,
  ensureBitableReady,
  rebuildPrettyBitableAll,
  upgradeSyncFieldsToPretty,
  sortSamplesPretty,
  writeSampleToFeishuNow,
  enqueueSampleForFeishu,
  processFeishuQueue,
  archivePeriodSnapshot,
  getActiveSyncColumns,
  formatSampleFieldValue,
};
