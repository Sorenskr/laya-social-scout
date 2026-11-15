'use strict';
const crypto = require('crypto');
const base = require('./base_collector');
const coverSvg = require('./cover_svg');

const mediaExtractor = require('../media_extractor');

function buildSandboxItems(keyword, bucket, maxCount = 3, retryAttempt = 0, dateFrom = '', dateTo = '') {
  // 模拟「语音匹配」首次抓取返回空/限流，验证反爬自动换IP+换近义词「处CP聊天/女生连麦」重试闭环
  if (keyword === '语音匹配' && retryAttempt === 0) {
    const err = new Error('Instagram Hashtag 接口返回 HTTP 429 频率受限');
    err.isRateLimit = true;
    throw err;
  }

  const hashSeed = crypto.createHash('md5').update(`ig:${keyword}`).digest('hex').slice(0, 8);
  const templates = [
    {
      title: `凌晨1点在语音房匹配到声音超奶的台北妹妹，聊了40分钟直接暈船…（附真实录屏）`,
      fullText: `本来加班完超累只想找个人挂着语音听歌，随手点了匿名速配，结果对面妹妹开口第一句「哥哥今天怎么这么晚还没睡」直接让我破防了…聊到后面居然发现同城！#${keyword} #暈船聊天紀錄 #語音交友 #深夜陪伴`,
      videoUrl: `https://www.instagram.com/reel/IG_${hashSeed}_01/`,
      coverUrl: coverSvg.buildChatCoverDataUri({
        platformName: 'IG Reels',
        title: `凌晨1点在语音房匹配到声音超奶的台北妹妹（${keyword}）`,
        bubble1: '哥哥今天怎么这么晚还没睡呀？',
        bubble2: '刚下班有点累，听你说话突然精神了',
        voiceSec: '14"',
        likes: 13600,
        bgm: 'keshi - LIMBO',
        accent: '#e1306c',
      }),
      publishedAt: base.resolvePublishedIsoByDateRange(3, dateFrom, dateTo),
      durationSec: 16,
      bgm: 'keshi - LIMBO (Slowed + Reverb)',
      plays: 148000,
      likes: 13600,
      comments: 642,
      shares: 1890,
      bookmarks: 3120,
      topComments: [
        { author: 'kevin_tw99', text: '求问这是哪个语音App？为什么我匹配到的都是大叔😭', likes: 892 },
        { author: 'night_owl_88', text: '看气泡UI像是 Laya 还是 Goodnight？求老司机指路', likes: 451 },
        { author: 'jason_chen07', text: '这声音谁顶得住啊，母胎单身表示羡慕哭了', likes: 219 },
      ],
      authorHandle: `midnight.chat.${hashSeed.slice(0, 4)}`,
      authorFollowers: 34200,
      authorAgeDays: 420,
      mediaFingerprint: `fp_cross_latenight_01`,
      visualSceneDesc: '纯深色手机聊天录屏，含双人文字气泡与14秒粉色语音条动画，无任何真人露脸与游戏元素',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
    {
      title: `女生主动私信搭讪直男的教科书级开场，第3句就约周末喝咖啡了`,
      fullText: `兄弟们帮我参谋一下，昨晚在 ${bucket === 'brand' ? 'Laya' : '交友軟體'} 上收到女生主动发来的私信，我这样回是不是稳了？平时嘴笨不会聊天的真的建议学一下这种拉扯感 #${keyword} #聊天记录 #脱单 #恋爱话术`,
      videoUrl: `https://www.instagram.com/reel/IG_${hashSeed}_02/`,
      coverUrl: coverSvg.buildChatCoverDataUri({
        platformName: 'IG Reels',
        title: `女生主动私信搭讪直男的教科书级开场（${keyword}）`,
        bubble1: '看你主页歌单也喜欢陶喆诶！',
        bubble2: '这么巧？那现在连麦听首普通朋友？',
        voiceSec: '9"',
        likes: 4850,
        bgm: '陶喆 - 普通朋友',
        accent: '#8b5cf6',
      }),
      publishedAt: base.resolvePublishedIsoByDateRange(9, dateFrom, dateTo),
      durationSec: 14,
      bgm: '陶喆 - 普通朋友 (R&B Lo-Fi Remix)',
      plays: 62400,
      likes: 4850,
      comments: 286,
      shares: 720,
      bookmarks: 1450,
      topComments: [
        { author: 'leo_taipei', text: '接歌单这招太自然了，记笔记了！', likes: 310 },
        { author: 'allen_9527', text: '求问软件名字，急需脱单！', likes: 178 },
        { author: 'eric_wang', text: '第三句切语音连麦真的绝杀', likes: 96 },
      ],
      authorHandle: `crush.notes.${hashSeed.slice(0, 4)}`,
      authorFollowers: 15800,
      authorAgeDays: 260,
      mediaFingerprint: `fp_ig_${hashSeed}_02`,
      visualSceneDesc: '手机聊天对话录屏，展示音乐分享卡片与语音邀请提示，无真人出镜',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
    // 故意混入 1 条「右下角画中画真人露脸」废片用于验证视觉大模型一票否决拦截
    {
      title: `真人出镜实测海外交友软件，右下角小窗看我怎么3分钟撩到小姐姐`,
      fullText: `今天开摄像头画中画露脸实测连麦反应，看我表情管理哈哈 #${keyword} #真人实测`,
      videoUrl: `https://www.instagram.com/reel/IG_${hashSeed}_TRAP_FACE/`,
      coverUrl: coverSvg.buildTrapCoverDataUri({ trapType: 'face', label: '右下角画中画真人男主露脸解说' }),
      publishedAt: base.resolvePublishedIsoByDateRange(5, dateFrom, dateTo),
      durationSec: 28,
      bgm: 'Original Voiceover',
      plays: 41000,
      likes: 1900,
      comments: 95,
      shares: 60,
      bookmarks: 110,
      topComments: [{ author: 'u1', text: '博主表情太逗了', likes: 45 }],
      authorHandle: `vlog_face_blogger`,
      authorFollowers: 19000,
      authorAgeDays: 300,
      mediaFingerprint: `fp_trap_face_${hashSeed}`,
      visualSceneDesc: '聊天界面右下角带真人男主播画中画小窗露脸口播画面',
      visualHints: { hasHumanFace: true },
    },
  ];

  return templates.slice(0, maxCount).map((t) => ({
    ...t,
    platform: 'instagram',
    sourceKeyword: keyword,
    sourceBucket: bucket,
  }));
}

async function collect({ keyword, bucket = 'generic', maxCount = 3, mode = 'hybrid', apiCfg = {}, proxy = null, retryAttempt = 0, dateFrom = '', dateTo = '' }) {
  if (mode === 'sandbox') {
    return buildSandboxItems(keyword, bucket, maxCount, retryAttempt, dateFrom, dateTo);
  }

  // 1. 优先尝试已配置的第三方稳定 API
  const apiItems = await base.fetchFromThirdPartyEndpoint({
    platform: 'instagram',
    keyword,
    bucket,
    maxCount,
    apiCfg,
    proxy,
    dateFrom,
    dateTo,
  });
  if (apiItems.length > 0) return apiItems;
  if (mode === 'api_only') return [];

  // 2. 公开网页代理检索通道 (覆盖视频 /reel/ 与图文 /p/)，结合抓图内核与摘要兜底
  const entries = await base.discoverPublicPostsBySiteQuery('site:instagram.com', keyword, proxy, maxCount, dateFrom, dateTo, { platform: 'instagram' });
  const results = [];
  for (const entry of entries) {
    try {
      const ext = await mediaExtractor.extractFromUrl(entry.url, proxy, 'ig');
      const cand = base.buildCandidateFromPublicEntry({
        platform: 'instagram',
        entry,
        ext,
        keyword,
        bucket,
        defaultHandle: 'ig_creator',
        defaultVideoBgm: 'Instagram Reels Trending Audio',
        buildCoverFn: coverSvg.buildDynamicCoverForCandidate,
      });
      if (cand) results.push(cand);
    } catch (e) {
      if (e.isRateLimit) throw e;
    }
  }
  return results;
}

module.exports = {
  id: 'instagram',
  name: 'Instagram',
  collect,
};
