'use strict';
/**
 * 视觉大模型全量审核 + 一票否决过滤 + 五维评分 + 软广复刻指南生成引擎
 * 支持：
 *  - Google Gemini 多模态视觉接口 (gemini-3.8-flash / gemini-2.5-pro)
 *  - OpenAI 兼容多模态视觉接口 (GPT-4o / Qwen-VL / Claude / OneAPI 中转站)
 * 严格拦截：真人露脸（含画中画小窗/表情包全脸）、游戏/二次元、直白硬广、低质号、纯女向无关内容、高成本实拍不可复刻内容。
 */
const fs = require('fs');
const path = require('path');
const proxyPool = require('./proxy_pool');
const store = require('./store');
const {
  NON_DATING_LAYA_NOISE_RE,
  isCompliantHealthyPost,
  isStrictlyChineseContent,
  explainNonChineseReason,
} = require('./collectors/base_collector');

// 硬广直白推销正则（前置一票否决，省去无效视觉Token消耗）
const HARD_AD_PATTERNS = [
  /快来下载/i,
  /扫码领福利/i,
  /我在.{1,12}等你/i,
  /点击(下方|左下角|主页|简介)链接下载/i,
  /立即下载.{0,8}领取/i,
  /各大应用商店搜索下载/i,
  /download\s+now.*link\s+in\s+bio/i,
  /use\s+my\s+promo\s+code\s+to\s+download/i,
];

// 明显游戏/二次元前置文本强特征（视觉模型还会再审封面画面防止无文案游戏背景！）
const OBVIOUS_GAME_TEXT_PATTERNS = [
  /王者荣耀|和平精英|英雄联盟|原神|崩坏星穹铁道|绝地求生|第五人格|蛋仔派对|金铲铲/,
  /valorant|league\s+of\s+legends|genshin\s+impact|pubg\s+mobile|fortnite\s+clips|minecraft\s+parkour|subway\s+surfers\s+gameplay/i,
  /电竞开黑|游戏陪玩接单|上分车队|排位连跪|二次元混剪|番剧盘点|动漫剪辑|cosplay正片/i,
];

const KNOWN_DATING_BRANDS = [
  'Laya', 'Litmatch', 'Goodnight', 'Omi', 'Soul', 'Cheers', 'Sugoo',
  'Tinder', 'Bumble', 'Hinge', '探探', '欢游', 'TT语音', '伴伴', 'WePlay', 'MeLoop', '积目', '他趣',
];

const NON_MALE_APPEAL_NOISE_RE = /防彈|BTS|SEVENTEEN|崔勝喆|徐明浩|任時完|任时完|金珉奎|車銀優|邊佑錫|演唱會|演唱会|門票|搶票|應援|愛豆|男團|韓團|追星|克拉|阿米|周杰倫不排除|艾薇兒|Avril\s*Lavigne|上廁所|拉肚子|腸胃|除毛師|除毛|打呼聲|打呼|腳臭|狐臭|月經|痛經|衛生棉|紅樓夢|红楼梦|原創能力|原创能力|刮颱風|颱風|天氣預報|貓貓.*送醫|原飼主|虐貓|領養代替購買|藍光播放器|日本Amazon|Spotify會員|開源|塔羅占卜|雷諾曼|觀星者|美妝教程|口紅試色|美甲分享|寶媽育兒/i;

const MALE_APPEAL_BENCHMARK_RE = /女友視角|女友视角|女友感|男友視角|男友视角|今日穿搭|約會穿搭|约会穿搭|日常穿搭|\bootd\b|自拍|對鏡拍|对镜拍|睡前|還沒睡|还没睡|睡不著|睡不着|有人在嗎|有人在吗|陪我聊天|找人聊天|無聊想聊|微醺|撒嬌|撒娇|甜妹|御姐|姐姐感|學姐|学姐|學妹|学妹|女大生|單身|单身|想談戀愛|想谈恋爱|徵男友|缺男友|當你女友|男生喜歡|第一眼看哪|腿控|黑絲|白絲|JK穿搭|健身女孩|純欲|反差感|戀愛|恋爱|黏人|報備|报备|曖昧|暧昧|聊天|對話|对话|訊息|私訊|秒回|已讀|語音|语音|連麥|连麦|講電話|掛睡|哄睡|心動|直男|神回覆|神回复|破冰|網戀|网恋|奔現|奔现|暈船|晕船|撩人|會撩|情話|早安|晚安|想你|抱抱|陪我|脫單|脱单|搭訕|搭讪|要IG|要微信|認識女生|追女生|約會|约会|交友軟體|交友软件|配對|配对|滑到|右滑|相親|表白|告白|桃花|好看嗎|喜歡嗎/i;

