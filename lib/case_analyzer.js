'use strict';
/**
 * 丢链接 / 传截图智能拆解案例模块（大白话版）
 * 运营只需：丢一条社媒链接，或直接拖进/Ctrl+V粘贴几张截图，再附一句想问的话，
 * 系统就会自动拆解：为什么火、有没有踩雷坑、第几秒怎么抄、直接给你 3 套现成文案，并支持一键存进好视频库！
 */
const { uid } = require('./defaults');
const store = require('./store');
const proxyPool = require('./proxy_pool');
const coverCache = require('./cover_cache');
const mediaExtractor = require('./media_extractor');
const coverSvg = require('./collectors/cover_svg');
const feishuSync = require('./feishu_sync');

function extractJsonObj(rawText) {
  const cleaned = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error('AI返回结果无法解析');
  }
}

function parseDataUriParts(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2], dataUri };
}

function buildPlainLanguageCasePrompt({ urlInfo, userNote, brandName, brandPos }) {
  return `你是专门帮【${brandName}】语音恋爱交友App做海外短视频投放的爆款总编，面对的是不懂代码的一线运营同事，请全部用接地气的大白话回答，不要说任何技术英文黑话！
我方产品定位：${brandPos}
核心人群：想脱单、晚上寂寞想找温柔妹妹语音连麦聊天的男性用户。

【用户提交的材料】
- 原链接：${urlInfo ? urlInfo.videoUrl : '（未填链接，纯看截图分析）'}
- 自动抓到的标题/文案：${urlInfo ? `${urlInfo.title}\n${urlInfo.fullText}` : '（无）'}
- 运营特别补充或想问的问题：${userNote || '帮我拆解为什么火、有没有露脸游戏之类的废片坑、以及怎么改成我们的语音交友软广！'}

请仔细看附带的截图或视频封面，只返回纯 JSON 对象，字段必须严格包含以下内容：
{
  "summaryTitle": "用一句话总结这是个什么案例（15字左右，让人一眼秒懂）",
  "contentType": "聊天录屏类 或 素材混剪类 或 其他可植入泛内容",
  "score": 86,
  "whyViral": [
    "第1点火的原因：比如前2秒用了什么悬念话术把刷视频的男生留住了",
    "第2点情绪共鸣：戳中了男生哪块心病（孤独/好奇/反差被女生倒追）",
    "第3点评论区带节奏：评论区为什么都在问是什么软件"
  ],
  "pitfallCheck": {
    "safeToCopy": true,
    "hasHumanFace": false,
    "hasGame": false,
    "conclusion": "大白话体检结论：例如【非常安全！画面全是大字聊天框，没有真人露脸、没有游戏画面、也没有生硬下载广告，剪辑新手10分钟就能照抄】"
  },
  "stepByStepCopy": [
    "第1步（0~3秒开头怎么改）：具体写清楚放什么画面、字幕打什么字",
    "第2步（4~10秒怎么自然带出我们的App）：精确到第几秒/第几句对话放什么气泡或语音条",
    "第3步（背景音乐和时长）：建议多少秒、用什么感觉的歌",
    "第4步（评论区怎么引导下载）：写清楚大号小号怎么一问一答"
  ],
  "readyScripts": [
    {
      "styleName": "套路1：深夜反差被甜妹主动撩",
      "videoText": "可直接套用的视频内大字/对白内容",
      "caption": "发帖配文+话题标签",
      "commentHook": "评论区小号引导语：A问软件名 -> B回 ${brandName}"
    },
    {
      "styleName": "套路2：受够文字尬聊直接听声音",
      "videoText": "...",
      "caption": "...",
      "commentHook": "..."
    },
    {
      "styleName": "套路3：直男脱单真实翻身记",
      "videoText": "...",
      "caption": "...",
      "commentHook": "..."
    }
  ]
}`;
}

