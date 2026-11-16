'use strict';
/**
 * GitHub 跨电脑同步与公开网页快照引擎
 * 让用户在任何电脑打开 GitHub Pages 网址都能看到最新抓取结果、大封面、抓取进度和拆解案例；
 * 在自己电脑运行时点一下「☁️ 一键同步到 GitHub 网页」，就把网页和脱敏快照推上 GitHub。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { PLATFORMS } = require('./defaults');
const remoteControl = require('./remote_control');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_FEED_FILE = path.join(ROOT_DIR, 'public_feed.json');

/**
 * 写入脱敏公开快照 public_feed.json（绝对不含任何密码、密钥、代理账号！）
 */
function writePublicFeedSnapshot(db, activeJob = null) {
  if (!db) return;
  try {
    const highLikeLine = Number((db.settings && db.settings.thresholds && db.settings.thresholds.highLikeGreenThreshold) || 10000);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayOfWeek = now.getDay() || 7;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dayOfWeek - 1)).getTime();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const countSince = (arr, field, ms) =>
      (arr || []).filter((x) => new Date(x[field] || x.publishedAt || 0).getTime() >= ms).length;

    const dQ = countSince(db.samples, 'collectedAt', startOfDay);
    const dT = countSince(db.trash, 'trashedAt', startOfDay);
    const wQ = countSince(db.samples, 'collectedAt', startOfWeek);
    const wT = countSince(db.trash, 'trashedAt', startOfWeek);
    const mQ = countSince(db.samples, 'collectedAt', startOfMonth);
    const mT = countSince(db.trash, 'trashedAt', startOfMonth);

    const platformBreakdown = PLATFORMS.map((p) => {
      const list = (db.samples || []).filter((s) => s.platform === p.id);
      return {
        id: p.id,
        name: p.name,
        shortName: p.shortName,
        color: p.color,
        count: list.length,
        ratioPct: db.samples.length ? Math.round((list.length / db.samples.length) * 100) : 0,
        viralCount: list.filter((s) => Number(s.likes || 0) >= highLikeLine).length,
      };
    });

    const tunnelState = remoteControl.getTunnelState();

    const snapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      hostComputer: os.hostname(),
      brandName: (db.settings && db.settings.brandName) || 'Laya',
      remoteTunnelUrl: tunnelState.tunnelUrl || '',
      remoteTunnelUpdatedAt: tunnelState.updatedAt || '',
      remotePinRequired: remoteControl.isRemotePinEnabled(db),
      crawlJob: activeJob || { running: false, currentStep: '空闲待命', liveLogs: [] },
      dashboard: {
        periods: {
          day: { total: dQ + dT, qualified: dQ, filtered: dT },
          week: { total: wQ + wT, qualified: wQ, filtered: wT },
          month: { total: mQ + mT, qualified: mQ, filtered: mT },
          allTime: {
            total: (db.samples || []).length + (db.trash || []).length,
            qualified: (db.samples || []).length,
            filtered: (db.trash || []).length,
          },
        },
        platformBreakdown,
        totalViralCount: (db.samples || []).filter((s) => Number(s.likes || 0) >= highLikeLine).length,
      },
      samples: (db.samples || []).slice(0, 300),
      trash: (db.trash || []).slice(0, 80),
      caseAnalyses: (db.caseAnalyses || []).slice(0, 50),
      keywordsCount: {
        brand: (db.keywords && db.keywords.brand && db.keywords.brand.length) || 0,
        competitor: (db.keywords && db.keywords.competitor && db.keywords.competitor.length) || 0,
        generic: (db.keywords && db.keywords.generic && db.keywords.generic.length) || 0,
      },
      recentLogs: (db.operationLogs || []).slice(0, 20),
    };

    fs.writeFileSync(PUBLIC_FEED_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (_) {
    // 只读容器环境忽略
  }
}

function normalizeGithubRepoUrl(rawUrl) {
  const txt = String(rawUrl || '').trim();
  if (!txt) return '';
  const m = txt.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s?#]+)/i);
  if (m) {
    const owner = m[1];
    const repo = m[2].replace(/\.git$/i, '');
    return `https://github.com/${owner}/${repo}.git`;
  }
  return txt;
}

