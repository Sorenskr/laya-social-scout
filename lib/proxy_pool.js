'use strict';
/**
 * 代理 IP 池管理与零依赖 HTTP/HTTPS CONNECT 隧道请求器
 * 支持：
 *  1. 批量导入美区/台湾代理（兼容 ip:port、ip:port:user:pass、http://user:pass@ip:port 等常见格式）
 *  2. 自动连通性测速检测、连续失败自动剔除失效 IP
 *  3. 按平台独立控制单 IP 请求频率，自动轮换最低负载可用 IP
 *  4. 可用率低于阈值（默认 30%）自动触发全局红色告警与飞书通知
 */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { uid } = require('./defaults');
const store = require('./store');

// 内存中记录单 IP 近期请求时间戳： Map<proxyId, number[]>
const ipRequestWindow = new Map();

let cachedSysProxy = null;
let cachedSysProxyAt = 0;

/**
 * 自动读取系统或环境变量配置的外网代理（国内飞书/本机地址自动跳过直连）
 */
function detectSystemOutboundProxy(hostname = '') {
  const h = String(hostname || '').toLowerCase();
  if (
    !h ||
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h.endsWith('.feishu.cn') ||
    h === 'feishu.cn' ||
    h.endsWith('.larkoffice.com')
  ) {
    return null;
  }

  const now = Date.now();
  if (now - cachedSysProxyAt < 30000) return cachedSysProxy;
  cachedSysProxyAt = now;
  cachedSysProxy = null;

  try {
    const envUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    if (envUrl.trim()) {
      const eu = new URL(envUrl.trim().includes('://') ? envUrl.trim() : `http://${envUrl.trim()}`);
      const p = Number(eu.port || (eu.protocol === 'https:' ? 443 : 80));
      if (eu.hostname && p > 0) {
        cachedSysProxy = { host: eu.hostname, port: p };
        return cachedSysProxy;
      }
    }

    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
        timeout: 1500,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) {
        const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        if (m && m[1]) {
          let raw = m[1].trim();
          if (raw.includes('=')) {
            const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
            const httpsPart = parts.find((x) => x.toLowerCase().startsWith('https=')) || parts.find((x) => x.toLowerCase().startsWith('http=')) || parts[0];
            raw = httpsPart ? httpsPart.replace(/^[a-z]+=/i, '') : '';
          }
          raw = raw.replace(/^https?:\/\//i, '').trim();
          const lastColon = raw.lastIndexOf(':');
          if (lastColon > 0) {
            const host = raw.slice(0, lastColon).trim();
            const port = Number(raw.slice(lastColon + 1).trim());
            if (host && port > 0 && port <= 65535) {
              cachedSysProxy = { host, port };
              return cachedSysProxy;
            }
          }
        }
      }
    }
  } catch (_) {
    // 忽略注册表或权限检测异常，静默回退直连
  }
  return cachedSysProxy;
}

function detectRegionTag(line, host) {
  const lower = line.toLowerCase();
  if (lower.includes('tw') || lower.includes('taiwan') || line.includes('台') || line.includes('臺')) return '台湾';
  if (lower.includes('us') || lower.includes('usa') || line.includes('美')) return '美区';
  if (lower.includes('jp') || line.includes('日')) return '日本';
  if (lower.includes('sg') || line.includes('新')) return '新加坡';
  if (lower.includes('hk') || line.includes('港')) return '香港';
  // 默认按常见号段或标记美区
  return host && host.startsWith('103.') ? '台湾' : '美区';
}

/**
 * 解析单行代理字符串
 */
function parseProxyLine(rawLine, defaultRegion = '美区') {
  if (!rawLine || typeof rawLine !== 'string') return null;
  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  let region = defaultRegion || detectRegionTag(line, '');
  const bracketMatch = line.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (bracketMatch) {
    region = bracketMatch[1].trim();
    line = bracketMatch[2].trim();
  } else if (line.includes('|')) {
    const [left, right] = line.split('|').map((s) => s.trim());
    if (right && (left.includes('美') || left.includes('台') || left.length <= 8)) {
      region = left;
      line = right;
    }
  }

  let protocol = 'http';
  let host = '';
  let port = 0;
  let username = '';
  let password = '';

  try {
    if (/^https?:\/\//i.test(line) || /^socks5?:\/\//i.test(line)) {
      const u = new URL(line);
      protocol = u.protocol.replace(':', '').toLowerCase();
      host = u.hostname;
      port = Number(u.port);
      username = decodeURIComponent(u.username || '');
      password = decodeURIComponent(u.password || '');
    } else if (line.includes('@')) {
      const [authPart, hostPart] = line.split('@');
      const [uName, uPass] = authPart.split(':');
      const [h, p] = hostPart.split(':');
      host = h;
      port = Number(p);
      username = uName || '';
      password = uPass || '';
    } else {
      const parts = line.split(':').map((s) => s.trim());
      if (parts.length >= 2) {
        host = parts[0];
        port = Number(parts[1]);
        username = parts[2] || '';
        password = parts.slice(3).join(':') || '';
      }
    }
  } catch (_) {
    return null;
  }

  if (!host || !port || Number.isNaN(port) || port <= 0 || port > 65535) {
    return null;
  }

  return {
    id: uid('pxy'),
    protocol: protocol === 'https' ? 'https' : 'http',
    host,
    port,
    username,
    password,
    region: region || detectRegionTag(rawLine, host),
    status: 'untested', // 'healthy' | 'untested' | 'failed' | 'evicted'
    latencyMs: 0,
    failCount: 0,
    successCount: 0,
    lastUsedAt: '',
    lastCheckedAt: '',
    lastError: '',
    createdAt: new Date().toISOString(),
  };
}