async function callAiForCase({ promptText, imageParts, visionCfg }) {
  if (!visionCfg.provider || visionCfg.provider === 'local_free') return null;
  const apiKey = (
    visionCfg.apiKey ||
    (visionCfg.provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY) ||
    ''
  ).trim();
  if (!apiKey) return null;

  if (visionCfg.provider === 'openai_compatible') {
    const baseUrl = (visionCfg.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = visionCfg.openaiModel || 'gpt-4o-mini';
    const content = imageParts.map((img) => ({ type: 'image_url', image_url: { url: img.dataUri } }));
    content.push({ type: 'text', text: promptText });
    const resp = await proxyPool.requestRaw(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.35,
          messages: [
            { role: 'system', content: '你是交友短视频爆款运营专家，只输出合法JSON，语言全是大白话。' },
            { role: 'user', content },
          ],
        }),
        timeoutMs: 32000,
      },
      null
    );
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw new Error(`看图AI返回异常 (${resp.statusCode})`);
    }
    const d = resp.json();
    return extractJsonObj(d.choices[0].message.content);
  }

  // Google Gemini 多模态（兼容 AI Studio & Vertex Express 双端点 AQ. 钥匙）
  const baseUrl = (visionCfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const model = visionCfg.model || 'gemini-3.8-flash';
  const parts = [];
  for (const img of imageParts) {
    if (!img.mimeType.includes('svg')) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
  }
  parts.push({ text: promptText });

  const payload = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.35, responseMimeType: 'application/json' },
  });
  const doReq = (endpointUrl) =>
    proxyPool.requestRaw(
      endpointUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-goog-api-key': apiKey,
        },
        body: payload,
        timeoutMs: 32000,
      },
      null
    );

  let resp = await doReq(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`);
  if (apiKey.startsWith('AQ.') && [400, 401, 403].includes(resp.statusCode) && !baseUrl.includes('aiplatform.googleapis.com')) {
    const vertexResp = await doReq(`https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`);
    if (vertexResp.statusCode >= 200 && vertexResp.statusCode < 300) {
      resp = vertexResp;
    } else {
      throw new Error(`看图AI双通道鉴权均未通过 (${resp.statusCode} / ${vertexResp.statusCode})`);
    }
  }
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`看图AI返回异常 (${resp.statusCode}): ${resp.text().slice(0, 160)}`);
  }
  const d = resp.json();
  const txt = d.candidates[0].content.parts.map((p) => p.text || '').join('\n');
  return extractJsonObj(txt);
}

function buildOfflineFallbackCaseReport({ urlInfo, userNote, brandName, hasImages }) {
  const combinedText = `${urlInfo ? `${urlInfo.title} ${urlInfo.fullText}` : ''} ${userNote || ''}`;
  const isChat = /聊天|对话|语音|连麦|微信|line|私信|chat|text/i.test(combinedText);
  const hasFaceRisk = /露脸|自拍|口播|小窗|真人出镜/i.test(combinedText);
  const hasGameRisk = /游戏|王者|吃鸡|原神|二次元|开黑/i.test(combinedText);

  const summaryTitle =
    (urlInfo && urlInfo.title && urlInfo.title.slice(0, 26)) ||
    (userNote && userNote.slice(0, 26)) ||
    (hasImages ? '截图案例：高互动交友软广拆解' : '交友短视频改写与植入方案');

  return {
    summaryTitle,
    contentType: isChat ? '聊天录屏类' : '素材混剪类',
    score: hasFaceRisk || hasGameRisk ? 52 : 86,
    whyViral: [
      '前 2 秒直接丢出一个带情绪反差的钩子（比如女生深夜主动发消息，或直男被撩到语无伦次），让刷到的人忍不住停下来看结局。',
      '精准戳中单身男生的核心痛点：平时在普通软件滑半天没人回，突然看到一个“声音好听又主动”的场景，立刻产生强烈的代入感。',
      '正片里完全不直接打广告，而是把软件界面藏在背景细节里，逼得好奇的男生自己去评论区问“这是什么软件”。',
    ],
    pitfallCheck: {
      safeToCopy: !hasFaceRisk && !hasGameRisk,
      hasHumanFace: hasFaceRisk,
      hasGame: hasGameRisk,
      conclusion: hasFaceRisk
        ? '⚠️ 注意避坑：文字里提到可能有真人露脸，照抄时一定要把真人镜头删掉，全部换成纯手机聊天界面或夜景空镜！'
        : hasGameRisk
          ? '⚠️ 注意避坑：不要用游戏录屏当背景，系统会判成游戏流量，吸引不来想脱单的精准男生！'
          : '✅ 非常安全可以照抄：没有真人露脸、没有游戏画面、也没有生硬叫人下载的大字，用做图/录屏工具十几分钟就能批量复制！',
    },
    stepByStepCopy: [
      `第 1 步（0~3秒黄金开头）：${isChat ? '黑底白字弹出女生第一句主动问话，例如「哥哥这么晚还没睡，要不要我唱歌哄你？」配一声清脆提示音留住人。' : '用雨夜车载/城市夜景空镜配一句扎心大字：「下班停在车库不想上楼的10分钟，突然收到她的语音」。'}`,
      `第 2 步（第 6~8 秒自然露出）：在第 3 轮对话弹出一条 11 秒语音气泡，或者页面最顶部状态栏轻轻带出「${brandName} 匿名语音匹配中 · 已通话 00:38:15」，绝不放二维码！`,
      '第 3 步（节奏与音乐）：总长度压在 13~17 秒之间（太长完播率掉得快），背景配温柔慵懒的英文 R&B 或深夜钢琴纯音乐。',
      `第 4 步（评论区暗中引导）：发出去 3 分钟内用小号在下面评论「求问这是什么聊天软件啊？」，再用另一个号自然回复「看着界面像是 ${brandName}，晚上11点后语音匹配超快，都是真人妹子」。`,
    ],
    readyScripts: [
      {
        styleName: '套路 1：深夜反差被甜妹主动撩（最稳爆款）',
        videoText: '女：「刚下班好累哦，有没有人挂着语音陪我发呆」 / 男：「我以为是机器人，结果连上3秒真是个超软的台湾妹妹…」',
        caption: `本来睡不着随便点开语音匹配听歌，结果直接聊了两个钟头…谁懂这种瞬间 #深夜陪伴 #聊天记录 #脱单`,
        commentHook: `小号A：求问软件叫啥？我平时遇到的怎么都高冷不说话｜小号B：看右上角气泡像 ${brandName}，开语音连麦比左滑右滑快多了`,
      },
      {
        styleName: '套路 2：受够文字尬聊直接听声音（转化率高）',
        videoText: '以前每天发十句「在干嘛」都没人理；昨晚换了直接听声音配对，3秒就听到对面笑声，直接约周末喝咖啡了。',
        caption: `奉劝各位嘴笨的老哥，别再打字尬聊了，直接语音连麦真的降维打击 #语音连麦 #直男脱单 #交友`,
        commentHook: `小号A：声音控太爱了，哪个App求指路！｜小号B：搜 ${brandName}，里面女生基本都愿意开麦聊`,
      },
      {
        styleName: '套路 3：网友面基真实翻身故事（高收藏转发）',
        videoText: '连麦挂睡第4天，对面突然问我明天中午要不要出来吃拉面，见面发现比声音还甜！',
        caption: `谁说网上认识不靠谱？先连麦聊三观真的比瞎滑靠谱一万倍 #网友面基 #处CP #恋爱日常`,
        commentHook: `小号A：吸吸欧气！到底在哪匹配到的啊｜小号B：同款 ${brandName} 语音房，祝老哥早日脱单`,
      },
    ],
    engineLabel: '🆓 本地 0 费用智能拆解引擎（不收任何额外费用）',
  };
}

