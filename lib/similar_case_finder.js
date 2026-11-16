'use strict';
/**
 * 上传截图 / 参考文案智能识图找同款引擎（0 费用离线版 + 100% 简繁中文扩词）
 * 功能：
 *  1) 接收上传截图 (Base64) 或参考文案/链接，调用 Windows 原生中文 OCR 读出图片里文字，并采样像素分析版式特征
 *  2) 自动判定对标版式（暧昧聊天对话截图 / 黑底走心热帖 / 白底语录字卡 / 女友视角实拍）
 *  3) 自动生成 6~10 个 100% 纯简体中文/繁体中文同款搜索词，喂给爬虫抓取相似案例
 *  4) 入库审核时给与同款版式和关键词高度吻合的中文热帖加权优先排序
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { isStrictlyChineseContent } = require('./collectors/base_collector');

const ROOT_DIR = path.join(__dirname, '..');
const OCR_PS1 = path.join(ROOT_DIR, 'scripts', 'ocr_and_visual_inspect.ps1');

// 简繁核心同款热词双向映射表（确保繁简两圈热帖同时抓全，且不含纯外文词）
const SIMP_TRAD_PAIRS = [
  ['聊天记录', '聊天紀錄'],
  ['对话截图', '對話截圖'],
  ['私信截图', '私訊截圖'],
  ['暧昧聊天', '曖昧聊天'],
  ['暧昧对话', '曖昧對話'],
  ['晕船', '暈船'],
  ['女友视角', '女友視角'],
  ['男友视角', '男友視角'],
  ['约会穿搭', '約會穿搭'],
  ['今日穿搭', '今日穿搭'],
  ['对镜自拍', '對鏡自拍'],
  ['甜妹日常', '甜妹'],
  ['睡不着聊天', '睡不著聊天'],
  ['有人还没睡吗', '有人還沒睡嗎'],
  ['想谈恋爱', '想談戀愛'],
  ['神回复', '神回覆'],
  ['语音连麦', '語音聊天'],
  ['脱单', '脫單'],
  ['搭讪', '搭訕'],
  ['恋爱语录', '戀愛語錄'],
  ['爱情语录', '愛情語錄'],
  ['交友软件', '交友軟體'],
];

const ARCHETYPE_PROFILES = {
  chat_screenshot: {
    label: '💬 暧昧聊天 / 私信对话截图同款',
    badge: '🎯 同款聊天截图',
    preferredMediaTypes: ['image', 'text', 'video'],
    seedKeywords: ['曖昧聊天紀錄', '對話截圖', '聊天截圖', '暧昧聊天记录', '深夜聊天', '暈船聊天紀錄', '私訊截圖', '神回覆'],
    matchRe: /聊天|對話|对话|私訊|私信|截圖|截图|已讀|已读|暈船|晕船|語音|语音|連麥|连麦|秒回|微信|訊息|回复|回覆/i,
  },
  dark_text_card: {
    label: '🌙 黑底走心热帖 / 深夜情感字卡同款',
    badge: '🎯 同款深夜热帖',
    preferredMediaTypes: ['image', 'text', 'video'],
    seedKeywords: ['睡不著聊天', '有人還沒睡嗎', '想談戀愛', '深夜聊天', '心動瞬間', '語音連麥', '曖昧语录', '爱情语录'],
    matchRe: /睡不著|睡不着|深夜|有人還沒睡|有人在嗎|失眠|孤單|孤独|語錄|语录|心動|心动|晚安|想你/i,
  },
  light_quote_card: {
    label: '📖 白底恋爱语录 / 情感金句卡片同款',
    badge: '🎯 同款语录字卡',
    preferredMediaTypes: ['image', 'text', 'video'],
    seedKeywords: ['戀愛語錄', '愛情語錄', '恋爱语录', '神回覆', '心動瞬間', '曖昧語錄', '直男脫單', '交友軟體配對'],
    matchRe: /語錄|语录|文案|句子|金句|道理|戀愛|恋爱|愛情|爱情|曖昧|暧昧|男生|女生/i,
  },
  girlfriend_pov_photo: {
    label: '📸 女友视角 / 高颜值穿搭日常同款',
    badge: '🎯 同款女友视角',
    preferredMediaTypes: ['video', 'image'],
    seedKeywords: ['女友視角', '約會穿搭', '今日穿搭', '對鏡自拍', '甜妹日常', '男友視角', '女友视角', '約會日常'],
    matchRe: /女友視角|女友视角|女友感|男友視角|穿搭|自拍|對鏡拍|甜妹|御姐|姐姐感|約會|约会|顏值|颜值/i,
  },
};

const STOP_CHINESE_WORDS = new Set([
  '这是什么', '什么意思', '为什么', '有没有', '我们可以', '大家一起', '今天晚上', '一个人',
  '不知道', '是不是', '要不要', '差不多', '其实我', '真的好', '的时候', '看起来',
  '因为我', '所以说', '但是我', '然后就', '哈哈哈', '啊啊啊',
]);

function normalizeOcrChineseText(raw = '') {
  let s = String(raw || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\b(?:5G|4G|3G|LTE|Wi-?Fi|HD|VOLTE|AM|PM)\b/gi, ' ')
    .replace(/\b\d{1,3}%\b/g, ' ')
    .replace(/(?:上午|下午|凌晨|中午)\s*\d{1,2}:\d{2}/g, ' ')
    .trim();
  // Windows OCR 会在中文字符和中文标点之间插空格，连续压缩两次还原完整中文词句
  const cjkSpaceRe = /([\u4e00-\u9fff\u3400-\u4dbf，。！？；：、（）「」『』【】…—])\s+([\u4e00-\u9fff\u3400-\u4dbf，。！？；：、（）「」『』【】…—])/g;
  s = s.replace(cjkSpaceRe, '$1$2').replace(cjkSpaceRe, '$1$2');
  return s.replace(/\s+/g, ' ').trim();
}

function runLocalVisualInspect(filePaths = []) {
  return new Promise((resolve) => {
    const valid = (filePaths || []).filter((p) => p && fs.existsSync(p));
    if (!valid.length || !fs.existsSync(OCR_PS1)) return resolve([]);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, ...valid],
      { cwd: ROOT_DIR, windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const txt = String(stdout || '').trim();
        const idx = txt.indexOf('{');
        if (idx < 0) return resolve([]);
        try {
          const parsed = JSON.parse(txt.slice(idx));
          return resolve(Array.isArray(parsed.items) ? parsed.items : []);
        } catch (_) {
          return resolve([]);
        }
      }
    );
  });
}

function resolveCoverFileAbsPath(coverUrl = '') {
  const clean = String(coverUrl || '').trim();
  if (!clean) return '';
  if (clean.startsWith('./covers/') || clean.startsWith('/covers/') || clean.startsWith('covers/')) {
    const rel = clean.replace(/^\.?\//, '');
    const abs = path.join(ROOT_DIR, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return '';
}

function classifyVisualArchetype(combinedText, inspectItems = []) {
  const txt = String(combinedText || '');
  const hanziCount = (txt.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const maxDark = inspectItems.reduce((m, x) => Math.max(m, Number(x.darkRatio || 0)), 0);
  const maxLight = inspectItems.reduce((m, x) => Math.max(m, Number(x.lightRatio || 0)), 0);
  const maxBubbles = inspectItems.reduce((m, x) => Math.max(m, Number(x.bubbleTransitions || 0)), 0);
  const maxSkin = inspectItems.reduce((m, x) => Math.max(m, Number(x.skinRatio || 0)), 0);

  const hasChatWords = /聊天|對話|对话|私訊|私信|已讀|已读|語音|语音|連麥|连麦|暈船|晕船|截圖|截图|發消息|发消息|訊息|早安|晚安|想你|睡不著|睡不着|在幹嘛|在干嘛|喝點|出來嗎|出来吗/i.test(txt);
  const hasDialogPunc = /[:：]|我：|他：|她：|女：|男：/.test(txt);
  const hasPovWords = /女友視角|女友视角|女友感|男友視角|穿搭|自拍|對鏡拍|对镜拍|甜妹|御姐|OOTD|姐妹|約會裝|约会穿/i.test(txt);
  const hasQuoteWords = /語錄|语录|句子|愛情|爱情|戀愛|恋爱|情感|金句|如果一個男生|女生喜歡|安全感/i.test(txt);

  if (hasPovWords && maxBubbles < 6 && !hasChatWords) {
    return 'girlfriend_pov_photo';
  }
  if ((hasChatWords && (maxBubbles >= 3 || hasDialogPunc || hanziCount >= 6)) || maxBubbles >= 7) {
    return 'chat_screenshot';
  }
  if (maxDark >= 0.45 && hanziCount >= 4 && maxSkin < 0.28) {
    return 'dark_text_card';
  }
  if (maxLight >= 0.50 && hanziCount >= 4 && maxSkin < 0.25) {
    return hasChatWords ? 'chat_screenshot' : 'light_quote_card';
  }
  if (hasQuoteWords) {
    return maxDark > maxLight ? 'dark_text_card' : 'light_quote_card';
  }
  if (hasChatWords) {
    return 'chat_screenshot';
  }
  if (!inspectItems.length && hanziCount >= 4) {
    return /晚安|睡不著|睡不着|深夜|失眠/.test(txt) ? 'dark_text_card' : 'chat_screenshot';
  }
  return 'girlfriend_pov_photo';
}

function expandWithSimpTrad(words = []) {
  const out = [];
  const seen = new Set();
  const addWord = (w) => {
    const clean = String(w || '').trim();
    if (!clean || clean.length < 2 || clean.length > 16) return;
    if (!/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/.test(clean)) return;
    if (!isStrictlyChineseContent(clean) && !/[\u4e00-\u9fff]{2,}/.test(clean)) return;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  };

  for (const w of words) {
    addWord(w);
    for (const [simp, trad] of SIMP_TRAD_PAIRS) {
      if (w.includes(simp)) addWord(w.replace(simp, trad));
      if (w.includes(trad)) addWord(w.replace(trad, simp));
    }
  }
  return out;
}

function extractSimilarChineseKeywords(combinedText = '', archetype = 'chat_screenshot') {
  const txt = String(combinedText || '');
  const extracted = [];

  // 1. 提取文本中携带的中文 #话题标签
  const hashMatches = txt.match(/#([\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9_]{2,14})/g) || [];
  for (const tag of hashMatches) {
    const cleanTag = tag.slice(1).trim();
    if (/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/.test(cleanTag)) {
      extracted.push(cleanTag);
    }
  }

  // 2. 根据图片 OCR 与描述文本的场景情绪词精准派生同类华语热词
  const intentRules = [
    { re: /晚安|睡前|還沒睡|还没睡|睡不著|睡不着|失眠|凌晨|深夜/, terms: ['睡前聊天', '睡不著聊天', '有人還沒睡嗎', '深夜陪伴'] },
    { re: /語音|语音|連麥|连麦|講電話|打电话|掛睡|声音|聲音/, terms: ['語音連麥', '語音聊天', '連麥哄睡', '语音匹配'] },
    { re: /聊天|對話|对话|私訊|私信|消息|訊息|秒回|已讀|已读/, terms: ['曖昧聊天紀錄', '對話截圖', '聊天截圖', '神回覆'] },
    { re: /暈船|晕船|曖昧|暧昧|心動|心动|撩|情話|想你|抱抱/, terms: ['暈船聊天紀錄', '心動瞬間', '曖昧語錄', '恋爱语录'] },
    { re: /交友|配對|配对|右滑|左滑|軟體|软件|奔現|奔现|網戀|网恋/, terms: ['交友軟體配對', '交友軟體', '網戀奔現', '脱单'] },
    { re: /女友|男友|穿搭|自拍|對鏡|对镜|甜妹|御姐|好看|漂亮|約會|约会/, terms: ['女友視角', '約會穿搭', '甜妹日常', '今日穿搭'] },
    { re: /搭訕|搭讪|要ig|微信|認識女生|认识女生|追女生|直男|脫單|脱单/, terms: ['搭訕', '要IG', '脫單日常', '直男脫單'] },
    { re: /語錄|语录|愛情|爱情|戀愛|恋爱|心事|安全感/, terms: ['戀愛語錄', '愛情語錄', '想談戀愛', '心動瞬間'] },
  ];
  for (const rule of intentRules) {
    if (rule.re.test(txt)) {
      extracted.push(...rule.terms);
    }
  }

  // 3. 提取短句中最核心的 2~6 字中文实体片段（如用户直接贴了一句话/截图内核心金句词）
  const segments = txt
    .replace(/#[^\s#]+/g, ' ')
    .split(/[\s,，。！？!?；;：:、（）()「」『』【】"'~～]+/)
    .map((x) => x.trim())
    .filter((x) => /^[\u4e00-\u9fff\u3400-\u4dbf]{2,7}$/.test(x) && !STOP_CHINESE_WORDS.has(x));
  for (const seg of segments.slice(0, 6)) {
    extracted.push(seg);
  }

  // 4. 补足该版式的必抓基础繁简词，控制总数在 6~10 个精准搜索词
  const prof = ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.chat_screenshot;
  const expanded = expandWithSimpTrad([...extracted, ...prof.seedKeywords]);
  const finalKeywords = expanded.slice(0, 9);

  // matchTokens 用于抓回来之后判定同款相似度加权
  const matchTokens = Array.from(new Set([
    ...expandWithSimpTrad(extracted),
    ...finalKeywords,
  ])).slice(0, 18);

  return { suggestedKeywords: finalKeywords, matchTokens };
}

/**
 * 主入口：分析上传的图片/截图/链接/参考文案，产出同款版式画像与纯简繁中文搜词清单
 */
