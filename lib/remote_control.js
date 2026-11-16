'use strict';
/**
 * 跨电脑同网址远程控制、安全口令校验、工作台/比特浏览器唤醒与 Windows 开机自启守护工具
 * 注意：pin 仅保存在本机 data/db.json，绝不写入 public_feed.json。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec, execFileSync } = require('child_process');
const fingerprintBrowser = require('./fingerprint_browser');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TUNNEL_STATE_FILE = path.join(DATA_DIR, 'tunnel_state.json');

const REG_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE_NAME = 'LayaSocialScoutGuardian';

const BITBROWSER_EXE_CANDIDATES = [
  'E:\\Program Files (x86)\\bitbrowser\\比特浏览器.exe',
  'D:\\Program Files (x86)\\bitbrowser\\比特浏览器.exe',
  'C:\\Program Files (x86)\\bitbrowser\\比特浏览器.exe',
  'C:\\Program Files\\bitbrowser\\比特浏览器.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'bitbrowser', '比特浏览器.exe') : '',
].filter(Boolean);

// 按客户端 IP 记录失败尝试时间戳，防止公网爆破口令
const failedPinAttempts = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getTunnelState() {
  try {
    if (!fs.existsSync(TUNNEL_STATE_FILE)) {
      return { tunnelUrl: '', updatedAt: '', guardianPid: 0 };
    }
    const parsed = JSON.parse(fs.readFileSync(TUNNEL_STATE_FILE, 'utf8'));
    return {
      tunnelUrl: String(parsed.tunnelUrl || '').trim(),
      updatedAt: String(parsed.updatedAt || '').trim(),
      guardianPid: Number(parsed.guardianPid || 0),
    };
  } catch (_) {
    return { tunnelUrl: '', updatedAt: '', guardianPid: 0 };
  }
}

function saveTunnelState(patch = {}) {
  const current = getTunnelState();
  const next = Object.assign({}, current, patch, {
    updatedAt: patch.updatedAt || new Date().toISOString(),
  });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${TUNNEL_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, TUNNEL_STATE_FILE);
  } catch (_) {
    // 忽略只读环境
  }
  return next;
}

function getRemotePin(db) {
  const raw = db && db.settings && db.settings.remoteControl && db.settings.remoteControl.pin;
  const trimmed = String(raw || '').trim();
  return trimmed || '8888';
}

function isRemotePinEnabled(db) {
  if (!db || !db.settings || !db.settings.remoteControl) return true;
  return db.settings.remoteControl.enabled !== false;
}

/**
 * 严格判定是否属于「当前主电脑自身回环直连」：
 * 1) remoteAddress 必须为 127.0.0.1 / ::1 / ::ffff:127.0.0.1
 * 2) 不得包含 Cloudflare / 反向代理转发头，且 Host 不含 trycloudflare.com
 * 防止 cloudflared 本地代理进来的外网请求绕过口令验证！
 */
function isLocalLoopbackReq(req) {
  if (!req) return false;
  const addr = String((req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '').trim();
  const isLoopIp = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!isLoopIp) return false;

  const h = req.headers || {};
  if (h['cf-connecting-ip'] || h['x-forwarded-for'] || h['cf-ray'] || h['x-real-ip'] || h['forwarded']) {
    return false;
  }
  const host = String(h.host || '').toLowerCase();
  if (host.includes('trycloudflare.com')) {
    return false;
  }
  return true;
}

function getClientIpKey(req) {
  const h = (req && req.headers) || {};
  const cfIp = String(h['cf-connecting-ip'] || h['x-forwarded-for'] || (req && req.socket && req.socket.remoteAddress) || 'unknown')
    .split(',')[0]
    .trim();
  return cfIp || 'unknown';
}

/**
 * 静默检查请求是否已带上正确口令（不计入失败限流，供 /api/health 状态探测用）
 */
function checkPinOnly(req, db, explicitPin = '') {
  const isLocal = isLocalLoopbackReq(req);
  if (isLocal || !isRemotePinEnabled(db)) {
    return { ok: true, isLocal, headerMatchesPin: true };
  }
  const supplied = String(explicitPin || (req && req.headers && req.headers['x-remote-pin']) || '').trim();
  const expected = getRemotePin(db);
  const matched = Boolean(supplied && supplied === expected);
  return { ok: matched, isLocal: false, headerMatchesPin: matched };
}

/**
 * 严格校 Remote PIN（带 60 秒内最多错 12 次防爆破保护）
 */
function verifyRemotePin(req, db, explicitPin = '') {
  const isLocal = isLocalLoopbackReq(req);
  if (isLocal || !isRemotePinEnabled(db)) {
    return { ok: true, isLocal };
  }

  const clientKey = getClientIpKey(req);
  const now = Date.now();
  const prevList = (failedPinAttempts.get(clientKey) || []).filter((ts) => now - ts < 60 * 1000);
  if (prevList.length >= 12) {
    failedPinAttempts.set(clientKey, prevList);
    return {
      ok: false,
      isLocal: false,
      status: 429,
      needPin: true,
      error: '口令错误次数过多，请等待 1 分钟后再试',
    };
  }

  const supplied = String(explicitPin || (req && req.headers && req.headers['x-remote-pin']) || '').trim();
  const expected = getRemotePin(db);
  if (supplied && supplied === expected) {
    failedPinAttempts.delete(clientKey);
    return { ok: true, isLocal: false };
  }

  if (supplied) {
    prevList.push(now);
    failedPinAttempts.set(clientKey, prevList);
  }

  return {
    ok: false,
    isLocal: false,
    status: 401,
    needPin: true,
    error: supplied ? '远程控制口令不正确，请重新输入' : '🔒 需要输入主电脑远程控制口令才能远程操作',
  };
}