/**
 * 批量导入代理 IP（自动去重 host:port）
 */
function importProxiesBatch(rawText, defaultRegion = '美区', operator) {
  const db = store.getDb();
  const lines = String(rawText || '').split(/\r?\n/);
  let added = 0;
  let skipped = 0;

  for (const line of lines) {
    const parsed = parseProxyLine(line, defaultRegion);
    if (!parsed) {
      if (line.trim()) skipped++;
      continue;
    }
    const exists = db.proxies.find((p) => p.host === parsed.host && p.port === parsed.port);
    if (exists) {
      exists.username = parsed.username || exists.username;
      exists.password = parsed.password || exists.password;
      exists.region = parsed.region || exists.region;
      if (exists.status === 'evicted') {
        exists.status = 'untested';
        exists.failCount = 0;
      }
      skipped++;
    } else {
      db.proxies.push(parsed);
      added++;
    }
  }

  store.addOpLog({
    module: '代理IP池',
    action: '批量导入代理IP',
    operator,
    status: 'success',
    detail: `新增 ${added} 个代理IP，更新/跳过重复或无效行 ${skipped} 条`,
  });
  store.save();
  return { added, skipped, total: db.proxies.length };
}

/**
 * 计算当前代理池统计与可用率，并在低于 30% 时触发告警
 */
async function evaluateProxyPoolHealth(triggerAlert = true) {
  const db = store.getDb();
  const activePool = db.proxies.filter((p) => p.status !== 'evicted');
  const totalConfigured = db.proxies.length;
  if (totalConfigured === 0) {
    return {
      totalConfigured: 0,
      activeCount: 0,
      healthyCount: 0,
      evictedCount: 0,
      availabilityPct: 100, // 未配置代理时不误报失效告警，显示“未配置（直连）”
      configured: false,
    };
  }
  const healthyCount = activePool.filter((p) => p.status === 'healthy' || p.status === 'untested').length;
  const evictedCount = db.proxies.filter((p) => p.status === 'evicted' || p.status === 'failed').length;
  const availabilityPct = Math.round((healthyCount / totalConfigured) * 100);
  const threshold = (db.settings.antiCrawl && db.settings.antiCrawl.proxyAlertThresholdPct) || 30;

  if (triggerAlert && availabilityPct < threshold) {
    await store.raiseAlert({
      type: 'proxy_low_rate',
      level: 'critical',
      title: `代理IP池可用率过低（当前 ${availabilityPct}%）`,
      message: `代理池共 ${totalConfigured} 个IP，仅 ${healthyCount} 个可用，低于 ${threshold}% 安全线，请及时补充美区/台湾代理IP！`,
    });
  }

  return {
    totalConfigured,
    activeCount: activePool.length,
    healthyCount,
    evictedCount,
    availabilityPct,
    configured: true,
  };
}

/**
 * 通过 HTTP CONNECT 隧道或直连发起 HTTP/HTTPS 请求（支持 Buffer 与文本返回、自动重定向）
 */
