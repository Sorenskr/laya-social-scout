'use strict';
/**
 * 持久化数据存储与日志告警中心（零外部强依赖）
 * · 本地/CloudBase容器：读写 data/db.json，自动维护滚动备份
 * · Vercel Serverless：检测到 BLOB_READ_WRITE_TOKEN 时自动同步至 @vercel/blob
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createDefaultDb, uid } = require('./defaults');
const githubSync = require('./github_sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const BLOB_PATH = 'laya-social-scout/db.json';
const BLOB_PREFIX = 'laya-social-scout/';

let db = null;
let saveTimer = null;
let initialized = false;

function ensureDirs() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (_) {
    // Vercel Serverless 只读目录时自动忽略，走内存/Blob
  }
}

function mergeDeep(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (Array.isArray(sv)) {
      target[key] = sv;
    } else if (sv && typeof sv === 'object' && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      mergeDeep(tv, sv);
    } else if (sv !== undefined) {
      target[key] = sv;
    }
  }
  return target;
}

function loadLocal() {
  if (db) return db;
  ensureDirs();
  const base = createDefaultDb();
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = mergeDeep(base, parsed);
      // 平滑升级兼容：老版 db.json 无防封浏览器字段时，如未填外部付费 Key 则默认切到 0 费用本地引擎与防封浏览器通道
      if (!parsed.settings || !parsed.settings.fingerprintBrowser) {
        if (db.settings && db.settings.visionLlm && !db.settings.visionLlm.apiKey) {
          db.settings.visionLlm.provider = 'local_free';
        }
        if (db.settings && db.settings.collectorMode === 'hybrid') {
          db.settings.collectorMode = 'fingerprint';
        }
        flushSync();
      }
      if (db.settings && db.settings.visionLlm && db.settings.visionLlm.model === 'gemini-2.5-flash') {
        db.settings.visionLlm.model = 'gemini-3.8-flash';
        flushSync();
      }
    } else {
      db = base;
      flushSync();
    }
  } catch (err) {
    console.warn('[store] 读取本地 db.json 失败，使用默认结构:', err.message);
    db = base;
  }
  return db;
}

async function pullBlobIfConfigured() {
  if (!BLOB_TOKEN) return;
  try {
    const { list } = require('@vercel/blob');
    const res = await list({ prefix: BLOB_PREFIX, limit: 10, token: BLOB_TOKEN });
    const blobs = (res && res.blobs) || [];
    blobs.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));
    if (!blobs.length) return;
    const resp = await fetch(blobs[0].url);
    if (!resp.ok) return;
    const remoteData = await resp.json();
    if (remoteData && remoteData.version) {
      db = mergeDeep(createDefaultDb(), remoteData);
    }
  } catch (err) {
    console.warn('[store] Vercel Blob 拉取跳过:', err.message);
  }
}

async function pushBlobIfConfigured() {
  if (!BLOB_TOKEN || !db) return;
  try {
    const { put } = require('@vercel/blob');
    await put(BLOB_PATH, JSON.stringify(db), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
      token: BLOB_TOKEN,
    });
  } catch (err) {
    console.warn('[store] Vercel Blob 写入失败:', err.message);
  }
}

function flushSync() {
  if (!db) return;
  db.updatedAt = new Date().toISOString();
  try {
    ensureDirs();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (_) {
    // 只读环境忽略本地文件落盘
  }
  githubSync.writePublicFeedSnapshot(db);
}

function save(immediate = false) {
  if (!db) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (immediate) {
    flushSync();
    pushBlobIfConfigured();
    return;
  }
  saveTimer = setTimeout(() => {
    flushSync();
    pushBlobIfConfigured();
  }, 350);
}

function createBackupSnapshot(reason = 'auto') {
  if (!db) return null;
  try {
    ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `db-${stamp}-${reason}.json`);
    fs.writeFileSync(file, JSON.stringify(db), 'utf8');
    // 最多保留最近 12 份快照
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.json'))
      .sort();
    while (files.length > 12) {
      const old = files.shift();
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
    return file;
  } catch (_) {
    return null;
  }
}

async function init() {
  if (initialized && db) return db;
  loadLocal();
  await pullBlobIfConfigured();
  initialized = true;
  return db;
}

function getDb() {
  return db || loadLocal();
}

/**
 * 全操作留痕日志（采集、过滤、同步、配置修改、拉黑、恢复）
 */
