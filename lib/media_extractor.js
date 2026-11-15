'use strict';
/**
 * 开源视频与链接真封面提取模块
 * 结合 GitHub 高星开源工具链：
 *  1. 优先调用本地 yt-dlp（支持 IG / FB / X / Threads / TikTok / YouTube / 抖音 / 小红书）
 *     —— 网页设置里支持点一下「自动从 GitHub 下载安装」，小白不用敲命令行
 *  2. 还没装 yt-dlp 时，自动使用开源 FixTweet 接口（针对 X/Twitter 秒出高清封面+点赞+正文）、
 *     公开网页卡片接口（microlink.io）和网页原图抓取多路兜底
 *  3. 抓到真封面大图后立即存进本地 covers/ 目录，任何电脑看都不会失效
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const proxyPool = require('./proxy_pool');
const coverCache = require('./cover_cache');
const baseCollector = require('./collectors/base_collector');

const ROOT_DIR = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const LOCAL_YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_GITHUB_RELEASE =
  process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

function findYtDlpExecutable() {
  if (fs.existsSync(LOCAL_YTDLP_PATH)) {
    return LOCAL_YTDLP_PATH;
  }
  return null;
}

function checkSystemYtDlp() {
  return new Promise((resolve) => {
    const localBin = findYtDlpExecutable();
    if (localBin) return resolve(localBin);
    execFile('yt-dlp', ['--version'], { timeout: 3000 }, (err) => {
      if (!err) return resolve('yt-dlp');
      resolve(null);
    });
  });
}

async function getYtDlpStatus() {
  const exe = await checkSystemYtDlp();
  return {
    installed: Boolean(exe),
    path: exe || '',
    localPath: LOCAL_YTDLP_PATH,
    downloadSource: YTDLP_GITHUB_RELEASE,
  };
}

/**
 * 一键从 GitHub 官方发布源下载开源 yt-dlp 内核（跟随重定向保存到 bin/ 目录）
 */
function downloadFileWithRedirect(urlStr, destFile, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('下载跳转次数过多'));
    const u = new URL(urlStr);
    const req = https.get(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 45000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          return resolve(downloadFileWithRedirect(nextUrl, destFile, depth + 1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`下载返回状态异常 (${res.statusCode})`));
        }
        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
        const tmp = destFile + '.downloading';
        const ws = fs.createWriteStream(tmp);
        res.pipe(ws);
        ws.on('finish', () => {
          ws.close(() => {
            fs.renameSync(tmp, destFile);
            if (process.platform !== 'win32') {
              try { fs.chmodSync(destFile, 0o755); } catch (_) {}
            }
            resolve(destFile);
          });
        });
        ws.on('error', (err) => {
          try { fs.unlinkSync(tmp); } catch (_) {}
          reject(err);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('连接 GitHub 下载超时（建议挂上梯子后再点一次）'));
    });
  });
}

async function installYtDlpFromGithub() {
  const savedPath = await downloadFileWithRedirect(YTDLP_GITHUB_RELEASE, LOCAL_YTDLP_PATH);
  return { ok: true, path: savedPath };
}

function runYtDlpJson(exe, targetUrl, proxy = null) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-single-json', '--no-download', '--no-warnings', '--socket-timeout', '12'];
    if (proxy && proxy.host && proxy.port) {
      const auth = proxy.username ? `${proxy.username}:${proxy.password || ''}@` : '';
      args.push('--proxy', `${proxy.protocol || 'http'}://${auth}${proxy.host}:${proxy.port}`);
    }
    args.push(targetUrl);

    execFile(exe, args, { timeout: 22000, maxBuffer: 6 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error('解析视频信息失败'));
      }
    });
  });
}

function detectPlatformFromUrl(urlStr) {
  const lower = String(urlStr || '').toLowerCase();
  if (lower.includes('instagram.com')) return 'instagram';
  if (lower.includes('facebook.com') || lower.includes('fb.watch')) return 'facebook';
  if (lower.includes('x.com') || lower.includes('twitter.com')) return 'x';
  if (lower.includes('threads.net') || lower.includes('threads.com')) return 'threads';
  if (lower.includes('tiktok.com')) return 'tiktok';
  return 'instagram';
}