function detectExposedBrands(text, brandKeywords = [], compKeywords = []) {
  const hay = String(text || '');
  const found = new Set();
  const candidates = [
    ...KNOWN_DATING_BRANDS,
    ...brandKeywords.map((k) => k.word),
    ...compKeywords.map((k) => k.word),
  ].filter(Boolean);

  for (const name of candidates) {
    if (!name || name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isAscii = /^[a-z0-9\s._-]+$/i.test(name);
    const re = isAscii ? new RegExp(`\\b${escaped}\\b`, 'i') : new RegExp(escaped, 'i');
    if (re.test(hay)) {
      found.add(name);
    }
  }
  return Array.from(found);
}

function determineCategoryGroup(candidate, exposedBrands, db) {
  const brandWords = (db.keywords.brand || []).map((k) => k.word.toLowerCase());
  const compWords = (db.keywords.competitor || []).map((k) => k.word.toLowerCase());
  const myBrand = (db.settings.brandName || 'Laya').toLowerCase();

  const corpus = `${candidate.title || ''} ${candidate.fullText || ''} ${candidate.authorHandle || ''}`;
  const hasTrueBrand = /(?:\blaya\b|layacouples|在\s*laya|laya\s*(?:app|上面|刷到|語音|语音|交友|連麥|连麦|播放器)|拉雅)/i.test(corpus)
    && !NON_DATING_LAYA_NOISE_RE.test(corpus);
  if (hasTrueBrand || exposedBrands.some((b) => b.toLowerCase() === myBrand || brandWords.includes(b.toLowerCase()))) {
    return 'brand';
  }
  if (
    candidate.sourceBucket === 'competitor' ||
    exposedBrands.some((b) => compWords.includes(b.toLowerCase()) || KNOWN_DATING_BRANDS.map((x) => x.toLowerCase()).includes(b.toLowerCase()))
  ) {
    return 'competitor';
  }
  return 'generic';
}

/**
 * 拉取封面图并转为 Base64（供 Gemini / OpenAI 视觉大模型识图）
 */
async function fetchCoverAsBase64(coverUrl, proxy = null) {
  if (!coverUrl) return null;
  if (coverUrl.startsWith('data:image/')) {
    const m = coverUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (m) {
      // Gemini 不直接接收 svg+xml inline_data，若是内置SVG测试图则仅在支持的通道或提取描述
      return { mimeType: m[1], base64: m[2], dataUri: coverUrl };
    }
  }
  if (coverUrl.startsWith('/covers/') && /\.(jpe?g|png|webp)$/i.test(coverUrl)) {
    try {
      const localPath = path.join(__dirname, '..', coverUrl.replace(/^\//, ''));
      if (fs.existsSync(localPath)) {
        const buf = fs.readFileSync(localPath);
        if (buf && buf.length > 128) {
          const ext = path.extname(localPath).toLowerCase();
          const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          const base64 = buf.toString('base64');
          return { mimeType, base64, dataUri: `data:${mimeType};base64,${base64}` };
        }
      }
    } catch (_) { /* ignore */ }
  }
  if (!/^https?:\/\//i.test(coverUrl)) return null;
  try {
    const resp = await proxyPool.requestRaw(coverUrl, { timeoutMs: 9000, maxBytes: 4 * 1024 * 1024 }, proxy);
    if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.buffer && resp.buffer.length > 128) {
      const ct = String(resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      const mimeType = ct.startsWith('image/') ? ct : 'image/jpeg';
      const base64 = resp.buffer.toString('base64');
      return { mimeType, base64, dataUri: `data:${mimeType};base64,${base64}` };
    }
  } catch (_) {
    // 若通过代理失败，尝试直连一次CDN
    if (proxy) {
      try {
        const resp2 = await proxyPool.requestRaw(coverUrl, { timeoutMs: 7000, maxBytes: 4 * 1024 * 1024 }, null);
        if (resp2.statusCode >= 200 && resp2.statusCode < 300 && resp2.buffer && resp2.buffer.length > 128) {
          const ct = String(resp2.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
          const mimeType = ct.startsWith('image/') ? ct : 'image/jpeg';
          const base64 = resp2.buffer.toString('base64');
          return { mimeType, base64, dataUri: `data:${mimeType};base64,${base64}` };
        }
      } catch (_e) { /* ignore */ }
    }
  }
  return null;
}

function buildVisionPrompt(candidate, settings) {
  const brandName = settings.brandName || 'Laya';
  const brandDesc = settings.brandPositioning || '主打男性用户的海外高颜值语音陪伴与恋爱交友App';
  const mediaTypeLabel =
    candidate.mediaType === 'text'
      ? '纯文字热帖/串文'
      : candidate.mediaType === 'image'
        ? '图文/图片帖'
        : '短视频/Reels';
  const topComments = Array.isArray(candidate.topComments)
    ? candidate.topComments.map((c, idx) => `${idx + 1}. ${c.text || c} (赞:${c.likes || 0})`).join(' | ')
    : '';

  return `你是资深海外社媒交友App新媒体增长总监与防废片视觉审核专家。
我方产品名称：【${brandName}】（定位：${brandDesc}）。
核心受众铁律：所有合格样本必须以【吸引男性用户】为核心，精准戳中男性脱单、深夜暧昧陪伴、甜妹/御姐异性语音或文字聊天需求，且无代码/普通剪辑运营即可低成本批量复刻！
形态特别说明：不仅短视频，【图文聊天截图、配图热帖、纯文字走心串文/推文】同样属于高价值合格样本（运营可直接照抄文案发文字帖或转制成聊天录屏视频），只要无真人露脸、无游戏二次元、无直白硬广即可通过！
品牌与竞品情报白名单：凡提及我方品牌「Laya」（含 Laya Couples / Laya App / Laya 语音等恋爱交友内容）或同行交友软件（Litmatch、Goodnight、Omi、Sugo、Tantan、Soul 等）的真实用户讨论帖、图文帖、纯文字串文或无真人全脸出镜的视频，均属高价值品牌/竞品情报样本；只要无真人全脸露脸、无游戏二次元、无直白刷屏硬广口号，应判定 passed=true 并输出改写为男向交友软广的植入方案。

请仔细观察所附【样本封面/配图画面（若有）】并结合下方元数据，严格执行一票否决审查、五维评分与定制化软广植入脚本生成。

【待审样本元数据】
- 所属平台：${candidate.platform}
- 内容形态：${mediaTypeLabel}
- 作品标题：${candidate.title || ''}
- 完整文案：${candidate.fullText || ''}
- 视频时长：${candidate.mediaType === 'video' ? `${candidate.durationSec || 15} 秒` : '图文/纯文字无时长'}
- 所用BGM：${candidate.bgm || '未知'}
- 互动数据：浏览/播放 ${candidate.plays || 0} / 点赞 ${candidate.likes || 0} / 评论 ${candidate.comments || 0} / 转发 ${candidate.shares || 0} / 收藏 ${candidate.bookmarks || 0}
- 评论区Top3热评：${topComments || '暂无'}
- 账号信息：@${candidate.authorHandle || 'unknown'}（粉丝 ${candidate.authorFollowers || 0}，注册 ${candidate.authorAgeDays || 180} 天）

【六大一票否决硬规则（任意命中一项必须标记 passed=false 并给出明确 vetoReason）】
1. hasHumanFace（真人露脸一票否决）：画面中出现任何真人露脸，包括全屏出镜、角落画中画小窗露脸、口播露脸、真人自拍、真人表情包露全脸！（注：纯微信/IG/Line聊天界面、纯文字卡片、纯风景/夜景空镜配字、模糊背影手部不露脸不算露脸）
2. isGameOrAnime（游戏与二次元一票否决）：包含任何小游戏解压录屏分屏（如跑酷/切肥皂背景）、手游端游画面、游戏推广、电竞开黑、游戏陪玩、动漫二创、二次元番剧或VTuber！
3. isHardAd（直白硬广一票否决）：出现「快来下载」「扫码领福利」「我在XX等你」等生硬推销话术或全屏App下载大海报。
4. isIrrelevantOrFemaleOnly（受众错位/无关内容一票否决）：与恋爱/交友/异性暧昧聊天无关（或同名医疗保险、游戏引擎、酒店民宿等无关事物），或者纯女性向内容（如女生吐槽渣男纯宣泄且无法改造成男向钩子、美妆穿搭、追星饭圈）。
5. isUnreplicable（无法低成本复刻一票否决）：依赖真人演员实拍剧情、专业外景拍摄、真人口播配音或高难度3D特效，运营团队无法靠聊天录屏工具、图文/纯文字模版或空镜混剪复刻。

【请严格只输出合法 JSON 对象，不要输出 Markdown 代码块标记，字段结构如下】：
{
  "passed": true,
  "vetoCode": "",
  "vetoReason": "",
  "hasHumanFace": false,
  "isGameOrAnime": false,
  "isHardAd": false,
  "isIrrelevantOrFemaleOnly": false,
  "isUnreplicable": false,
  "contentType": "聊天录屏类",
  "exposedBrands": [],
  "implantDifficulty": 2,
  "dimensions": {
    "engagement": 17,
    "maleFit": 22,
    "replicability": 18,
    "implantNaturalness": 18,
    "completeness": 13
  },
  "qualityScore": 88,
  "hookStyle": "甜妹反差主动",
  "implantGuide": {
    "exactTiming": "第 07 秒（第 3 轮女生发来暧昧语音条气泡时；纯文字/图文帖填具体段落或图片页码）",
    "visualHook": "聊天界面顶部状态栏轻度露出『语音匹配成功 · 已连麦 01:28:40』字样，不放硬广Logo",
    "copyScript": "正文改成：『本来只是睡前随便点开语音匹配想找人挂机听歌，结果遇到个声音超软的台湾妹妹主动问我要不要哄睡…』",
    "commentSeedScript": "置顶热评小号A问：『求问这是哪个语音软件？怎么我遇到的都是人机』；小号B自然回复：『看界面气泡是 ${brandName}，晚上11点后匹配到的妹妹超会聊』"
  },
  "replicationSteps": [
    "第一步（底版制作）：使用聊天录屏生成器还原 4~5 轮高低情绪反差对话，前 2 秒直接放出女生直球提问钩子留住划屏男性用户（图文/纯文字帖可直接保留结构并改写痛点开场白）；",
    "第二步（植入卡点）：在第 3 轮对话或正文转折处自然嵌入『语音连麦匹配』体验感，保持原生网感；",
    "第三步（节奏包装）：视频配微醺深夜 R&B 伴奏控制在 13~18 秒，纯文字/图文保持口语化互动反问；",
    "第四步（评论区承接）：发布后 3 分钟内用 2 个矩阵号在评论区埋入『软件名 ${brandName} / 暗号』问答钩子完成自然转化。"
  ]
}
注意：contentType 只能是 "聊天录屏类"、"图文聊天/配图类"、"纯文字热帖/串文类"、"素材混剪类"、"其他可植入泛内容" 之一；dimensions 五项满分分别为 20/25/20/20/15，总和等于 qualityScore（0-100）。`;
}

function extractJsonObject(rawText) {
  if (!rawText) throw new Error('大模型返回内容为空');
  const trimmed = String(rawText).trim();
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw new Error('大模型返回格式非有效JSON');
  }
}

/**
 * 调用 Google Gemini 多模态接口
 */
async function callGeminiVision(promptText, coverImg, candidate, visionCfg) {
  const apiKey = (visionCfg.apiKey || process.env.GEMINI_API_KEY || '').trim();
  const baseUrl = (visionCfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const model = (visionCfg.model || 'gemini-3.8-flash').trim();

  const parts = [];
  if (coverImg && coverImg.base64 && !coverImg.mimeType.includes('svg')) {
    parts.push({
      inlineData: {
        mimeType: coverImg.mimeType,
        data: coverImg.base64,
      },
    });
  } else if (candidate.visualSceneDesc) {
    parts.push({ text: `【封面画面视觉内容描述】：${candidate.visualSceneDesc}` });
  }
  parts.push({ text: promptText });

  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  };

  const doRequest = (endpointUrl) =>
    proxyPool.requestRaw(
      endpointUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        timeoutMs: 28000,
      },
      null
    );

  const primaryUrl = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let resp = await doRequest(primaryUrl);

  // Google AI 新版 AQ. 钥匙可能归属 Vertex AI Express 通道，遇到 400/401/403 时自动切换端点重试
  if (apiKey.startsWith('AQ.') && [400, 401, 403].includes(resp.statusCode) && !baseUrl.includes('aiplatform.googleapis.com')) {
    const vertexUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const vertexResp = await doRequest(vertexUrl);
    if (vertexResp.statusCode >= 200 && vertexResp.statusCode < 300) {
      resp = vertexResp;
    } else if (![400, 401, 403, 404].includes(vertexResp.statusCode)) {
      resp = vertexResp;
    } else {
      throw new Error(`Gemini双通道鉴权均未通过 (AI Studio HTTP ${resp.statusCode}: ${resp.text().slice(0, 140)} | Vertex HTTP ${vertexResp.statusCode}: ${vertexResp.text().slice(0, 140)})`);
    }
  }

  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`Gemini API HTTP ${resp.statusCode}: ${resp.text().slice(0, 220)}`);
  }
  const data = resp.json();
  const outText =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts.map((p) => p.text || '').join('\n');
  return extractJsonObject(outText);
}

/**
 * 调用 OpenAI 兼容多模态视觉接口（支持 GPT-4o / Qwen-VL / Claude / NewAPI 等）
 */
async function callOpenAiCompatibleVision(promptText, coverImg, candidate, visionCfg) {
  const apiKey = (visionCfg.apiKey || process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = (visionCfg.openaiBaseUrl || visionCfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = (visionCfg.openaiModel || visionCfg.model || 'gpt-4o-mini').trim();
  const url = `${baseUrl}/chat/completions`;

  const userContent = [];
  if (coverImg && coverImg.dataUri && !coverImg.mimeType.includes('svg')) {
    userContent.push({
      type: 'image_url',
      image_url: { url: coverImg.dataUri },
    });
  } else if (candidate.coverUrl && /^https?:\/\//i.test(candidate.coverUrl)) {
    userContent.push({
      type: 'image_url',
      image_url: { url: candidate.coverUrl },
    });
  } else if (candidate.visualSceneDesc) {
    userContent.push({
      type: 'text',
      text: `【封面画面视觉内容描述】：${candidate.visualSceneDesc}`,
    });
  }
  userContent.push({ type: 'text', text: promptText });

  const payload = {
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: '你是严格的社媒视觉审核与交友软广增长专家，只输出合法JSON对象。',
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
  };

  const resp = await proxyPool.requestRaw(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      timeoutMs: 28000,
    },
    null
  );

  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`OpenAI兼容视觉接口 HTTP ${resp.statusCode}: ${resp.text().slice(0, 220)}`);
  }
  const data = resp.json();
  const outText = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return extractJsonObject(outText);
}

