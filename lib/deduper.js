'use strict';
/**
 * 跨平台内容自动去重与搬运合并引擎
 * 识别维度：
 *  1. 标准化原视频链接一致
 *  2. 视频指纹（mediaFingerprint / 封面特征标识）一致
 *  3. 跨平台搬运文案高相似度（N-gram Jaccard 相似度 >= 0.78，或核心对白完全一致）
 * 命中去重后自动合并平台标签与备用直链，不重复占用结果列表与飞书表格行。
 */
const crypto = require('crypto');

function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl.trim());
    const dropParams = ['utm_source', 'utm_medium', 'utm_campaign', 'igshid', 'igsh', 'fbclid', 's', 't', 'ref'];
    dropParams.forEach((p) => u.searchParams.delete(p));
    let cleanPath = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${cleanPath}${u.search}`;
  } catch (_) {
    return rawUrl.trim().toLowerCase();
  }
}

function cleanCopyText(text) {
  if (!text) return '';
  return String(text)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/@[\w.]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
    .trim();
}

function buildShingles(cleanStr, n = 2) {
  const set = new Set();
  if (!cleanStr) return set;
  if (cleanStr.length <= n) {
    set.add(cleanStr);
    return set;
  }
  for (let i = 0; i <= cleanStr.length - n; i++) {
    set.add(cleanStr.slice(i, i + n));
  }
  return set;
}

function jaccardSimilarity(strA, strB) {
  const a = cleanCopyText(strA);
  const b = cleanCopyText(strB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 16 && b.length >= 16 && (a.includes(b) || b.includes(a))) {
    return 0.92;
  }
  const setA = buildShingles(a, 2);
  const setB = buildShingles(b, 2);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const item of setA) {
    if (setB.has(item)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function computeContentHash(candidate) {
  const base = cleanCopyText(`${candidate.title || ''}|${candidate.fullText || ''}`).slice(0, 180);
  if (!base) return '';
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

/**
 * 在现有合格库和垃圾库中检查是否为重复或跨平台搬运内容
 * 返回: { isDuplicate: boolean, location: 'samples'|'trash'|null, matchedItem: object|null, reason: string }
 */
function findDuplicate(candidate, existingSamples = [], existingTrash = []) {
  const normUrl = normalizeUrl(candidate.videoUrl);
  const copyHash = computeContentHash(candidate);
  const mediaFp = candidate.mediaFingerprint || '';

  const checkPool = (pool, loc) => {
    for (const item of pool) {
      if (normUrl && normalizeUrl(item.videoUrl) === normUrl) {
        return { isDuplicate: true, location: loc, matchedItem: item, reason: '相同原视频直链' };
      }
      if (Array.isArray(item.alternateUrls) && item.alternateUrls.some((u) => normalizeUrl(u.url) === normUrl)) {
        return { isDuplicate: true, location: loc, matchedItem: item, reason: '已合并的跨平台搬运链接' };
      }
      if (mediaFp && item.mediaFingerprint && mediaFp === item.mediaFingerprint) {
        return { isDuplicate: true, location: loc, matchedItem: item, reason: '跨平台同一视频源指纹（搬运合并）' };
      }
      if (copyHash && item.contentHash && copyHash === item.contentHash) {
        return { isDuplicate: true, location: loc, matchedItem: item, reason: '完全相同文案（跨平台搬运）' };
      }
      const sim = jaccardSimilarity(
        `${candidate.title || ''} ${candidate.fullText || ''}`,
        `${item.title || ''} ${item.fullText || ''}`
      );
      if (sim >= 0.78) {
        return {
          isDuplicate: true,
          location: loc,
          matchedItem: item,
          reason: `跨平台高度相似文案搬运（重合度 ${Math.round(sim * 100)}%）`,
        };
      }
    }
    return null;
  };

  return checkPool(existingSamples, 'samples') || checkPool(existingTrash, 'trash') || {
    isDuplicate: false,
    location: null,
    matchedItem: null,
    reason: '',
  };
}

/**
 * 将跨平台搬运的新样本信息合并进已有合格样本（不新增重复行）
 */
function mergeDuplicateIntoExisting(existing, incoming) {
  if (!Array.isArray(existing.mergedPlatforms)) {
    existing.mergedPlatforms = [existing.platform];
  }
  if (incoming.platform && !existing.mergedPlatforms.includes(incoming.platform)) {
    existing.mergedPlatforms.push(incoming.platform);
  }
  if (!Array.isArray(existing.alternateUrls)) {
    existing.alternateUrls = [];
  }
  if (
    incoming.videoUrl &&
    normalizeUrl(incoming.videoUrl) !== normalizeUrl(existing.videoUrl) &&
    !existing.alternateUrls.some((u) => normalizeUrl(u.url) === normalizeUrl(incoming.videoUrl))
  ) {
    existing.alternateUrls.push({
      platform: incoming.platform,
      url: incoming.videoUrl,
      plays: incoming.plays || 0,
      likes: incoming.likes || 0,
    });
  }
  existing.duplicateCount = (existing.duplicateCount || 1) + 1;
  // 若搬运版互动更高，保留峰值数据供参考
  if ((incoming.likes || 0) > (existing.likes || 0)) {
    existing.likes = incoming.likes;
  }
  if ((incoming.plays || 0) > (existing.plays || 0)) {
    existing.plays = incoming.plays;
  }
  existing.updatedAt = new Date().toISOString();
  return existing;
}

module.exports = {
  normalizeUrl,
  cleanCopyText,
  jaccardSimilarity,
  computeContentHash,
  findDuplicate,
  mergeDuplicateIntoExisting,
};