async function analyzeReferenceForSimilarCrawl({ imagesBase64 = [], referenceText = '', url = '', db = null } = {}) {
  const coverCache = require('./cover_cache');
  const mediaExtractor = require('./media_extractor');
  const proxyPool = require('./proxy_pool');

  const imgs = Array.isArray(imagesBase64) ? imagesBase64.slice(0, 4).filter(Boolean) : [];
  const savedCovers = [];
  const absPaths = [];

  for (let i = 0; i < imgs.length; i++) {
    const raw = String(imgs[i] || '').trim();
    if (raw.startsWith('data:image/')) {
      const rel = coverCache.saveDataUriCover(raw, `ref_${Date.now().toString(36)}_${i}`);
      if (rel) {
        savedCovers.push(rel);
        const abs = resolveCoverFileAbsPath(rel);
        if (abs) absPaths.push(abs);
      }
    } else {
      const abs = resolveCoverFileAbsPath(raw);
      if (abs) {
        savedCovers.push(raw);
        absPaths.push(abs);
      }
    }
  }

  let urlText = '';
  const cleanUrl = String(url || '').trim();
  if (cleanUrl) {
    try {
      const proxy = proxyPool.selectProxyForPlatform('instagram', []);
      const info = await mediaExtractor.extractFromUrl(cleanUrl, proxy, 'case');
      if (info) {
        urlText = `${info.title || ''} ${info.fullText || ''}`.trim();
        if (!absPaths.length && info.coverUrl) {
          const cachedRel = await coverCache.cacheCoverImage(info.coverUrl, `ref_url_${Date.now().toString(36)}`);
          const abs = resolveCoverFileAbsPath(cachedRel);
          if (abs) {
            savedCovers.push(cachedRel);
            absPaths.push(abs);
          }
        }
      }
    } catch (_) { /* 链接解析失败不阻断图片或文案识图 */ }
  }

  const inspectItems = await runLocalVisualInspect(absPaths);
  const rawOcr = inspectItems.map((x) => x.ocrText || '').filter(Boolean).join(' ');
  const ocrText = normalizeOcrChineseText(rawOcr);
  const cleanRefText = normalizeOcrChineseText(referenceText);
  const cleanUrlText = normalizeOcrChineseText(urlText);
  const combinedText = [ocrText, cleanRefText, cleanUrlText].filter(Boolean).join(' ').trim();

  if (!imgs.length && !cleanRefText && !cleanUrl) {
    throw new Error('请至少上传一张参考图片/截图，或输入一段参考文案再提取同款特征！');
  }

  const visualArchetype = classifyVisualArchetype(combinedText, inspectItems);
  const archInfo = ARCHETYPE_PROFILES[visualArchetype] || ARCHETYPE_PROFILES.chat_screenshot;
  const { suggestedKeywords, matchTokens } = extractSimilarChineseKeywords(combinedText, visualArchetype);

  const summaryParts = [];
  summaryParts.push(archInfo.label);
  if (ocrText) summaryParts.push(`图内识别文字：「${ocrText.slice(0, 68)}${ocrText.length > 68 ? '…' : ''}」`);
  else if (cleanRefText) summaryParts.push(`参考文案：「${cleanRefText.slice(0, 68)}${cleanRefText.length > 68 ? '…' : ''}」`);

  return {
    visualArchetype,
    visualArchetypeLabel: archInfo.label,
    similarityBadge: archInfo.badge,
    ocrText,
    referenceSummary: summaryParts.join(' ｜ '),
    suggestedKeywords,
    matchTokens,
    preferredMediaTypes: archInfo.preferredMediaTypes,
    savedCovers,
    inspectStats: inspectItems.map((x) => ({
      width: x.width,
      height: x.height,
      darkRatio: x.darkRatio,
      lightRatio: x.lightRatio,
      bubbleTransitions: x.bubbleTransitions,
    })),
  };
}