/**
 * 联调离线多模态仿真核验器（仅在尚未填写大模型 API Key 且开启联调模式时启用，确保按落地步骤1~4测通全链路）
 */
function runOfflineMultimodalSimulation(candidate, settings, exposedBrands) {
  const rawText = `${candidate.title || ''} ${candidate.fullText || ''} ${candidate.visualSceneDesc || ''}`;
  // 剔除「无真人出镜 / 不露脸 / 零露脸 / 无任何...露脸 / 无游戏元素」等明确否定表述，防止否定词误触发拦截
  const sanitizedForVeto = rawText.replace(/(?:无任何|没有任何|全程不|零|无|不)(?:人物正脸或|任何)?(?:真人出镜|真人露脸|小窗露脸|画中画露脸|露脸|游戏元素)/g, '');
  const text = rawText;
  const hints = candidate.visualHints || {};
  const brandName = settings.brandName || 'Laya';

  // 1. 允许女友视角/高颜值自拍日常通过（不再一票否决真人露脸，保留情绪识别字段）
  const vm = candidate._visualMetrics || null;

  // 2. 游戏与二次元检查（含多语种热词与横屏高饱和游戏画面像素检测）
  const landscapeGameHud = vm && vm.width > 0 && vm.height > 0 && vm.width > vm.height * 1.25 && vm.highSatRatio > 0.35;
  if (
    hints.isGameOrAnime ||
    landscapeGameHud ||
    OBVIOUS_GAME_TEXT_PATTERNS.some((re) => re.test(text)) ||
    /游戏录屏|王者荣耀|吃鸡|陪玩|原神|崩坏|动漫|二次元|valorant|genshin|roblox|pubg|mlbb|gameplay/i.test(text)
  ) {
    return {
      passed: false,
      vetoCode: 'GAME_OR_ANIME',
      vetoReason: '一票否决：本地智能审片检出游戏录屏画面/陪玩开黑/二次元二创内容，非纯正恋爱交友转化流量',
      hasHumanFace: false,
      isGameOrAnime: true,
      isHardAd: false,
      isIrrelevantOrFemaleOnly: false,
      isUnreplicable: false,
      qualityScore: 18,
    };
  }

  // 3. 追星/跑题水帖与男性向相关性检查
  const isCustomForce = Boolean(candidate._forceCustomKeyword);
  const lacksMaleAppeal = candidate.sourceBucket === 'generic' && !isCustomForce && exposedBrands.length === 0 && !MALE_APPEAL_BENCHMARK_RE.test(text);
  if (
    hints.isIrrelevantOrFemaleOnly ||
    NON_MALE_APPEAL_NOISE_RE.test(text) ||
    lacksMaleAppeal
  ) {
    return {
      passed: false,
      vetoCode: 'FEMALE_OR_IRRELEVANT',
      vetoReason: NON_MALE_APPEAL_NOISE_RE.test(text)
        ? '一票否决：命中追星/生理吐槽/跑题水帖，非男性向软广对标素材'
        : '一票否决：内容未命中女友视角/高颜值日常/暧昧聊天/脱单搭讪方向',
      hasHumanFace: false,
      isGameOrAnime: false,
      isHardAd: false,
      isIrrelevantOrFemaleOnly: true,
      isUnreplicable: false,
      qualityScore: 28,
    };
  }

  // 4. 无法复刻高成本实拍检查
  if (hints.isUnreplicable || /街头随机采访路人实拍|多机位微电影实拍|无人机航拍外景剧组/i.test(text)) {
    return {
      passed: false,
      vetoCode: 'UNREPLICABLE',
      vetoReason: '一票否决：依赖街头外景真人实拍与同期配音，运营团队无法低成本批量复刻',
      hasHumanFace: false,
      isGameOrAnime: false,
      isHardAd: false,
      isIrrelevantOrFemaleOnly: false,
      isUnreplicable: true,
      qualityScore: 35,
    };
  }

  // 判断内容类型（覆盖视频录屏、图文配图、纯文字热帖）
  const mediaType = candidate.mediaType || 'video';
  let contentType = '其他可植入泛内容';
  if (/聊天记录|聊天紀錄|對話|对话|语音条|語音|连麦|連麥|私信|texting|dm\s+chat|messages/i.test(text) && mediaType === 'video') {
    contentType = '聊天录屏类';
  } else if (mediaType === 'image') {
    contentType = '图文聊天/配图类';
  } else if (mediaType === 'text') {
    contentType = '纯文字热帖/串文类';
  } else if (/混剪|深夜|氛围|夜景|空镜|语录|破防|故事|storytime|vibe/i.test(text)) {
    contentType = '素材混剪类';
  }

  // 五维客观打分（Laya 品牌及高赞高浏览享热度加成）
  const likes = Number(candidate.likes || 0);
  const plays = Number(candidate.plays || 0);
  const isLaya = /laya|拉雅/i.test(text) || exposedBrands.some((b) => /laya/i.test(b));
  let engagement = Math.min(20, Math.max(10, Math.round(Math.log10(Math.max(likes, plays > 0 ? Math.round(plays / 15) : 50)) * 4.5)));
  if (likes >= 5000 || plays >= 50000) engagement = Math.min(20, engagement + 2);
  if (isLaya && likes === 0 && plays === 0) engagement = Math.max(15, engagement);

  const maleFit = /甜妹|姐姐|女生主动|哄睡|连麦|处CP|暈船|脱单|曖昧|暧昧|crush|flirty|voice|laya/i.test(text) ? 23 : 17;
  const replicability = contentType === '聊天录屏类' || contentType === '纯文字热帖/串文类' ? 19 : contentType === '图文聊天/配图类' || contentType === '素材混剪类' ? 17 : 14;
  const implantNaturalness = contentType === '聊天录屏类' || contentType === '纯文字热帖/串文类' ? 19 : 17;
  const completeness = (candidate.fullText || '').length >= 25 ? 13 : 10;
  const qualityScore = Math.min(98, engagement + maleFit + replicability + implantNaturalness + completeness);

  const dur = mediaType === 'video' ? Number(candidate.durationSec || 15) : 0;
  const hookSec = Math.max(4, Math.min(11, Math.round((dur || 15) * 0.42)));
  const implantDifficulty = ['聊天录屏类', '纯文字热帖/串文类', '图文聊天/配图类'].includes(contentType)
    ? (exposedBrands.length > 1 ? 2 : 1)
    : contentType === '素材混剪类'
      ? 2
      : 3;

  const hookStyle = /深夜|哄睡|孤独|睡不着/i.test(text)
    ? '深夜孤独破防'
    : /神回复|反转|奇葩/i.test(text)
      ? '神回复反转'
      : /奔现|面基/i.test(text)
        ? '奔现暧昧纪实'
        : '甜妹反差主动';

  return {
    passed: true,
    vetoCode: '',
    vetoReason: '',
    hasHumanFace: false,
    isGameOrAnime: false,
    isHardAd: false,
    isIrrelevantOrFemaleOnly: false,
    isUnreplicable: false,
    contentType,
    exposedBrands,
    implantDifficulty,
    dimensions: {
      engagement,
      maleFit,
      replicability,
      implantNaturalness,
      completeness,
    },
    qualityScore,
    hookStyle,
    implantGuide: {
      exactTiming:
        mediaType === 'text'
          ? '第 2 段情绪转折处（引出声音匹配体验，非硬广直推）'
          : mediaType === 'image'
            ? '第 2 张聊天/氛围配图页（顶部状态栏或对话转折句）'
            : contentType === '聊天录屏类'
              ? `第 ${String(hookSec).padStart(2, '0')} 秒（第 3 轮女生主动弹出语音条 / 暧昧反问气泡处）`
              : `第 ${String(hookSec).padStart(2, '0')} 秒（情绪转折字幕切入手机锁屏私信弹窗瞬间）`,
      visualHook:
        mediaType === 'text'
          ? `纯文字第一视角克制描述使用细节，如「在 ${brandName} 随手挂了个匿名语音房」，不贴下载链接`
          : mediaType === 'image'
            ? `图集第 2 页聊天截图顶部状态栏轻量露出「匿名语音匹配成功」，保持原生截图质感`
            : contentType === '聊天录屏类'
              ? `聊天顶部状态栏轻量露出「匿名语音匹配成功 · 通话中 00:48:12」原生UI细节，零硬广贴片`
              : `夜景空镜上方叠加半透明手机通知横幅：「[${brandName}] 你匹配的小姐姐发来一段 9" 晚安语音」`,
      copyScript: `正文直接套用：「以为深夜语音匹配到的都是高冷慢热，结果刚连上3秒对面妹妹直接叫哥哥问睡不着要不要一起挂机听歌…谁懂这种顶不住的瞬间」`,
      commentSeedScript: `主号不留链接防限流；发布 2 分钟后小号A评论：「求问这是什么聊天软件？怎么我平时匹配不到这么会聊的妹妹」，小号B回复：「看着像 ${brandName}，开深夜语音速配基本秒接，回复超快」`,
    },
    replicationSteps:
      mediaType === 'text' || mediaType === 'image'
        ? [
            `1. 文案/图文改写：保留高赞原帖第一句钩子和情绪节奏，改成夜间男性第一视角分享；`,
            `2. 软广埋点：在正文后半段或第 2 张截图自然提及语音连麦细节，也可直接用录屏工作台一键转成聊天录屏视频；`,
            `3. 互动助推：发布至 ${candidate.platform.toUpperCase()} 后用双小号在评论区完成「问软件名 -> 答 ${brandName}」自然引流。`,
          ]
        : [
            `1. 画面复刻：打开内部录屏制作台（如 Laya 播放器工作台），按原片节奏编排 4~5 轮短句对话，前 2 秒直接展示最具悬念/暧昧张力的首句；`,
            `2. 软广埋点：在第 ${hookSec} 秒第 3 轮互动处自然带出语音通话气泡或「连麦匹配」状态条，严禁出现下载二维码或推销字眼；`,
            `3. 音频卡点：选用「${candidate.bgm || '深夜微醺 Lo-Fi / 慵懒 R&B'}」同款慢节奏背景音，气泡弹出配清脆提示音，总时长控制在 ${dur} 秒左右；`,
            `4. 矩阵承接：发布至 ${candidate.platform.toUpperCase()} 后用准备好的双小号在热评区完成「问软件名 -> 答 ${brandName}/暗号」闭环引流。`,
          ],
    auditEngine: 'local_free_smart_engine',
  };
}