function execGitWithBin(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: ROOT_DIR, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        const outErr = new Error((stderr || stdout || err.message || '').trim());
        outErr.code = err.code;
        return reject(outErr);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function runGit(args) {
  try {
    return await execGitWithBin('git', args);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const candidates = [
        'D:\\Program Files (x86)\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      ];
      for (const bin of candidates) {
        if (fs.existsSync(bin)) {
          return execGitWithBin(bin, args);
        }
      }
    }
    throw err;
  }
}

function computeGithubPagesUrl(remoteUrl) {
  const cleanUrl = normalizeGithubRepoUrl(remoteUrl);
  if (!cleanUrl) return '';
  const httpsMatch = cleanUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (!httpsMatch) return '';
  const owner = httpsMatch[1].toLowerCase();
  const repo = httpsMatch[2];
  if (repo.toLowerCase() === `${owner}.github.io`) {
    return `https://${owner}.github.io/`;
  }
  return `https://${owner}.github.io/${repo}/`;
}

async function getGithubRepoStatus(db) {
  let hasGit = false;
  const isRepo = fs.existsSync(path.join(ROOT_DIR, '.git'));
  let remoteUrl = normalizeGithubRepoUrl((db && db.settings && db.settings.githubSync && db.settings.githubSync.repoUrl) || '');
  let branch = (db && db.settings && db.settings.githubSync && db.settings.githubSync.branch) || 'main';

  try {
    await runGit(['--version']);
    hasGit = true;
    if (isRepo) {
      try {
        const origin = await runGit(['remote', 'get-url', 'origin']);
        if (origin) remoteUrl = normalizeGithubRepoUrl(origin);
      } catch (_) {}
      try {
        const curBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (curBranch && curBranch !== 'HEAD') branch = curBranch;
      } catch (_) {}
    }
  } catch (_) {}

  return {
    hasGit,
    isRepo,
    remoteUrl,
    branch,
    pagesUrl: computeGithubPagesUrl(remoteUrl),
    lastPushAt: (db && db.settings && db.settings.githubSync && db.settings.githubSync.lastPushAt) || '',
  };
}

/**
 * 网页点「☁️ 一键同步到 GitHub 网页」时执行：
 * 确保隐私数据(db.json/密钥)不被传上去 -> 刷新 public_feed.json -> 自动提交并推送到 GitHub
 */
async function pushToGithub({ repoUrl = '', branch = 'main', db, activeJob = null }) {
  writePublicFeedSnapshot(db, activeJob);

  try {
    await runGit(['--version']);
  } catch (_) {
    throw new Error('这台电脑还没安装 Git，无法直接推送；您也可以直接把文件夹上传到 GitHub 网页仓库');
  }

  const targetBranch = String(branch || 'main').trim() || 'main';
  const isRepo = fs.existsSync(path.join(ROOT_DIR, '.git'));
  if (!isRepo) {
    await runGit(['init']);
    await runGit(['branch', '-M', targetBranch]);
  }

  // 检查 .gitignore 保护隐私文件
  const giFile = path.join(ROOT_DIR, '.gitignore');
  const mustIgnore = ['node_modules/', 'data/db.json', 'data/db.json.tmp', 'data/tunnel_state.json', 'data/guardian.pid', 'data/guardian.log', 'data/backups/', 'bin/', '.env', '.vercel'];
  let giContent = fs.existsSync(giFile) ? fs.readFileSync(giFile, 'utf8') : '';
  let changedGi = false;
  for (const item of mustIgnore) {
    if (!giContent.includes(item)) {
      giContent += (giContent.endsWith('\n') || !giContent ? '' : '\n') + item + '\n';
      changedGi = true;
    }
  }
  if (changedGi) fs.writeFileSync(giFile, giContent, 'utf8');

  const cleanRepo = normalizeGithubRepoUrl(repoUrl);
  let finalRemote = cleanRepo;
  if (cleanRepo) {
    try {
      await runGit(['remote', 'get-url', 'origin']);
      await runGit(['remote', 'set-url', 'origin', cleanRepo]);
    } catch (_) {
      await runGit(['remote', 'add', 'origin', cleanRepo]);
    }
  } else {
    try {
      finalRemote = normalizeGithubRepoUrl(await runGit(['remote', 'get-url', 'origin']));
    } catch (_) {
      throw new Error('请先在设置里填一次您的 GitHub 仓库地址（例如 https://github.com/你的名字/laya-social-scout.git）');
    }
  }

  // 自动补齐当前仓库的本地提交身份，防止新电脑报 Author identity unknown
  const ownerMatch = finalRemote.match(/github\.com[:/]([^/]+)\//i);
  const fallbackOwner = (ownerMatch && ownerMatch[1]) || 'Sorenskr';
  let userName = '';
  let userEmail = '';
  try {
    userName = await runGit(['config', 'user.name']);
  } catch (_) {}
  try {
    userEmail = await runGit(['config', 'user.email']);
  } catch (_) {}
  if (!userName) {
    await runGit(['config', '--local', 'user.name', fallbackOwner]);
  }
  if (!userEmail) {
    await runGit(['config', '--local', 'user.email', `${fallbackOwner.toLowerCase()}@users.noreply.github.com`]);
  }

  await runGit(['add', '.']);
  const statusOut = await runGit(['status', '--porcelain']);
  if (statusOut) {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    await runGit(['commit', '-m', `更新抓到的视频封面与案例 (${stamp})`]);
  }

  try {
    await runGit(['push', '-u', 'origin', `HEAD:${targetBranch}`]);
  } catch (pushErr) {
    const msg = String((pushErr && pushErr.message) || '');
    if (/fetch first|non-fast-forward|rejected|failed to push some refs/i.test(msg)) {
      await runGit(['push', '-f', '-u', 'origin', `HEAD:${targetBranch}`]);
    } else {
      throw pushErr;
    }
  }

  const pagesUrl = computeGithubPagesUrl(finalRemote);
  if (db && db.settings) {
    db.settings.githubSync = Object.assign({}, db.settings.githubSync || {}, {
      repoUrl: finalRemote,
      branch: targetBranch,
      lastPushAt: new Date().toISOString(),
      pagesUrl,
    });
  }

  return {
    ok: true,
    remoteUrl: finalRemote,
    branch: targetBranch,
    pagesUrl,
    pushedAt: new Date().toISOString(),
  };
}

module.exports = {
  PUBLIC_FEED_FILE,
  writePublicFeedSnapshot,
  normalizeGithubRepoUrl,
  getGithubRepoStatus,
  pushToGithub,
  computeGithubPagesUrl,
};