/**
 * 抓取审核阶段对候选样本计算与上传参照案例的相似度加分 (0 ~ 18 分)
 */
function computeSimilarityBoost(candidate = {}, referenceProfile = null) {
  if (!referenceProfile || !referenceProfile.visualArchetype) {
    return { boost: 0, tag: '' };
  }
  const arch = ARCHETYPE_PROFILES[referenceProfile.visualArchetype] || ARCHETYPE_PROFILES.chat_screenshot;
  const corpus = `${candidate.title || ''} ${candidate.fullText || ''} ${candidate.sourceKeyword || ''}`.toLowerCase();
  const media = candidate.mediaType || 'video';

  let boost = 0;
  const prefList = Array.isArray(referenceProfile.preferredMediaTypes) ? referenceProfile.preferredMediaTypes : arch.preferredMediaTypes;
  if (prefList[0] === media) boost += 5;
  else if (prefList.includes(media)) boost += 3;

  if (arch.matchRe && arch.matchRe.test(corpus)) {
    boost += 5;
  }

  let tokenHits = 0;
  for (const tok of referenceProfile.matchTokens || []) {
    if (tok && corpus.includes(String(tok).toLowerCase())) {
      tokenHits += 1;
      if (tokenHits >= 4) break;
    }
  }
  boost += tokenHits * 2;
  boost = Math.min(18, boost);

  return {
    boost,
    tag: boost >= 6 ? (referenceProfile.similarityBadge || arch.badge) : '',
  };
}

module.exports = {
  normalizeOcrChineseText,
  analyzeReferenceForSimilarCrawl,
  computeSimilarityBoost,
};