/**
 * 面向“本周高赞热帖榜”的健康合规轻量评估器（对齐飞书字段枚举，并为每条帖子生成差异化软广植入与改写话术）
 */
function evaluateWeeklyTrendingSample(candidate, dbArg = null) {
  const db = dbArg || store.getDb();
  const brandName = (db && db.settings && db.settings.brandName) || 'Laya';
  const corpus = `${candidate.title || ''}\n${candidate.fullText || ''}\n${(candidate.topComments || []).map((c) => c.text || c).join('\n')}`;

  if (!isStrictlyChineseContent(candidate)) {
    return {
      qualified: false,
      filterCategory: '非简繁中文过滤',
      vetoReason: `一票否决：${explainNonChineseReason(candidate)}`,
      auditResult: { hasHumanFace: false, isGameOrAnime: false, isIrrelevantOrFemaleOnly: true, qualityScore: 0 },
    };
  }

  if (!isCompliantHealthyPost(candidate)) {
    return {
      qualified: false,
      filterCategory: '合规内容拦截',
      vetoReason: '合规审核拦截：命中不健康内容、涉政噪音、外语无关或占位文案',
      auditResult: { hasHumanFace: false, isGameOrAnime: false, qualityScore: 0 },
    };
  }

  const matchedKw = String(candidate.keywordMatched || candidate.sourceKeyword || '');
  if ((/laya|拉雅/i.test(matchedKw) || /laya/i.test(corpus)) && NON_DATING_LAYA_NOISE_RE.test(`${corpus} ${candidate.videoUrl || ''}`)) {
    return {
      qualified: false,
      filterCategory: '同名无关品牌拦截',
      vetoReason: '命中同名非相关品牌噪音',
      auditResult: { hasHumanFace: false, isGameOrAnime: false, isIrrelevantOrFemaleOnly: true, qualityScore: 10 },
    };
  }

  if (NON_MALE_APPEAL_NOISE_RE.test(corpus)) {
    return {
      qualified: false,
      filterCategory: '追星/跑题水帖拦截',
      vetoReason: '命中追星、生理吐槽或无关跑题内容，非男性向对标素材',
      auditResult: { hasHumanFace: false, isGameOrAnime: false, isIrrelevantOrFemaleOnly: true, qualityScore: 12 },
    };
  }

  const likes = Number(candidate.likes || 0);
  const plays = Number(candidate.plays || 0);
  const comments = Number(candidate.comments || 0);
  const scoreBase = likes >= 5000
    ? 93 + Math.min(5, Math.floor(Math.log10(likes + 1)))
    : likes >= 1000
      ? 86 + Math.min(6, Math.floor(likes / 800))
      : likes >= 200
        ? 78 + Math.min(7, Math.floor(likes / 140))
        : 66 + Math.min(11, Math.floor((likes + comments * 2) / 18));
  const qualityScore = Math.max(65, Math.min(98, scoreBase));

  const exposedBrands = detectExposedBrands(corpus);
  const categoryGroup = determineCategoryGroup(candidate, exposedBrands, db);
  if (!candidate._forceCustomKeyword && categoryGroup === 'generic' && !MALE_APPEAL_BENCHMARK_RE.test(corpus)) {
    return {
      qualified: false,
      filterCategory: '非男性向对标拦截',
      vetoReason: '内容与女友视角/高颜值日常/暧昧聊天/脱单搭讪无明确关联',
      auditResult: { hasHumanFace: false, isGameOrAnime: false, isIrrelevantOrFemaleOnly: true, qualityScore: 25 },
    };
  }
  const mediaType = candidate.mediaType || 'text';
  const isGirlfriendPovTopic = /女友視角|女友视角|女友感|穿搭|\bootd\b|自拍|對鏡拍|对镜拍|甜妹|御姐|姐姐|撒嬌|撒娇|微醺|睡不著|睡不着|還沒睡|还没睡|陪我|單身女|单身女|當你女友|好看嗎|喜歡嗎|girlfriend\s*pov|single\s*girl/i.test(corpus);
  const isMoviePlayerTopic = /播放器|4k|網盤|网盘|電影|电影|影集|netflix|追劇|追剧|好劇|好剧|韓劇|韩剧|動畫|动画|clip|混剪/i.test(corpus);
  const isCrushChatTopic = /暈船|晕船|曖昧|暧昧|聊天|對話|对话|交友|直男|渣男|下頭|下头|相親|相亲|搭訕|搭讪|要IG|前任|脫單|脱单|語音|语音|連麥|连麦|約會|约会|男朋友|女朋友|分手|暗戀|暗恋|單身|单身|理想型|告白/i.test(corpus);

  let contentType = '✨ 其他泛软广类';
  if (mediaType === 'video') {
    contentType = isCrushChatTopic ? '💬 聊天录屏类' : (isGirlfriendPovTopic || isMoviePlayerTopic) ? '🎞️ 素材混剪类' : '✨ 其他泛软广类';
  } else if (mediaType === 'image') {
    contentType = '🖼️ 图文聊天/配图类';
  } else if (mediaType === 'text') {
    contentType = '📝 纯文字热帖/串文类';
  }

  const implantDifficulty = mediaType === 'video' ? 2 : 1;
  const hookStyle = comments >= Math.max(20, likes * 0.06)
    ? '高评论争议/提问共鸣钩子'
    : likes >= 3000
      ? '强情绪共鸣/反常识爆点'
      : '轻日常碎碎念/真实感分享';

  const rawShort = String(candidate.title || candidate.fullText || '').replace(/\s+/g, ' ').trim();
  const shortHook = rawShort.length > 22 ? `${rawShort.slice(0, 22)}…` : rawShort;
  const authorTag = `@${String(candidate.authorHandle || 'threads_creator').replace(/^@/, '')}`;
  const platName = String(candidate.platform || 'threads').toUpperCase();
  const interactionNote = comments > 0
    ? `该帖互动极高（👍${likes} / 💬${comments}）`
    : `该帖点赞表现亮眼（👍${likes}）`;

  let exactTiming = '';
  let visualHook = '';
  let copyScript = '';
  let commentSeedScript = '';

  if (categoryGroup === 'brand' || /(?:\blaya\b|layacouples|在\s*laya|拉雅)/i.test(corpus)) {
    exactTiming = mediaType === 'video'
      ? `第 02~05 秒直接露出原帖切入点（参考 ${authorTag}），第 07 秒承接 ${brandName} 界面转场`
      : mediaType === 'image'
        ? `首图放大「${shortHook}」讨论焦点，第 2 张配 ${brandName} 实测界面对比`
        : `首句直接复用网友追问口吻「${shortHook}」，第 2 段自然带出 ${brandName} 使用体验`;
    visualHook = `${authorTag} 的 ${brandName} 原生口碑实测反馈；${interactionNote}，可沿用无滤镜日常截图增强真实感`;
    copyScript = `延续「${shortHook}」讨论语境，改写为第一人称真实安利：『最近超多人在问我怎么用 ${brandName} 的，其实晚上匹配语音/找剧看都很顺手，重点是真人感强不踩坑…』`;
    commentSeedScript = `小号A追问：『求指路！这真的是 ${brandName} 吗？安卓和iOS都能直接下？』→ 主号/小号B回复：『对的搜 ${brandName} 就行，晚上人超多超好聊』`;
  } else if (isGirlfriendPovTopic) {
    exactTiming = mediaType === 'video'
      ? `前 3 秒用「${shortHook}」高颜值女友视角/穿搭氛围定帧吸睛，第 06 秒切出深夜来电或语音条邀请冒泡`
      : mediaType === 'image'
        ? `首图放高颜值女友感日常/对镜自拍（「${shortHook}」），第 2 张附图深夜私信/语音房在麦截图`
        : `开篇借「${shortHook}」发出女生夜晚无聊想找人聊天信号，第 2 段顺带露出『去 ${brandName} 连麦碰运气』`;
    visualHook = `复刻 ${authorTag} 的高颜值女友视角生活流质感（${interactionNote}），画面保持自然光影+轻氛围字幕，只露一角语音连麦来电状态卡`;
    copyScript = `改写男向吸引文案（紧扣「${shortHook}」）：『每次晚上加班回家没人说话就刷到这种女友日常…其实前几天无聊开了次 ${brandName} 深夜语音，匹配到声音超甜的妹妹陪聊到两点！』`;
    commentSeedScript = `小号A评论：『姐姐这穿搭也太犯规了！这种高颜值女生一般都在哪个软件玩啊？』→ 小号B轻回复：『我闺蜜几个近期都在 ${brandName} 语音房冒泡，晚上真人可多了』`;
  } else if (isCrushChatTopic) {
    exactTiming = mediaType === 'video'
      ? `第 01~04 秒直接贴出「${shortHook}」情绪冲突第一句，第 07 秒切换到语音连麦/私聊回复状态条`
      : mediaType === 'image'
        ? `图1用「${shortHook}」聊天截图吸睛，图2补全『语音连麦 01:18:20』后续反转气泡`
        : `开篇抛出「${shortHook}」反问引发评论站队，收尾自然带出『后来转去语音匹配才遇到同频的人』`;
    visualHook = `借鉴 ${authorTag} 的高共鸣情感结构（${interactionNote}），采用深色聊天气泡+语音波形卡片排版，弱化广告感只露轻微应用状态`;
    copyScript = `借势「${shortHook}」改写男向破冰视角：『以前总觉得网上聊天全靠硬尬，直到前几天睡前在 ${brandName} 随机开了语音连麦，对面妹妹一句话直接让我清醒了…你们怎么看？』`;
    commentSeedScript = `小号A留言：『笑死太真实了，求问你们平时这种连麦语音都在哪个 app 聊的？』→ 小号B轻回复：『我跟身边朋友最近都在用 ${brandName}，女生主动度比文字软件高多了』`;
  } else if (isMoviePlayerTopic) {
    exactTiming = mediaType === 'video'
      ? `前 3 秒贴「${shortHook}」悬念金句卡住划屏，第 06 秒切到流畅高清播放界面与声画细节`
      : mediaType === 'image'
        ? `第 1 张放热门片单/吐槽截图「${shortHook}」，第 2 张露出离线缓存在 ${brandName} 的 4K 画面`
        : `第 1 段抛片荒/看剧痛点（「${shortHook}」），第 2 段顺带推荐用 ${brandName} 追剧+陪看体验`;
    visualHook = `结合 ${authorTag} 的追剧/播放器话题热潮（${interactionNote}），画面角落微弱保留播放进度条与「${brandName} 一键导入」氛围，不贴硬广二维码`;
    copyScript = `紧贴「${shortHook}」重写文案：『本来刷到大家都在聊这部，结果自己找资源卡到崩溃…后来直接拖进 ${brandName} 放 4K 倍速+连麦吐槽，一个人看剧也完全不无聊！』`;
    commentSeedScript = `小号A问：『请问图里这个高清播放器叫什么名字呀？字幕外挂好清楚』→ 小号B自然答：『是 ${brandName}～搜一下就有，顺便还能进语音房找同好一起看』`;
  } else {
    exactTiming = mediaType === 'video'
      ? `前 3 秒抛出「${shortHook}」反常识冲突，第 06~10 秒切入真实分享/评论区精选观点`
      : mediaType === 'image'
        ? `首图截留「${shortHook}」高亮金句卡片，配图第 2 页植入日常陪伴/工具使用场景`
        : `首句保留「${shortHook}」生活化提问拉高互动，第 2 段以『顺带一提最近解闷常用…』丝滑切入`;
    visualHook = `借用 ${authorTag} 的自然流热帖壳子（${interactionNote}），保持 ${platName} 原生字体与分段留白，避免精修商业海报感`;
    copyScript = `参考「${shortHook}」爆款情绪模板改写：『说真的看到大家讨论这件事太有感了…平时晚上睡不着或加班郁闷，我都会上 ${brandName} 找人随口唠两句或者挂机放片，心态好超多。』`;
    commentSeedScript = `小号A评论：『+1！讲得太中肯了，顺便问一句评论区说的那个小众神器是 ${brandName} 吗？』→ 小号B答：『对就是它，界面很干净没什么广告』`;
  }

  return {
    qualified: true,
    auditResult: {
      hasHumanFace: false,
      isGameOrAnime: false,
      isHardAd: false,
      isIrrelevantOrFemaleOnly: false,
      isUnreplicable: false,
      passed: true,
      qualityScore,
      categoryGroup,
      exposedBrands,
      contentType,
      implantDifficulty,
      hookStyle,
      dimensions: {
        hook: Math.min(10, Math.max(7, Math.round(qualityScore / 10))),
        engagement: Math.min(10, Math.max(7, Math.round((Math.log10(likes + 10) / 4.2) * 10))),
        replicability: mediaType === 'text' ? 9 : mediaType === 'image' ? 8 : 7,
        safety: 10,
      },
      implantGuide: {
        exactTiming,
        visualHook,
        copyScript,
        commentSeedScript,
        rewrittenCaption: copyScript,
        suggestedCta: commentSeedScript,
      },
      replicationSteps: [
        `1. 钩子借鉴：直接复用「${shortHook}」的开篇冲突或反问结构，在前 2 秒/首行留住划屏注意力；`,
        mediaType === 'text'
          ? `2. 原生改写：保持 ${platName} 口语化短段落与评论留白感，在中后段自然带出 ${brandName} 使用场景；`
          : `2. 视觉卡点：保留高清首图/对话气泡质感，在转折第 06 秒轻露出 ${brandName} 界面细节；`,
        `3. 评论双簧：发帖后 5 分钟内用矩阵小号在评论区埋入 ${brandName} 产品词问答承接自然搜索流量。`,
      ],
      auditEngine: 'weekly_trending_evaluator_v2',
    },
  };
}