async function analyzeCase({ url = '', imagesBase64 = [], userNote = '', operator = '运营同事' }) {
  const db = store.getDb();
  const brandName = db.settings.brandName || 'Laya';
  const brandPos = db.settings.brandPositioning || '主打男性用户的深夜语音陪伴与恋爱交友App';
  const cleanUrl = String(url || '').trim();
  const imgs = Array.isArray(imagesBase64) ? imagesBase64.slice(0, 4).filter(Boolean) : [];

  if (!cleanUrl && !imgs.length && !String(userNote || '').trim()) {
    throw new Error('请至少填一个视频链接、上传一张截图，或者写几句想问的案例描述哦！');
  }

  let urlInfo = null;
  if (cleanUrl) {
    const proxy = proxyPool.selectProxyForPlatform('instagram', []);
    urlInfo = await mediaExtractor.extractFromUrl(cleanUrl, proxy, 'case');
  }

  // 把用户贴的第一张截图存成 covers/ 里的文件，或者用抓到的链接封面，确保历史列表大封面可见
  let savedCover = '';
  if (imgs.length > 0) {
    savedCover = coverCache.saveDataUriCover(imgs[0], `case_${Date.now().toString(36)}`);
  } else if (urlInfo && urlInfo.coverUrl) {
    savedCover = urlInfo.coverUrl;
  }

  // 准备发给看图AI的图片（上传截图 + 若抓到了远程真封面也转成图像一起看）
  const imageParts = [];
  for (const imgUri of imgs) {
    const parsed = parseDataUriParts(imgUri);
    if (parsed) imageParts.push(parsed);
  }

  if (!savedCover) {
    savedCover = coverSvg.buildDynamicCoverForCandidate({
      platform: (urlInfo && urlInfo.platform) || 'instagram',
      title: (urlInfo && urlInfo.title) || userNote || '案例分析记录',
      fullText: (urlInfo && urlInfo.fullText) || userNote || '',
      likes: (urlInfo && urlInfo.likes) || 3500,
    });
  }

  let report = null;
  const visionCfg = db.settings.visionLlm || {};
  const promptText = buildPlainLanguageCasePrompt({ urlInfo, userNote, brandName, brandPos });

  try {
    report = await callAiForCase({ promptText, imageParts, visionCfg });
    if (report) report.engineLabel = `看图AI深度拆解 (${visionCfg.provider === 'openai_compatible' ? visionCfg.openaiModel : visionCfg.model})`;
  } catch (err) {
    store.addOpLog({
      module: '案例拆解',
      action: 'AI看图调用异常，已改用离线拆解方案',
      operator,
      status: 'warning',
      errorReason: err.message,
    });
  }

  if (!report) {
    report = buildOfflineFallbackCaseReport({ urlInfo, userNote, brandName, hasImages: imgs.length > 0 });
  }

  const caseEntry = {
    id: uid('case'),
    createdAt: new Date().toISOString(),
    operator,
    url: cleanUrl,
    platform: (urlInfo && urlInfo.platform) || (cleanUrl ? mediaExtractor.detectPlatformFromUrl(cleanUrl) : 'custom'),
    coverUrl: savedCover,
    imageCount: imgs.length,
    extractedTitle: (urlInfo && urlInfo.title) || '',
    extractedText: (urlInfo && urlInfo.fullText) || '',
    metrics: urlInfo
      ? { plays: urlInfo.plays || 0, likes: urlInfo.likes || 0, comments: urlInfo.comments || 0 }
      : { plays: 0, likes: 0, comments: 0 },
    userNote: String(userNote || '').trim(),
    report,
    savedToSamples: false,
  };

  if (!Array.isArray(db.caseAnalyses)) db.caseAnalyses = [];
  db.caseAnalyses.unshift(caseEntry);
  if (db.caseAnalyses.length > 100) db.caseAnalyses.length = 100;

  store.addOpLog({
    module: '案例拆解',
    action: '完成一条新案例拆解',
    operator,
    status: 'success',
    detail: `${report.summaryTitle}（推荐指数 ${report.score || 85} 分）`,
  });
  store.save(true);
  return caseEntry;
}