function findBitBrowserExe() {
  for (const p of BITBROWSER_EXE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  return '';
}

/**
 * 远程启动/唤醒主电脑工作台与比特浏览器：
 * - 比特浏览器未开启时尝试自动启动 客户端 并等待接口就绪
 * - 在线后自动打开预设防封窗口，让主电脑随时处于可抓取状态
 * - 可选打开主电脑桌面浏览器，或让守护进程平滑重启工作台服务
 */
async function wakeHostWorkbench(db, options = {}) {
  const fpCfg = (db && db.settings && db.settings.fingerprintBrowser) || {};
  let status = await fingerprintBrowser.detectFingerprintBrowsers(fpCfg);
  let bitbrowserLaunched = false;

  if (!status.bitbrowserOnline) {
    const exePath = findBitBrowserExe();
    if (exePath) {
      try {
        const child = spawn(exePath, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        bitbrowserLaunched = true;
      } catch (_) { /* ignore */ }

      for (let i = 0; i < 6; i++) {
        await sleep(1500);
        status = await fingerprintBrowser.detectFingerprintBrowsers(fpCfg);
        if (status.bitbrowserOnline) break;
      }
    }
  }

  let activeProfileName = fpCfg.selectedProfileName || '';
  let profileWarmed = false;

  if (status.bitbrowserOnline && options.openProfile !== false) {
    const bitProfiles = (status.profiles || []).filter((p) => p.source === 'bitbrowser');
    const target =
      bitProfiles.find((p) => p.id === fpCfg.selectedProfileId) ||
      bitProfiles[0];
    if (target) {
      try {
        const opened = await fingerprintBrowser.openFingerprintProfile(fpCfg, target.id, 'bitbrowser');
        activeProfileName = target.name || opened.profileName || activeProfileName;
        profileWarmed = true;
        if (db && db.settings && db.settings.fingerprintBrowser && !db.settings.fingerprintBrowser.selectedProfileId) {
          db.settings.fingerprintBrowser.selectedProfileId = target.id;
          db.settings.fingerprintBrowser.selectedProfileName = activeProfileName;
        }
      } catch (_) {
        // 客户端刚拉起时窗口列表或内核可能尚在初始化，不阻断主响应
      }
    }
  }

  if (options.openHostBrowser === true && process.platform === 'win32') {
    try {
      exec('cmd /c start "" "http://localhost:3080"');
    } catch (_) { /* ignore */ }
  }

  const restarting = Boolean(options.restartServer);
  if (restarting) {
    setTimeout(() => process.exit(0), 400);
  }

  let message = '';
  if (restarting) {
    message = '主电脑工作台正在平滑重启中（约 2 秒恢复），并已检查比特浏览器状态';
  } else if (status.bitbrowserOnline) {
    message = profileWarmed
      ? `主电脑工作台与比特浏览器已就绪（窗口：${activeProfileName || '默认窗口'}），现在可直接开始搜词抓取！`
      : '主电脑工作台与比特浏览器已在线就绪，现在可直接开始搜词抓取！';
  } else if (bitbrowserLaunched) {
    message = '已从远程拉起主电脑比特浏览器（客户端启动较慢，若刚弹出登录界面请在主电脑点一下登录后再抓）';
  } else {
    message = '主电脑工作台后台在线（未检测到比特浏览器运行，抓词时将优先尝试备用防封通道或请在主电脑开启比特浏览器）';
  }

  return {
    ok: true,
    hostComputer: os.hostname(),
    bitbrowserLaunched,
    bitbrowserOnline: Boolean(status.bitbrowserOnline),
    dedicatedOnline: Boolean(status.dedicatedOnline),
    activeProfileName,
    profileWarmed,
    restarting,
    message,
  };
}

function getWindowsAutoStartStatus() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('reg.exe', ['query', REG_RUN_KEY, '/v', REG_VALUE_NAME], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return out.includes(REG_VALUE_NAME);
  } catch (_) {
    return false;
  }
}

function setWindowsAutoStart(enabled, rootDir = ROOT_DIR) {
  if (process.platform !== 'win32') return false;
  const vbsPath = path.join(rootDir, 'scripts', 'silent_guardian.vbs');
  if (enabled) {
    const cmdValue = `wscript.exe "${vbsPath}"`;
    execFileSync(
      'reg.exe',
      ['add', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/t', 'REG_SZ', '/d', cmdValue, '/f'],
      { windowsHide: true, timeout: 5000 }
    );
    return true;
  }
  try {
    execFileSync(
      'reg.exe',
      ['delete', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/f'],
      { windowsHide: true, timeout: 5000 }
    );
  } catch (_) {
    // 若原本不存在则忽略
  }
  return false;
}

module.exports = {
  TUNNEL_STATE_FILE,
  getTunnelState,
  saveTunnelState,
  getRemotePin,
  isRemotePinEnabled,
  isLocalLoopbackReq,
  checkPinOnly,
  verifyRemotePin,
  wakeHostWorkbench,
  getWindowsAutoStartStatus,
  setWindowsAutoStart,
};
