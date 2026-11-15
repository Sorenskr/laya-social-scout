'use strict';
/**
 * 模块化平台采集器注册中心
 * 后续扩展 TikTok / 抖音 / 小红书 等新平台时：
 *   只需在 lib/collectors/ 下新建 tiktok.js 并在此处 registerCollector(require('./tiktok'))，
 *   无需重构反爬引擎、视觉审核、飞书分表同步或前端筛选架构。
 */
const collectors = new Map();

function registerCollector(collectorModule) {
  if (!collectorModule || !collectorModule.id || typeof collectorModule.collect !== 'function') {
    throw new Error('采集插件必须提供 id 与 collect() 方法');
  }
  collectors.set(collectorModule.id, collectorModule);
}

function getCollector(platformId) {
  return collectors.get(platformId) || null;
}

function listCollectors() {
  return Array.from(collectors.values());
}

// 注册默认四大海外社媒平台
registerCollector(require('./instagram'));
registerCollector(require('./facebook'));
registerCollector(require('./x'));
registerCollector(require('./threads'));
registerCollector(require('./tiktok'));

module.exports = {
  registerCollector,
  getCollector,
  listCollectors,
};