const LOGIN_PLACEHOLDER_TITLE_RE = /^(?:log\s*in|login|sign\s*up|see posts|instagram|facebook|threads|tiktok(?:\s*-\s*make your day)?|x(?:\s*\(twitter\))?|welcome back|join threads|video\s*\|\s*facebook|待拆解链接内容)\b|\(@[^)]+\)\s+on\s+(?:threads|instagram)\s*$/i;
const DEFAULT_SITE_ICON_RE = /static\.cdninstagram\.com|abs\.twimg\.com\/icons|fb_icon|threads-logo|rsrc\.php\/v3\/|favicon|apple-touch-icon|facebook\.com\/images\/fb_icon|tiktokcdn.*logo|musical\.ly/i;

function cleanExtractedText(txt) {
  const s = baseCollector.decodeHtmlEntities(String(txt || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || LOGIN_PLACEHOLDER_TITLE_RE.test(s) || /log\s*in to continue|sign up to see photos|create an account or log in/i.test(s)) {
    return '';
  }
  return s;
}

function cleanExtractedCover(url) {
  const u = String(url || '').trim();
  if (!u || DEFAULT_SITE_ICON_RE.test(u)) return '';
  return u;
}

function inferMediaTypeFromUrl(targetUrl, hasRealCover = false) {
  const u = String(targetUrl || '').toLowerCase();
  if (/\/video\/\d+/i.test(u)) return 'video';
  if (/\/photo\/\d+/i.test(u)) return 'image';
  if (/\/(?:reel|reels|videos|watch)\b/i.test(u) || /[?&]v=/.test(u)) return 'video';
  if (/\/(?:p|photo|photos)\b/i.test(u) || /photo\.php/i.test(u)) return 'image';
  return hasRealCover ? 'image' : 'text';
}

/**
 * 开源 FixTweet 通道：免登录直接拿 X / Twitter 视频、图文与纯文字推文指标
 */
async function tryFixTweetExtract(targetUrl, proxy = null) {
  const m = String(targetUrl).match(/(?:x\.com|twitter\.com)\/([^/]+)\/status\/(\d+)/i);
  if (!m) return null;
  const apiUrl = `https://api.fxtwitter.com/${m[1]}/status/${m[2]}`;
  const resp = await proxyPool.requestRaw(apiUrl, { timeoutMs: 10000 }, proxy);
  if (resp.statusCode < 200 || resp.statusCode >= 300) return null;
  const json = resp.json();
  const t = json && json.tweet;
  if (!t) return null;
  const videoObj = t.media && Array.isArray(t.media.videos) && t.media.videos[0];
  const photoObj = t.media && Array.isArray(t.media.photos) && t.media.photos[0];
  const mediaType = videoObj ? 'video' : photoObj ? 'image' : 'text';
  // 严禁拿博主头像当封面，防止纯文字推文被误判成真人露脸废片
  const coverRemoteUrl = cleanExtractedCover(
    (videoObj && videoObj.thumbnail_url) || (photoObj && photoObj.url) || ''
  );
  return {
    platform: 'x',
    mediaType,
    title: (t.text || '').split(/\r?\n/)[0].slice(0, 70) || (mediaType === 'text' ? 'X 热门纯文字推文' : 'X 热门推文'),
    fullText: t.text || '',
    coverRemoteUrl,
    durationSec: mediaType === 'video' ? (Math.round(videoObj.duration || 15) || 15) : 0,
    plays: Number(t.views || 0),
    likes: Number(t.likes || 0),
    comments: Number(t.replies || 0),
    shares: Number(t.retweets || 0),
    bookmarks: Number(t.bookmarks || 0),
    authorHandle: (t.author && t.author.screen_name) || m[1],
    authorFollowers: Number((t.author && t.author.followers) || 5000),
    publishedAt: t.created_at ? new Date(t.created_at).toISOString() : new Date().toISOString(),
  };
}

/**
 * 开源 Microlink 元数据抓取兜底
 */
async function tryMicrolinkExtract(targetUrl, proxy = null) {
  const apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(targetUrl)}`;
  const resp = await proxyPool.requestRaw(apiUrl, { timeoutMs: 10000 }, proxy);
  if (resp.statusCode < 200 || resp.statusCode >= 300) return null;
  const json = resp.json();
  if (!json || json.status !== 'success' || !json.data) return null;
  const d = json.data;
  const titleClean = cleanExtractedText(d.title || '');
  const descClean = cleanExtractedText(d.description || '');
  const coverClean = cleanExtractedCover((d.image && d.image.url) || '');
  if (!titleClean && !descClean && !coverClean) return null;
  const mediaType = inferMediaTypeFromUrl(targetUrl, Boolean(coverClean));
  return {
    platform: detectPlatformFromUrl(targetUrl),
    mediaType,
    title: (titleClean || descClean).slice(0, 72),
    fullText: descClean || titleClean,
    coverRemoteUrl: coverClean,
    durationSec: mediaType === 'video' ? 15 : 0,
    authorHandle: d.author || 'creator',
    publishedAt: d.date ? new Date(d.date).toISOString() : new Date().toISOString(),
  };
}

/**
 * TikTok 官方免鉴权 oEmbed 接口：直接获取视频/图文文案、作者与高清真封面
 */
async function tryTikTokOembedExtract(targetUrl, proxy = null) {
  const apiUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`;
  const resp = await proxyPool.requestRaw(apiUrl, { timeoutMs: 7000 }, proxy);
  if (resp.statusCode < 200 || resp.statusCode >= 300) return null;
  const j = resp.json();
  if (!j || (!cleanExtractedText(j.title || '') && !cleanExtractedCover(j.thumbnail_url || ''))) return null;
  const isPhoto = /\/photo\/\d+/i.test(targetUrl);
  const titleClean = cleanExtractedText(j.title || '');
  return {
    platform: 'tiktok',
    mediaType: isPhoto ? 'image' : 'video',
    title: titleClean.slice(0, 75),
    fullText: titleClean,
    coverRemoteUrl: cleanExtractedCover(j.thumbnail_url || ''),
    durationSec: isPhoto ? 0 : 15,
    bgm: isPhoto ? '图文热帖（无音频）' : 'TikTok Original Sound',
    authorHandle: j.author_unique_id || j.author_name || 'tiktok_creator',
    publishedAt: new Date().toISOString(),
  };
}

