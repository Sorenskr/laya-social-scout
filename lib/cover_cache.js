'use strict';
/**
 * 高清大封面本地缓存模块
 * 把抓到的远程视频封面下载保存到项目根目录的 covers/ 文件夹下，
 * 生成相对路径 ./covers/xxx.jpg，保证在本地电脑和 GitHub 网页上都能直接秒开不裂图。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proxyPool = require('./proxy_pool');

const ROOT_DIR = path.join(__dirname, '..');
const COVERS_DIR = path.join(ROOT_DIR, 'covers');

function ensureCoversDir() {
  try {
    if (fs.existsSync(COVERS_DIR)) {
      const st = fs.statSync(COVERS_DIR);
      if (!st.isDirectory()) {
        fs.unlinkSync(COVERS_DIR);
        fs.mkdirSync(COVERS_DIR, { recursive: true });
      }
    } else {
      fs.mkdirSync(COVERS_DIR, { recursive: true });
    }
  } catch (_) {
    // 只读运行环境忽略
  }
}

function guessExt(mimeType = '', urlStr = '') {
  const ct = String(mimeType).toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('svg')) return '.svg';
  if (/\.png(\?|$)/i.test(urlStr)) return '.png';
  if (/\.webp(\?|$)/i.test(urlStr)) return '.webp';
  return '.jpg';
}

/**
 * 把传来的截图图片数据存成独立封面文件（供丢链接/传图拆案例功能用）
 */
function saveDataUriCover(dataUri, prefixId = 'case') {
  if (!dataUri || typeof dataUri !== 'string') return '';
  const m = dataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!m) return dataUri;
  const mime = m[1];
  const ext = guessExt(mime, '');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf || buf.length < 64) return dataUri;

  try {
    ensureCoversDir();
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
    const filename = `${prefixId}_${hash}${ext}`;
    fs.writeFileSync(path.join(COVERS_DIR, filename), buf);
    return `./covers/${filename}`;
  } catch (_) {
    return dataUri;
  }
}

/**
 * 下载远程封面图片并保存到 covers/，返回 ./covers/文件名；下载失败则返回原链接或空
 */
async function cacheCoverImage(remoteUrl, prefixId = 'smp', proxy = null) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return '';
  if (remoteUrl.startsWith('./covers/') || remoteUrl.startsWith('covers/')) {
    return remoteUrl.startsWith('./') ? remoteUrl : `./${remoteUrl}`;
  }
  if (remoteUrl.startsWith('data:image/')) {
    if (remoteUrl.includes('image/svg+xml')) {
      return remoteUrl;
    }
    return saveDataUriCover(remoteUrl, prefixId);
  }
  if (!/^https?:\/\//i.test(remoteUrl)) return remoteUrl;

  const tryDownload = async (px) => {
    const u = new URL(remoteUrl);
    const resp = await proxyPool.requestRaw(
      remoteUrl,
      {
        timeoutMs: 10000,
        maxBytes: 3 * 1024 * 1024,
        headers: {
          Referer: `${u.protocol}//${u.hostname}/`,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      },
      px
    );
    if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.buffer && resp.buffer.length > 512) {
      const ct = String(resp.headers['content-type'] || '');
      if (ct && !ct.toLowerCase().startsWith('image/') && !ct.toLowerCase().includes('octet-stream')) {
        return null;
      }
      return { buf: resp.buffer, ct };
    }
    return null;
  };

  try {
    let downloaded = null;
    if (proxy) {
      try {
        downloaded = await tryDownload(proxy);
      } catch (_) { /* 换直连试一次 */ }
    }
    if (!downloaded) {
      downloaded = await tryDownload(null);
    }
    if (!downloaded) return remoteUrl;

    ensureCoversDir();
    const hash = crypto.createHash('md5').update(remoteUrl).digest('hex').slice(0, 8);
    const ext = guessExt(downloaded.ct, remoteUrl);
    const cleanPrefix = String(prefixId || 'smp').replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = `${cleanPrefix}_${hash}${ext}`;
    fs.writeFileSync(path.join(COVERS_DIR, filename), downloaded.buf);
    return `./covers/${filename}`;
  } catch (_) {
    return remoteUrl;
  }
}

module.exports = {
  COVERS_DIR,
  ensureCoversDir,
  cacheCoverImage,
  saveDataUriCover,
};
