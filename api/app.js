'use strict';
/**
 * Vercel Serverless 统一入口（与现有 anhao 项目架构一致）
 */
const store = require('../lib/store');
const { handler } = require('../main');

let readyPromise = null;

function normalizeVercelUrl(url) {
  if (!url) return '/';
  const qIdx = url.indexOf('?');
  const p = qIdx < 0 ? url : url.slice(0, qIdx);
  const qs = qIdx < 0 ? '' : url.slice(qIdx);
  if (p === '/api/app' || p === '/api/app/' || p === '/api/app.js') {
    return '/' + qs;
  }
  return url;
}

function invoke(req, res) {
  req.url = normalizeVercelUrl(req.url);
  if (!readyPromise) readyPromise = store.init();
  readyPromise
    .then(() => handler(req, res))
    .catch((err) => {
      console.error('[vercel-entry] 执行失败:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: err.message || 'Server error' }));
      }
    });
}

module.exports = invoke;
module.exports.default = invoke;