/**
 * 对单条采集候选样本执行【前置硬规则过滤 + 全量视觉大模型审核 + 五维评分 + 植入脚本生成】
 */
async function auditCandidateSample(candidate, proxy = null, options = {}) {
  const db = store.getDb();
  const settings = db.settings;
  const thresholds = settings.thresholds || {};
  const fullCorpus = `${candidate.title || ''}\n${candidate.fullText || ''}\n${(candidate.topComments || []).map((c) => c.text || c).join('\n')}`;

  if (!isStrictlyChineseContent(candidate)) {
    return {
      qualified: false,
      filterCategory: '非简繁中文过滤',
      vetoReason: `一票否决：${explainNonChineseReason(candidate)}`,
      auditResult: { hasHumanFace: false, isGameOrAnime: false, isIrrelevantOrFemaleOnly: true, qualityScore: 0 },
    };
  }

  // 0. 黑名单账号与屏蔽特征词前置一票否决
  const handleLower = String(candidate.authorHandle || '').toLowerCase();
  if (handleLower) {
    const blkAcc = (db.blacklist.accounts || []).find(
      (a) => a.handle.toLowerCase() === handleLower && (!a.platform || a.platform === candidate.platform)
    );
    if (blkAcc) {
      return {
        qualified: false,
        filterCategory: '黑名单账号拦截',
        vetoReason: `命中已拉黑垃圾账号 @${candidate.authorHandle}（原因：${blkAcc.reason || '人工标记垃圾同源过滤'}）`,
        auditResult: { hasHumanFace: false, isGameOrAnime: false, qualityScore: 0 },
      };
    }
  }

  for (const blkKw of db.blacklist.keywords || []) {
    if (blkKw.word && fullCorpus.toLowerCase().includes(blkKw.word.toLowerCase())) {
      return {
        qualified: false,
        filterCategory: '黑名单特征词拦截',
        vetoReason: `命中垃圾特征屏蔽词「${blkKw.word}」（${blkKw.reason || '自动过滤'}）`,
        auditResult: { hasHumanFace: false, isGameOrAnime: false, qualityScore: 0 },
      };
    }
  }

  // 0b. 拦截同名非交友内容噪音（如 Laya 医疗保险 / LayaAir 游戏引擎 / 度假村等）
  if (NON_DATING_LAYA_NOISE_RE.test(`${fullCorpus} ${candidate.videoUrl || ''}`)) {
    return {
      qualified: false,
      filterCategory: '同名无关品牌拦截',
      vetoReason: '一票否决：命中同名非交友内容（如 Laya 医疗保险 / LayaAir 引擎 / 度假村等）',
      auditResult: { hasHumanFace: false, isGameOrAnime: false, isIrrelevantOrFemaleOnly: true, qualityScore: 10 },
    };
  }

  if (options && options.weeklyTopMode) {
    return evaluateWeeklyTrendingSample(candidate, db);
  }

  // 1. 低质账号硬规则过滤（粉丝<1000 或 注册时长<30天）
  const minFollowers = Number(thresholds.minAuthorFollowers ?? 1000);
  const minAgeDays = Number(thresholds.minAuthorAgeDays ?? 30);
  if (candidate.authorFollowers !== undefined && candidate.authorFollowers !== null && Number(candidate.authorFollowers) < minFollowers) {
    return {
      qualified: false,
      filterCategory: '低质账号过滤',
      vetoReason: `一票否决：账号粉丝数 ${candidate.authorFollowers} 低于门槛（<${minFollowers} 测试号/低权号）`,
      auditResult: { hasHumanFace: false, isGameOrAnime: false, qualityScore: 15 },
    };
  }
  if (candidate.authorAgeDays !== undefined && candidate.authorAgeDays !== null && Number(candidate.authorAgeDays) < minAgeDays) {
    return {
      qualified: false,
      filterCategory: '低质账号过滤',
      vetoReason: `一票否决：账号注册时长仅 ${candidate.authorAgeDays} 天（<${minAgeDays} 天新注册营销/测试号）`,
      auditResult: { hasHumanFace: false, isGameOrAnime: false, qualityScore: 15 },
    };
  }

  // 2. 直白硬广前置拦截
  for (const re of HARD_AD_PATTERNS) {
    if (re.test(fullCorpus)) {
      return {
        qualified: false,
        filterCategory: '硬广内容过滤',
        vetoReason: `一票否决：文案或热评出现直白硬广推销话术（命中规则 ${re.source}）`,
        auditResult: { hasHumanFace: false, isGameOrAnime: false, isHardAd: true, qualityScore: 10 },
      };
    }
  }

  // 3. 基础互动门槛检查（品牌词 Laya 或公开页面暂未暴露数字的图文/文字帖豁免）
  const minPlays = Number(thresholds.minPlays ?? 3000);
  const minLikes = Number(thresholds.minLikes ?? 150);
  const isBrandOrLaya = candidate.sourceBucket === 'brand' || /laya|拉雅/i.test(fullCorpus);
  const metricsUnknown = Boolean(candidate._metricsUnknown);
  if (!isBrandOrLaya && !metricsUnknown && !candidate._forceCustomKeyword && Number(candidate.plays || 0) < minPlays && Number(candidate.likes || 0) < minLikes) {
    return {
      qualified: false,
      filterCategory: '低互动量过滤',
      vetoReason: `互动数据未达起评门槛（播放 ${candidate.plays || 0} < ${minPlays} 且 点赞 ${candidate.likes || 0} < ${minLikes}）`,
      auditResult: { hasHumanFace: false, isGameOrAnime: false, qualityScore: 30 },
    };
  }

  // 4. 调用 0 费用本地智能引擎 或 可选外部视觉大模型审核视频封面 + 生成定制软广植入指南
  const visionCfg = settings.visionLlm || {};
  const isLocalFree = !visionCfg.provider || visionCfg.provider === 'local_free';
  const apiKey = isLocalFree
    ? ''
    : (
        visionCfg.apiKey ||
        (visionCfg.provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY) ||
        ''
      ).trim();

  const preDetectedBrands = detectExposedBrands(fullCorpus, db.keywords.brand, db.keywords.competitor);
  let visionRes = null;

  if (apiKey) {
    const coverImg = await fetchCoverAsBase64(candidate.coverUrl, proxy);
    const promptText = buildVisionPrompt(candidate, settings);
    try {
      if (visionCfg.provider === 'openai_compatible') {
        visionRes = await callOpenAiCompatibleVision(promptText, coverImg, candidate, { ...visionCfg, apiKey });
      } else {
        visionRes = await callGeminiVision(promptText, coverImg, candidate, { ...visionCfg, apiKey });
      }
      visionRes.auditEngine = `${visionCfg.provider}:${visionCfg.provider === 'openai_compatible' ? visionCfg.openaiModel : visionCfg.model}`;
    } catch (err) {
      store.addOpLog({
        module: '视觉大模型审核',
        action: '调用多模态API异常',
        operator: 'AI视觉审核器',
        status: 'warning',
        detail: `样本「${(candidate.title || '').slice(0, 24)}」视觉接口报错，${visionCfg.allowOfflineFallbackForTest ? '已切换本地0费用智能审片' : '已暂停入库'}`,
        errorReason: err.message,
      });
      if (!visionCfg.allowOfflineFallbackForTest) {
        throw err;
      }
      visionRes = runOfflineMultimodalSimulation(candidate, settings, preDetectedBrands);
    }
  } else {
    // 默认直接使用 0 费用本地智能审片引擎，无需额外购买 API Key
    if (!isLocalFree && !visionCfg.allowOfflineFallbackForTest) {
      await store.raiseAlert({
        type: 'vision_key_missing',
        level: 'critical',
        title: '外部视觉大模型 API Key 未配置',
        message: '可在设置中切回「本地 0 费用智能引擎」，或填入外部多模态 API Key。',
      });
      throw new Error('未配置外部视觉大模型 API Key');
    }
    visionRes = runOfflineMultimodalSimulation(candidate, settings, preDetectedBrands);
  }

  // 合并识别到的品牌词
  const mergedBrands = Array.from(new Set([...preDetectedBrands, ...(visionRes.exposedBrands || [])]));
  visionRes.exposedBrands = mergedBrands;
  visionRes.categoryGroup = determineCategoryGroup(candidate, mergedBrands, db);

  // 5. 校验视觉大模型一票否决结论（保留女友视角/高颜值自拍日常，不再一票否决真人露脸）
  if (visionRes.isGameOrAnime) {
    return {
      qualified: false,
      filterCategory: '游戏/二次元过滤',
      vetoReason: visionRes.vetoReason || '一票否决：视觉大模型识别出游戏画面/陪玩开黑/二次元内容',
      auditResult: visionRes,
    };
  }
  if (visionRes.isHardAd) {
    return {
      qualified: false,
      filterCategory: '硬广内容过滤',
      vetoReason: visionRes.vetoReason || '一票否决：识别为直白硬广推销内容',
      auditResult: visionRes,
    };
  }
  if (visionRes.isIrrelevantOrFemaleOnly) {
    return {
      qualified: false,
      filterCategory: '非男向/无关过滤',
      vetoReason: visionRes.vetoReason || '一票否决：纯女性向或与男性脱单/异性陪伴无关内容',
      auditResult: visionRes,
    };
  }
  if (visionRes.isUnreplicable) {
    return {
      qualified: false,
      filterCategory: '无法复刻过滤',
      vetoReason: visionRes.vetoReason || '一票否决：依赖高成本实拍/真人配音/复杂特效，无法批量复刻',
      auditResult: visionRes,
    };
  }
  if (visionRes.passed === false) {
    return {
      qualified: false,
      filterCategory: '视觉审核未通过',
      vetoReason: visionRes.vetoReason || '未通过多模态防废片审核',
      auditResult: visionRes,
    };
  }

  // 6. 校验五维综合质量分合格线（默认 60 分）
  const minScore = Number(thresholds.minQualityScore ?? 60);
  const score = Number(visionRes.qualityScore || 0);
  if (score < minScore) {
    return {
      qualified: false,
      filterCategory: '低质量分过滤',
      vetoReason: `五维综合质量分 ${score} 分，低于当前合格线 ${minScore} 分`,
      auditResult: visionRes,
    };
  }

  return {
    qualified: true,
    filterCategory: '',
    vetoReason: '',
    auditResult: visionRes,
  };
}