/**
 * 将分析得不错的案例一键存进「抓到的好视频」库并排队同步飞书
 */
function saveCaseToSamples(caseId, operator = '运营同事') {
  const db = store.getDb();
  const c = (db.caseAnalyses || []).find((x) => x.id === caseId);
  if (!c) throw new Error('找不到这条拆解案例记录');

  const rep = c.report || {};
  const firstScript = (rep.readyScripts && rep.readyScripts[0]) || {};
  const newSample = {
    id: uid('smp'),
    platform: ['instagram', 'facebook', 'x', 'threads', 'tiktok'].includes(c.platform) ? c.platform : 'instagram',
    mergedPlatforms: [c.platform || 'instagram'],
    alternateUrls: [],
    duplicateCount: 1,
    title: rep.summaryTitle || c.extractedTitle || '手动分析收藏的爆款案例',
    fullText: c.extractedText || firstScript.caption || c.userNote || '',
    videoUrl: c.url || 'https://www.instagram.com/',
    coverUrl: c.coverUrl,
    publishedAt: c.createdAt,
    collectedAt: new Date().toISOString(),
    durationSec: 15,
    bgm: '推荐配深夜情绪伴奏',
    plays: (c.metrics && c.metrics.plays) || 25000,
    likes: (c.metrics && c.metrics.likes) || 2800,
    comments: (c.metrics && c.metrics.comments) || 160,
    shares: 320,
    bookmarks: 580,
    topComments: [],
    authorHandle: 'manual_case_import',
    authorFollowers: 10000,
    authorAgeDays: 365,
    sourceKeyword: '手动拆解收录',
    categoryGroup: 'generic',
    exposedBrands: [],
    contentType: rep.contentType || '聊天录屏类',
    hasHumanFace: Boolean(rep.pitfallCheck && rep.pitfallCheck.hasHumanFace),
    isGameRelated: Boolean(rep.pitfallCheck && rep.pitfallCheck.hasGame),
    implantDifficulty: 1,
    qualityScore: Number(rep.score || 86),
    dimensions: { engagement: 17, maleFit: 23, replicability: 18, implantNaturalness: 18, completeness: 12 },
    implantGuide: {
      exactTiming: (rep.stepByStepCopy && rep.stepByStepCopy[1]) || '第 07 秒对话转折处',
      visualHook: (rep.stepByStepCopy && rep.stepByStepCopy[0]) || '前3秒悬念大字开头',
      copyScript: firstScript.caption || '',
      commentSeedScript: firstScript.commentHook || '',
    },
    replicationSteps: rep.stepByStepCopy || [],
    auditEngine: rep.engineLabel || '案例拆解引擎',
    contentHash: '',
    mediaFingerprint: '',
    favorited: true,
    markedUsed: false,
    feishuSynced: false,
    feishuSyncedAt: '',
    customValues: {},
  };

  db.samples.unshift(newSample);
  c.savedToSamples = true;
  if (db.settings.feishu && db.settings.feishu.autoRealtimeSync !== false) {
    feishuSync.enqueueSampleForFeishu(newSample.id);
  }
  store.addOpLog({
    module: '案例拆解',
    action: '把分析案例存进好视频库',
    operator,
    status: 'success',
    detail: newSample.title,
  });
  store.save(true);
  return newSample;
}

module.exports = {
  analyzeCase,
  saveCaseToSamples,
};