function requestRaw(targetUrl, options = {}, proxy = null, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 4) {
      return reject(new Error('重定向次数过多'));
    }
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`非法URL: ${targetUrl}`));
    }

    const isHttps = u.protocol === 'https:';
    const method = options.method || 'GET';
    const timeoutMs = options.timeoutMs || 14000;
    const headers = Object.assign(
      {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/json,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      options.headers || {}
    );

    const bodyBuf = options.body
      ? Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body), 'utf8')
      : null;

    if (bodyBuf && !headers['Content-Length']) {
      headers['Content-Length'] = bodyBuf.length;
    }

    const handleResponse = (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, targetUrl).toString();
        return resolve(requestRaw(nextUrl, options, proxy, redirectDepth + 1));
      }
      const chunks = [];
      let totalLen = 0;
      const maxBytes = options.maxBytes || 8 * 1024 * 1024;
      res.on('data', (chunk) => {
        totalLen += chunk.length;
        if (totalLen <= maxBytes) chunks.push(chunk);
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: code,
          headers: res.headers,
          buffer,
          text: () => buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8')),
        });
      });
      res.on('error', reject);
    };

    let usedAutoSysProxy = false;
    if ((!proxy || !proxy.host || !proxy.port) && !options.noSystemProxy) {
      const sysPx = detectSystemOutboundProxy(u.hostname);
      if (sysPx) {
        proxy = sysPx;
        usedAutoSysProxy = true;
      }
    }

    // 无代理：直接请求
    if (!proxy || !proxy.host || !proxy.port) {
      const lib = isHttps ? https : http;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers,
          timeout: timeoutMs,
        },
        handleResponse
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
      return;
    }

    const proxyAuth =
      proxy.username || proxy.password
        ? 'Basic ' + Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64')
        : '';

    // HTTP 目标走普通代理转发
    if (!isHttps) {
      const proxyHeaders = Object.assign({}, headers, { Host: u.host });
      if (proxyAuth) proxyHeaders['Proxy-Authorization'] = proxyAuth;
      const req = http.request(
        {
          hostname: proxy.host,
          port: proxy.port,
          path: u.toString(),
          method,
          headers: proxyHeaders,
          timeout: timeoutMs,
        },
        handleResponse
      );
      let httpFallbackDone = false;
      const tryDirectOrRejectHttp = (err) => {
        if (httpFallbackDone) return;
        httpFallbackDone = true;
        if (usedAutoSysProxy) {
          return resolve(requestRaw(targetUrl, Object.assign({}, options, { noSystemProxy: true }), null, redirectDepth));
        }
        reject(err);
      };
      req.on('error', tryDirectOrRejectHttp);
      req.on('timeout', () => {
        req.destroy();
        tryDirectOrRejectHttp(new Error('代理HTTP请求超时'));
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
      return;
    }

    // HTTPS 目标走 HTTP CONNECT 隧道 + TLS 握手
    const connectHeaders = { Host: `${u.hostname}:${u.port || 443}` };
    if (proxyAuth) connectHeaders['Proxy-Authorization'] = proxyAuth;

    const connectReq = http.request({
      hostname: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${u.hostname}:${u.port || 443}`,
      headers: connectHeaders,
      timeout: timeoutMs,
    });

    let connectFallbackDone = false;
    const tryDirectOrRejectConnect = (err) => {
      if (connectFallbackDone) return;
      connectFallbackDone = true;
      if (usedAutoSysProxy) {
        return resolve(requestRaw(targetUrl, Object.assign({}, options, { noSystemProxy: true }), null, redirectDepth));
      }
      reject(err);
    };

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return tryDirectOrRejectConnect(new Error(`代理隧道握手失败 HTTP ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({
        socket,
        servername: u.hostname,
        rejectUnauthorized: false,
      });
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => tlsSocket;

      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method,
          headers,
          agent,
          timeout: timeoutMs,
        },
        handleResponse
      );
      req.on('error', (err) => {
        tlsSocket.destroy();
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        tlsSocket.destroy();
        reject(new Error('代理TLS请求超时'));
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });

    connectReq.on('error', tryDirectOrRejectConnect);
    connectReq.on('timeout', () => {
      connectReq.destroy();
      tryDirectOrRejectConnect(new Error('代理CONNECT连接超时'));
    });
    connectReq.end();
  });
}

/**
 * 检测单个代理 IP 可用性与延迟
 */
async function checkSingleProxy(proxy) {
  const start = Date.now();
  try {
    // 先尝试轻量 HTTP 204/IP 回显连通测试，退化到 TCP 端口握手验证
    try {
      const resp = await requestRaw('https://www.cloudflare.com/cdn-cgi/trace', { timeoutMs: 7000 }, proxy);
      if (resp.statusCode >= 200 && resp.statusCode < 400) {
        proxy.status = 'healthy';
        proxy.latencyMs = Date.now() - start;
        proxy.failCount = 0;
        proxy.lastError = '';
        proxy.lastCheckedAt = new Date().toISOString();
        return { ok: true, latencyMs: proxy.latencyMs };
      }
    } catch (_) {
      // 若外部网络受限，检测代理 TCP 端口是否存活可连
    }

    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: proxy.host, port: proxy.port, timeout: 4500 }, () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', reject);
      sock.on('timeout', () => {
        sock.destroy();
        reject(new Error('TCP连接超时'));
      });
    });

    proxy.status = 'healthy';
    proxy.latencyMs = Date.now() - start;
    proxy.failCount = 0;
    proxy.lastError = '';
    proxy.lastCheckedAt = new Date().toISOString();
    return { ok: true, latencyMs: proxy.latencyMs };
  } catch (err) {
    proxy.failCount = (proxy.failCount || 0) + 1;
    proxy.lastError = err.message || '连接不可达';
    proxy.lastCheckedAt = new Date().toISOString();
    const db = store.getDb();
    const autoEvict = db.settings.antiCrawl && db.settings.antiCrawl.autoEvictBadProxy !== false;
    if (autoEvict && proxy.failCount >= 2) {
      proxy.status = 'evicted';
    } else {
      proxy.status = 'failed';
    }
    return { ok: false, error: proxy.lastError };
  }
}