function addOpLog({ module = '系统', action = '', operator, status = 'success', detail = '', errorReason = '' }) {
  const state = getDb();
  const entry = {
    id: uid('log'),
    time: new Date().toISOString(),
    operator: operator || (state.settings && state.settings.operatorName) || '运营人员',
    module,
    action,
    status, // 'success' | 'warning' | 'error'
    detail,
    errorReason: errorReason || '',
  };
  state.operationLogs.unshift(entry);
  if (state.operationLogs.length > 800) {
    state.operationLogs.length = 800;
  }
  save();
  return entry;
}

/**
 * 限流与换IP换近义词日志
 */
function addRateLimitLog({ platform, proxyLabel, keyword, fallbackKeyword = '', retryCount = 0, reason = '', resolved = false }) {
  const state = getDb();
  const entry = {
    id: uid('rl'),
    time: new Date().toISOString(),
    platform,
    proxyLabel: proxyLabel || '直连/本地网络',
    keyword,
    fallbackKeyword,
    retryCount,
    reason,
    resolved,
  };
  state.rateLimitLogs.unshift(entry);
  if (state.rateLimitLogs.length > 300) {
    state.rateLimitLogs.length = 300;
  }
  save();
  return entry;
}

/**
 * 发送飞书机器人 Webhook 消息通知管理员
 */
function sendFeishuWebhookText(webhookUrl, title, text) {
  if (!webhookUrl || !webhookUrl.startsWith('https://')) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        msg_type: 'interactive',
        card: {
          header: {
            title: { tag: 'plain_text', content: `🚨 ${title}` },
            template: 'red',
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `**告警详情**：${text}\n**触发时间**：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
              },
            },
          ],
        },
      });
      const u = new URL(webhookUrl);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 8000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.write(payload);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * 触发系统级告警（置顶红色横幅 + 可选飞书推送）
 * type: 'platform_zero_2h' | 'feishu_sync_fail' | 'proxy_low_rate' | 'vision_key_missing' | 'rate_limit'
 */
async function raiseAlert({ type, level = 'critical', title, message, platform = '' }) {
  const state = getDb();
  // 15分钟内同类型同平台未解除的告警不重复刷屏，仅更新时间与计数
  const nowMs = Date.now();
  const existing = state.alerts.find(
    (a) => !a.dismissed && a.type === type && a.platform === platform && nowMs - new Date(a.updatedAt || a.createdAt).getTime() < 15 * 60 * 1000
  );
  if (existing) {
    existing.updatedAt = new Date().toISOString();
    existing.message = message;
    existing.count = (existing.count || 1) + 1;
    save();
    return existing;
  }

  const alert = {
    id: uid('alt'),
    type,
    level, // 'critical' | 'warning'
    platform,
    title,
    message,
    count: 1,
    dismissed: false,
    notifiedFeishu: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.alerts.unshift(alert);
  if (state.alerts.length > 200) state.alerts.length = 200;

  const webhook = state.settings && state.settings.feishu && state.settings.feishu.alertWebhookUrl;
  if (webhook && level === 'critical') {
    const ok = await sendFeishuWebhookText(webhook, title, message);
    alert.notifiedFeishu = ok;
  }
  save();
  return alert;
}

function dismissAlert(alertId) {
  const state = getDb();
  if (alertId === 'ALL') {
    state.alerts.forEach((a) => { a.dismissed = true; });
  } else {
    const target = state.alerts.find((a) => a.id === alertId);
    if (target) target.dismissed = true;
  }
  save();
}

module.exports = {
  init,
  getDb,
  save,
  flushSync,
  createBackupSnapshot,
  addOpLog,
  addRateLimitLog,
  raiseAlert,
  dismissAlert,
  sendFeishuWebhookText,
};
