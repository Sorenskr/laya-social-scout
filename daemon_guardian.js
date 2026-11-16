'use strict';
/**
 * 交友软广抓视频工作台 —— 永久后台守护 + Cloudflare Quick Tunnel 公网穿透管理器
 * 功能：
 *  1) 自动守望本机 3080 端口（main.js 崩溃或远程请求重启后 2 秒内自动拉起）
 *  2) 自动启动并保活 cloudflared.exe (--protocol http2) 建立 https://*.trycloudflare.com 穿透隧道
 *  3) 隧道连上公网后自动写入 data/tunnel_state.json 并自动触发 POST /api/github/push，
 *     让全球任意电脑打开 GitHub Pages 网址都能拿到最新安全通道直连控制本机！
 *
 * 用法：
 *   node daemon_guardian.js          启动常驻守护
 *   node daemon_guardian.js --stop   停止守护与穿透进程
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const remoteControl = require('./lib/remote_control');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PID_FILE = path.join(DATA_DIR, 'guardian.pid');
const LOG_FILE = path.join(DATA_DIR, 'guardian.log');
const CLOUDFLARED_BIN = path.join(ROOT_DIR, 'bin', 'cloudflared.exe');
const PORT = Number(process.env.PORT || 3080);
const LOCAL_HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const LOCAL_PUSH_URL = `http://127.0.0.1:${PORT}/api/github/push`;

let serverChild = null;
let serverStartingAt = 0;
let consecutiveHealthFails = 0;

let tunnelChild = null;
let currentTunnelUrl = '';
let publishedTunnelUrl = '';
let isShuttingDown = false;
let patrolTimer = null;
let tunnelRestartTimer = null;
let verifyingTunnel = false;

function logMsg(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 256 * 1024) {
      const tail = fs.readFileSync(LOG_FILE, 'utf8').slice(-64 * 1024);
      fs.writeFileSync(LOG_FILE, tail, 'utf8');
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch (_) { /* ignore */ }
}

function isPidAlive(pid) {
  const num = Number(pid || 0);
  if (!num || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readPidMeta() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) return JSON.parse(raw);
    return { pid: Number(raw) };
  } catch (_) {
    return null;
  }
}