/**
 * 批量检测所有未剔除代理 IP
 */
async function checkAllProxies(operator) {
  const db = store.getDb();
  const candidates = db.proxies.filter((p) => p.status !== 'evicted');
  let okCount = 0;
  let failCount = 0;

  // 并发限制 6 个同时测速
  const concurrency = 6;
  for (let i = 0; i < candidates.length; i += concurrency) {
    const slice = candidates.slice(i, i + concurrency);
    const results = await Promise.all(slice.map((p) => checkSingleProxy(p)));
    results.forEach((r) => {
      if (r.ok) okCount++;
      else failCount++;
    });
  }

  store.addOpLog({
    module: '代理IP池',
    action: '全量检测代理IP可用性',
    operator,
    status: failCount > okCount && candidates.length > 0 ? 'warning' : 'success',
    detail: `检测 ${candidates.length} 个代理：可用 ${okCount} 个，异常/已自动剔除 ${failCount} 个`,
  });
  store.save();
  const summary = await evaluateProxyPoolHealth(true);
  return { okCount, failCount, summary };
}

/**
 * 为指定平台挑选最优代理 IP（遵守单 IP 每分钟频率阈值，并自动轮换排除黑名单/刚报错 IP）
 */
function selectProxyForPlatform(platform, excludeProxyIds = []) {
  const db = store.getDb();
  const maxPerMin = (db.settings.antiCrawl && db.settings.antiCrawl.maxReqPerIpPerMin) || 6;
  const now = Date.now();

  const candidates = db.proxies.filter(
    (p) => (p.status === 'healthy' || p.status === 'untested') && !excludeProxyIds.includes(p.id)
  );
  if (!candidates.length) return null;

  // 清理过期时间窗并挑选近 60 秒内请求次数最少且最久未用的 IP
  const scored = candidates
    .map((p) => {
      const hist = (ipRequestWindow.get(p.id) || []).filter((ts) => now - ts < 60 * 1000);
      ipRequestWindow.set(p.id, hist);
      return { proxy: p, recentCount: hist.length, lastUsedMs: p.lastUsedAt ? new Date(p.lastUsedAt).getTime() : 0 };
    })
    .filter((item) => item.recentCount < maxPerMin)
    .sort((a, b) => a.recentCount - b.recentCount || a.lastUsedMs - b.lastUsedMs);

  if (!scored.length) return null;
  const chosen = scored[0].proxy;
  const hist = ipRequestWindow.get(chosen.id) || [];
  hist.push(now);
  ipRequestWindow.set(chosen.id, hist);
  chosen.lastUsedAt = new Date(now).toISOString();
  return chosen;
}

/**
 * 上报代理请求成功/失败，连续失败自动剔除并触发可用率巡检
 */
async function reportProxyResult(proxyId, ok, errorMsg = '') {
  if (!proxyId) return;
  const db = store.getDb();
  const p = db.proxies.find((item) => item.id === proxyId);
  if (!p) return;

  if (ok) {
    p.status = 'healthy';
    p.failCount = 0;
    p.successCount = (p.successCount || 0) + 1;
    p.lastError = '';
  } else {
    p.failCount = (p.failCount || 0) + 1;
    p.lastError = errorMsg || '请求被目标平台拒绝或连接中断';
    const autoEvict = db.settings.antiCrawl && db.settings.antiCrawl.autoEvictBadProxy !== false;
    if (autoEvict && p.failCount >= 3) {
      p.status = 'evicted';
      store.addOpLog({
        module: '代理IP池',
        action: '自动剔除失效代理IP',
        operator: '反爬守护进程',
        status: 'warning',
        detail: `代理 [${p.region}] ${p.host}:${p.port} 连续失败 ${p.failCount} 次已自动剔除`,
        errorReason: p.lastError,
      });
    } else {
      p.status = 'failed';
    }
    await evaluateProxyPoolHealth(true);
  }
  store.save();
}

function formatProxyLabel(proxy) {
  if (!proxy) return '直连通道（未挂载代理）';
  return `[${proxy.region || '海外'}] ${proxy.host}:${proxy.port}`;
}

module.exports = {
  parseProxyLine,
  importProxiesBatch,
  evaluateProxyPoolHealth,
  requestRaw,
  checkSingleProxy,
  checkAllProxies,
  selectProxyForPlatform,
  reportProxyResult,
  formatProxyLabel,
};