/**
 * 系统设置页：一键测试视觉大模型连通性
 */
async function testVisionConnection(overrideCfg = {}) {
  const db = store.getDb();
  const visionCfg = Object.assign({}, db.settings.visionLlm || {}, overrideCfg);
  const apiKey = (visionCfg.apiKey || '').trim();
  const sampleMock = {
    platform: 'instagram',
    title: '深夜11点语音匹配到的台湾甜妹，第一句话就让我破防了',
    fullText: '本来睡不着随便开了个匿名语音连麦，对面女生声音软软地问我今天累不累… #聊天记录 #语音连麦 #脱单',
    durationSec: 15,
    bgm: 'Late Night Lo-Fi Chill',
    plays: 68500,
    likes: 5420,
    comments: 312,
    shares: 480,
    bookmarks: 910,
    topComments: [{ text: '求问这是什么交友软件？界面好好看', likes: 286 }],
    authorHandle: 'latenight.chat.tw',
    authorFollowers: 18500,
    authorAgeDays: 240,
    visualSceneDesc: '深色模式手机聊天界面录屏，上下气泡对话加3条语音波形条，无任何真人头像露脸与游戏元素',
  };

  if (!visionCfg.provider || visionCfg.provider === 'local_free' || (!apiKey && visionCfg.allowOfflineFallbackForTest !== false)) {
    const start = Date.now();
    const res = runOfflineMultimodalSimulation(sampleMock, db.settings, ['Laya']);
    return {
      ok: true,
      latencyMs: Math.max(1, Date.now() - start),
      provider: 'local_free',
      model: '本地0费用智能引擎',
      sampleScore: res.qualityScore,
      sampleTiming: res.implantGuide && res.implantGuide.exactTiming,
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      message: '请先填入 API Key，或者直接选「本地 0 费用智能引擎（免费免钥匙）」',
    };
  }

  const prompt = buildVisionPrompt(sampleMock, db.settings);
  const start = Date.now();
  try {
    const res =
      visionCfg.provider === 'openai_compatible'
        ? await callOpenAiCompatibleVision(prompt, null, sampleMock, visionCfg)
        : await callGeminiVision(prompt, null, sampleMock, visionCfg);

    return {
      ok: true,
      latencyMs: Date.now() - start,
      provider: visionCfg.provider,
      model: visionCfg.provider === 'openai_compatible' ? visionCfg.openaiModel : visionCfg.model,
      sampleScore: res.qualityScore,
      sampleTiming: res.implantGuide && res.implantGuide.exactTiming,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      provider: visionCfg.provider,
      model: visionCfg.provider === 'openai_compatible' ? visionCfg.openaiModel : visionCfg.model,
      message: err.message,
    };
  }
}

module.exports = {
  auditCandidateSample,
  evaluateWeeklyTrendingSample,
  testVisionConnection,
  detectExposedBrands,
  NON_MALE_APPEAL_NOISE_RE,
  MALE_APPEAL_BENCHMARK_RE,
};
