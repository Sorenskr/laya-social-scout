'use strict';
/**
 * 本地/容器常驻定时调度器（兼容 Vercel Cron 被动触发接口）
 * 默认：
 *  1. 每日 08:00、17:30 自动触发全量四平台采集
 *  2. 每 20 秒自动检查并推送飞书实时同步队列（确保合格样本 1 分钟内写入飞书）
 *  3. 每日 00:00 归档昨日单日表；每周一 00:05 归档周度表；每月 1 号 00:10 归档月度表
 *  4. 每 15 分钟巡检「平台连续 2 小时无产出」与「代理可用率 < 30%」告警
 */
const store = require('./store');
const crawlerEngine = require('./crawler_engine');
const feishuSync = require('./feishu_sync');
const proxyPool = require('./proxy_pool');

let mainTimer = null;
let syncTimer = null;
const triggeredMinuteKeys = new Set();

function pad2(n) {
  return String(n).padStart(2, '0');
}

async function tickScheduleCheck() {
  const db = store.getDb();
  const sched = db.settings.schedule || {};
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const hm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const minuteKey = `${dateStr}_${hm}`;

  if (triggeredMinuteKeys.has(minuteKey)) return;

  // 1. 定时全量抓取（默认 08:00 与 17:30）
  if (sched.enabled !== false && Array.isArray(sched.dailyTimes) && sched.dailyTimes.includes(hm)) {
    const winStart = sched.activeWindowStart || '00:00';
    const winEnd = sched.activeWindowEnd || '23:59';
    if (hm >= winStart && hm <= winEnd) {
      triggeredMinuteKeys.add(minuteKey);
      crawlerEngine
        .runCrawlTask({
          platforms: ['instagram', 'facebook', 'x', 'threads', 'tiktok'],
          buckets: ['brand', 'competitor', 'generic'],
          maxTotalCandidates: 40,
          fastTest: false,
          operator: `定时任务 (${hm})`,
        })
        .catch((err) => console.error('[scheduler] 定时采集异常:', err.message));
    }
  }

  // 2. 自动分表归档（每日0点、每周一、每月1号）
  if (sched.autoArchiveEnabled !== false) {
    if (hm === '00:00' && db.settings.feishu.lastArchiveDailyDate !== dateStr) {
      triggeredMinuteKeys.add(minuteKey);
      feishuSync.archivePeriodSnapshot('daily', '', '每日0点自动归档').catch(() => {});
    }
    if (now.getDay() === 1 && hm === '00:05') {
      triggeredMinuteKeys.add(minuteKey);
      feishuSync.archivePeriodSnapshot('weekly', '', '每周一自动归档').catch(() => {});
    }
    if (now.getDate() === 1 && hm === '00:10') {
      triggeredMinuteKeys.add(minuteKey);
      feishuSync.archivePeriodSnapshot('monthly', '', '每月1号自动归档').catch(() => {});
    }
  }

  // 清理历史分钟防重键
  if (triggeredMinuteKeys.size > 120) {
    const arr = Array.from(triggeredMinuteKeys);
    arr.slice(0, 60).forEach((k) => triggeredMinuteKeys.delete(k));
  }
}

function startBackgroundLoops() {
  if (mainTimer) return;

  // 每 25 秒检查一次定时采集与归档点
  mainTimer = setInterval(() => {
    tickScheduleCheck().catch(() => {});
    crawlerEngine.checkPlatformZeroYieldAlerts().catch(() => {});
    proxyPool.evaluateProxyPoolHealth(true).catch(() => {});
  }, 25 * 1000);
  if (mainTimer.unref) mainTimer.unref();

  // 每 18 秒消费一次飞书待同步队列，确保每抓到1条新合格样本 1 分钟内自动写入飞书
  syncTimer = setInterval(() => {
    const db = store.getDb();
    if (db.settings.feishu && db.settings.feishu.autoRealtimeSync !== false && db.feishuQueue.length > 0) {
      feishuSync.processFeishuQueue({ operator: '1分钟实时同步守护' }).catch(() => {});
    }
  }, 18 * 1000);
  if (syncTimer.unref) syncTimer.unref();
}

function stopBackgroundLoops() {
  if (mainTimer) clearInterval(mainTimer);
  if (syncTimer) clearInterval(syncTimer);
  mainTimer = null;
  syncTimer = null;
}

module.exports = {
  startBackgroundLoops,
  stopBackgroundLoops,
  tickScheduleCheck,
};