function writePidMeta(extra = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const meta = Object.assign(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cloudflaredPid: tunnelChild && tunnelChild.pid ? tunnelChild.pid : 0,
      },
      extra
    );
    fs.writeFileSync(PID_FILE, JSON.stringify(meta, null, 2), 'utf8');
  } catch (_) { /* ignore */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeLocalHealth(timeoutMs = 1500) {
  try {
    const res = await fetch(LOCAL_HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function startLocalServer() {
  if (isShuttingDown) return;
  if (serverChild && !serverChild.killed) return;
  if (Date.now() - serverStartingAt < 5000) return;

  serverStartingAt = Date.now();
  logMsg('正在拉起主服务 main.js (端口 3080)...');
  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'main.js')], {
    cwd: ROOT_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;

  child.stdout.on('data', (chunk) => {
    const txt = String(chunk || '').trim();
    if (txt) logMsg(`[main] ${txt.slice(0, 240)}`);
  });
  child.stderr.on('data', (chunk) => {
    const txt = String(chunk || '').trim();
    if (txt) logMsg(`[main:err] ${txt.slice(0, 240)}`);
  });
  child.on('exit', (code, signal) => {
    logMsg(`主服务进程已退出 (code=${code}, signal=${signal || ''})`);
    if (serverChild === child) {
      serverChild = null;
      serverStartingAt = 0;
    }
    if (!isShuttingDown) {
      setTimeout(() => ensureServerPatrol(), 1200);
    }
  });
}

async function ensureServerPatrol() {
  if (isShuttingDown) return;
  const ok = await probeLocalHealth(1500);
  if (ok) {
    consecutiveHealthFails = 0;
    if (!tunnelChild && !tunnelRestartTimer) {
      startCloudflareTunnel();
    }
    return;
  }
  consecutiveHealthFails += 1;
  if (consecutiveHealthFails >= 1) {
    startLocalServer();
  }
}

async function waitAndPublishTunnel(tunnelUrl) {
  if (verifyingTunnel || publishedTunnelUrl === tunnelUrl) return;
  verifyingTunnel = true;
  try {
    logMsg(`捕获到公网隧道域名：${tunnelUrl}，正在检测公网连通性...`);
    let reachable = false;
    for (let i = 0; i < 10; i++) {
      if (isShuttingDown || currentTunnelUrl !== tunnelUrl) return;
      try {
        const res = await fetch(`${tunnelUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          reachable = true;
          break;
        }
      } catch (_) { /* 等待 Cloudflare DNS 生效 */ }
      await sleep(2000);
    }

    if (!reachable) {
      logMsg(`⚠️ 隧道 ${tunnelUrl} 公网健康检测暂未就绪，仍先记录并等待后续重试`);
    } else {
      logMsg(`✅ 公网隧道健康连通确认通过：${tunnelUrl}`);
    }

    remoteControl.saveTunnelState({
      tunnelUrl,
      guardianPid: process.pid,
      updatedAt: new Date().toISOString(),
    });

    // 等本地 3080 完全就绪后自动推送 GitHub，让其他电脑打开网页立刻拿到新通道
    for (let j = 0; j < 5; j++) {
      if (await probeLocalHealth(1500)) break;
      await sleep(1000);
    }
    try {
      const pushRes = await fetch(LOCAL_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(60000),
      });
      const pushText = await pushRes.text();
      if (pushRes.ok) {
        publishedTunnelUrl = tunnelUrl;
        logMsg(`🚀 已自动把新公网穿透地址同步上 GitHub Pages！(${pushText.slice(0, 160)})`);
      } else {
        logMsg(`⚠️ 自动同步 GitHub 返回 ${pushRes.status}: ${pushText.slice(0, 160)}`);
      }
    } catch (err) {
      logMsg(`⚠️ 自动同步 GitHub 请求失败: ${err.message}`);
    }
  } finally {
    verifyingTunnel = false;
  }
}

function handleCloudflaredLine(chunk) {
  const text = String(chunk || '');
  const matches = text.match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi) || [];
  for (const raw of matches) {
    const clean = raw.toLowerCase().replace(/\/+$/, '');
    if (/^https:\/\/(api|www)\.trycloudflare\.com$/i.test(clean)) continue;
    if (clean !== currentTunnelUrl) {
      currentTunnelUrl = clean;
      waitAndPublishTunnel(clean).catch(() => {});
    }
  }
}

function startCloudflareTunnel() {
  if (isShuttingDown) return;
  if (tunnelChild && !tunnelChild.killed) return;
  if (!fs.existsSync(CLOUDFLARED_BIN)) {
    logMsg(`⚠️ 未找到 ${CLOUDFLARED_BIN}，跳过公网穿透（仅本地保活运行）`);
    return;
  }

  logMsg('正在启动 Cloudflare Quick Tunnel (--protocol http2)...');
  currentTunnelUrl = '';
  const child = spawn(
    CLOUDFLARED_BIN,
    ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--protocol', 'http2', '--no-autoupdate'],
    {
      cwd: ROOT_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  tunnelChild = child;
  writePidMeta({ cloudflaredPid: child.pid || 0 });

  child.stdout.on('data', (chunk) => handleCloudflaredLine(chunk));
  child.stderr.on('data', (chunk) => handleCloudflaredLine(chunk));
  child.on('exit', (code, signal) => {
    logMsg(`⚠️ cloudflared 隧道已退出 (code=${code}, signal=${signal || ''})`);
    if (tunnelChild === child) {
      tunnelChild = null;
      writePidMeta({ cloudflaredPid: 0 });
    }
    if (!isShuttingDown) {
      tunnelRestartTimer = setTimeout(() => {
        tunnelRestartTimer = null;
        startCloudflareTunnel();
      }, 5000);
    }
  });
}

function cleanupAndExit(code = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (patrolTimer) clearInterval(patrolTimer);
  if (tunnelRestartTimer) clearTimeout(tunnelRestartTimer);
  try {
    if (tunnelChild && !tunnelChild.killed) tunnelChild.kill();
  } catch (_) { /* ignore */ }
  try {
    if (fs.existsSync(PID_FILE)) {
      const meta = readPidMeta();
      if (!meta || Number(meta.pid) === process.pid) fs.unlinkSync(PID_FILE);
    }
  } catch (_) { /* ignore */ }
  process.exit(code);
}

function stopExistingGuardian() {
  const meta = readPidMeta();
  if (!meta) {
    console.log('未发现正在运行的守护进程记录。');
    return;
  }
  if (meta.cloudflaredPid && isPidAlive(meta.cloudflaredPid)) {
    try { process.kill(Number(meta.cloudflaredPid)); } catch (_) {}
  }
  if (meta.pid && isPidAlive(meta.pid)) {
    try {
      process.kill(Number(meta.pid));
      console.log(`已停止守护进程 PID=${meta.pid}`);
    } catch (e) {
      console.log(`停止守护进程失败: ${e.message}`);
    }
  } else {
    console.log('旧守护进程已不在运行，清理残留 PID 文件。');
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

if (require.main === module) {
  if (process.argv.includes('--stop')) {
    stopExistingGuardian();
    process.exit(0);
  }

  const existing = readPidMeta();
  if (existing && existing.pid && existing.pid !== process.pid && isPidAlive(existing.pid)) {
    console.log(`守护进程已在运行中 (PID=${existing.pid})，无需重复启动。`);
    process.exit(0);
  }

  writePidMeta({ cloudflaredPid: 0 });
  logMsg(`🟢 守护进程启动成功 (PID=${process.pid})，开始守护端口 ${PORT} 与跨电脑公网通道`);

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));

  ensureServerPatrol();
  patrolTimer = setInterval(() => {
    ensureServerPatrol().catch(() => {});
  }, 3000);
}