/**
 * 综合入口：输入任何视频/图文/纯文字帖子链接，尽量抓回真封面并缓存到 covers/，拿不到则交由调用方兜底
 */
async function extractFromUrl(targetUrl, proxy = null, prefixId = 'ext') {
  const platform = detectPlatformFromUrl(targetUrl);
  let info = null;

  // 1. 优先尝试本地 yt-dlp
  try {
    const ytdlpExe = await checkSystemYtDlp();
    if (ytdlpExe) {
      const data = await runYtDlpJson(ytdlpExe, targetUrl, proxy);
      const thumbs = Array.isArray(data.thumbnails) ? data.thumbnails : [];
      const bestThumb = cleanExtractedCover(data.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : ''));
      const uploadStr =
        data.upload_date && /^\d{8}$/.test(data.upload_date)
          ? `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}T12:00:00Z`
          : new Date().toISOString();
      info = {
        platform,
        mediaType: 'video',
        title: (data.title || data.description || '').slice(0, 75),
        fullText: data.description || data.title || '',
        coverRemoteUrl: bestThumb,
        durationSec: Math.round(Number(data.duration || 15)) || 15,
        bgm: data.track || data.artist || '原声 / BGM',
        plays: Number(data.view_count || 0),
        likes: Number(data.like_count || 0),
        comments: Number(data.comment_count || 0),
        shares: Number(data.repost_count || 0),
        authorHandle: data.uploader_id || data.uploader || 'creator',
        authorFollowers: Number(data.channel_follower_count || 5000),
        publishedAt: uploadStr,
        extractEngine: 'yt-dlp开源内核',
      };
    }
  } catch (_) {
    // 继续尝试公开兜底通道
  }

  // 2. X / Twitter 开源 FixTweet 接口
  if (!info && platform === 'x') {
    try {
      info = await tryFixTweetExtract(targetUrl, proxy);
      if (info) info.extractEngine = 'FixTweet开源接口';
    } catch (_) {}
  }

  // 2b. TikTok 官方公开 oEmbed 接口
  if (!info && platform === 'tiktok') {
    try {
      info = await tryTikTokOembedExtract(targetUrl, proxy);
      if (info) info.extractEngine = 'TikTok官方oEmbed';
    } catch (_) {}
  }

  // 3. 公开网页 OG 原图抓取
  if (!info) {
    try {
      const og = await baseCollector.fetchOpenGraphMetadata(targetUrl, proxy);
      const titleClean = cleanExtractedText(og && og.title);
      const descClean = cleanExtractedText(og && og.description);
      const coverClean = cleanExtractedCover(og && og.image);
      if (titleClean || descClean || coverClean) {
        const mediaType = inferMediaTypeFromUrl(targetUrl, Boolean(coverClean));
        const parsedMetrics = baseCollector.parseEngagementFromSnippet(`${titleClean} ${descClean}`);
        info = {
          platform,
          mediaType,
          title: (titleClean || descClean || '').slice(0, 75),
          fullText: descClean || titleClean || '',
          coverRemoteUrl: coverClean,
          durationSec: mediaType === 'video' ? (og.duration || 15) : 0,
          likes: parsedMetrics.likes || 0,
          comments: parsedMetrics.comments || 0,
          plays: parsedMetrics.plays || 0,
          publishedAt: new Date().toISOString(),
          extractEngine: '网页直抓大图',
        };
      }
    } catch (_) {}
  }

  // 4. Microlink 通用解析兜底
  if (!info || (!info.coverRemoteUrl && info.mediaType !== 'text')) {
    try {
      const ml = await tryMicrolinkExtract(targetUrl, proxy);
      if (ml) {
        info = Object.assign({}, ml, info || {});
        if (!info.title && ml.title) info.title = ml.title;
        if (!info.fullText && ml.fullText) info.fullText = ml.fullText;
        if (!info.coverRemoteUrl && ml.coverRemoteUrl) info.coverRemoteUrl = ml.coverRemoteUrl;
        info.extractEngine = info.extractEngine || '公开卡片解析器';
      }
    } catch (_) {}
  }

  let isPlaceholderText = false;
  if (!info || (!info.title && !info.fullText)) {
    isPlaceholderText = true;
    const mediaType = inferMediaTypeFromUrl(targetUrl, Boolean(info && info.coverRemoteUrl));
    info = {
      ...(info || {}),
      platform,
      mediaType,
      title: `待拆解链接内容 (${platform.toUpperCase()})`,
      fullText: `原链接：${targetUrl}`,
      coverRemoteUrl: (info && info.coverRemoteUrl) || '',
      durationSec: mediaType === 'video' ? 15 : 0,
      publishedAt: new Date().toISOString(),
      extractEngine: (info && info.extractEngine) || '链接直存',
    };
  }

  // 根据最终是否有视频标识与真实配图再次校准 mediaType（无视频且无非站标图则为纯文字）
  if (!info.mediaType || (info.mediaType === 'image' && !info.coverRemoteUrl && !/\/(?:p|photo|photos)\b/i.test(targetUrl))) {
    info.mediaType = inferMediaTypeFromUrl(targetUrl, Boolean(info.coverRemoteUrl));
  }
  if (info.mediaType !== 'video') {
    info.durationSec = 0;
  }

  if (!isPlaceholderText) {
    info.fullText = baseCollector.decodeHtmlEntities(info.fullText || '').trim();
    info.title = baseCollector.cleanReadableTitle(info.title || info.fullText, {
      fallbackText: info.fullText,
      authorHandle: info.authorHandle,
      platform,
    });
  }

  // 把真封面下载缓存到本地 covers/ 文件夹，确保跨电脑打开也绝对能显示！
  let localCover = '';
  if (info.coverRemoteUrl) {
    localCover = await coverCache.cacheCoverImage(info.coverRemoteUrl, prefixId, proxy);
  }

  return {
    ...info,
    isPlaceholderText,
    videoUrl: targetUrl,
    coverUrl: localCover || info.coverRemoteUrl || '',
  };
}

module.exports = {
  getYtDlpStatus,
  installYtDlpFromGithub,
  extractFromUrl,
  detectPlatformFromUrl,
};
