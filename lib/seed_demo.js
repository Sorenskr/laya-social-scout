'use strict';
/**
 * 首次启动初始化展示样本（覆盖 IG / FB / X / Threads 四平台合格软广 + 垃圾库一票否决拦截对照样本）
 * 运营在正式投产前可在【系统设置】一键清空演示数据。
 */
const store = require('./store');
const crawlerEngine = require('./crawler_engine');

async function ensureInitialSeedIfEmpty() {
  const db = store.getDb();
  if (db.seededOnce || db.samples.length > 0) return;
  db.seededOnce = true;

  try {
    await crawlerEngine.runCrawlTask({
      platforms: ['instagram', 'facebook', 'x', 'threads'],
      buckets: ['brand', 'competitor', 'generic'],
      maxTotalCandidates: 11,
      modeOverride: 'sandbox',
      fastTest: true,
      operator: '系统首次启动初始化',
    });
  } catch (_) {
    // 忽略初始化异常
  }
  store.save(true);
}

module.exports = { ensureInitialSeedIfEmpty };
