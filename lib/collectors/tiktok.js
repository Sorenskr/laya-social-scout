'use strict';
const base = require('./base_collector');
const coverSvg = require('./cover_svg');
const mediaExtractor = require('../media_extractor');

function buildSandboxItems(keyword, bucket, maxCount = 3, dateFrom = '', dateTo = '') {
  const templates = [
    {
      mediaType: 'video',
      title: `TikTok 聊天录屏：半夜在语音匹配房被甜妹反问「要不要一起听雨声」(${keyword})`,
      fullText: `男生真的很难拒绝深夜主动聊天的女生…本来只是睡前随便挂一下语音房，没想到对面妹妹一开口直接心软了！ #${keyword} #语音匹配 #深夜聊天 #脱单`,
      videoUrl: 'https://www.tiktok.com/@latenight_voice_tw/video/7438192001001',
      coverUrl: coverSvg.buildChatCoverDataUri({
        platformName: 'TikTok',
        title: `深夜语音匹配聊天录屏（${keyword}）`,
        bubble1: '还没睡吗？要不要我开语音陪你聊会天？',
        bubble2: '你声音听起来好温柔，今晚别挂太早好不好…',
        voiceSec: '14"',
        likes: 18600,
        bgm: 'TikTok 深夜氛围 BGM',
        accent: '#fe2c55',
      }),
      publishedAt: base.resolvePublishedIsoByDateRange(3, dateFrom, dateTo),
      durationSec: 15,
      bgm: 'TikTok Original Sound · 深夜治愈伴奏',
      plays: 245000,
      likes: 18600,
      comments: 980,
      shares: 1420,
      bookmarks: 3600,
      topComments: [
        { author: 'kevin_tw99', text: '求问这是哪个语音交友软件，界面看起来好干净', likes: 890 },
        { author: 'laya_buddy', text: '是 Laya 语音房吧，昨晚刚在上面连麦到超好聊的女生', likes: 430 },
      ],
      authorHandle: 'latenight_voice_tw',
      authorFollowers: 42800,
      authorAgeDays: 310,
      mediaFingerprint: 'fp_tt_7438192001001',
      visualSceneDesc: 'TikTok深色模式语音聊天气泡录屏，纯文字对话+声波动画，无真人露脸与游戏画面',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
    {
      mediaType: 'image',
      title: `TikTok 图文轮播：男生深夜聊天开场白怎么发才不尴尬？实测回复率翻倍模板 (${keyword})`,
      fullText: `把「在干嘛」换成这 3 句高情商自然开场白，对方主动接话率直接拉满！收藏起来今晚就去试试看~ #${keyword} #恋爱技巧 #聊天模板`,
      videoUrl: 'https://www.tiktok.com/@soul_memo_us/photo/7438192001002',
      coverUrl: coverSvg.buildTextPostCoverDataUri({
        platformName: 'TikTok',
        title: `男生深夜聊天开场白高情商模板 (${keyword})`,
        bodyText: '第1张图：千万别只发在干嘛；第2张图：用语气助词+具体场景切入语音话题…',
        likes: 6400,
        plays: 92000,
        mediaType: 'image',
        accent: '#fe2c55',
      }),
      publishedAt: base.resolvePublishedIsoByDateRange(7, dateFrom, dateTo),
      durationSec: 0,
      bgm: '图文热帖（无音频）',
      plays: 92000,
      likes: 6400,
      comments: 385,
      shares: 610,
      bookmarks: 2150,
      topComments: [
        { author: 'alex_dating', text: '第二页那个连麦话术亲测好用！', likes: 312 },
      ],
      authorHandle: 'soul_memo_us',
      authorFollowers: 29500,
      authorAgeDays: 260,
      mediaFingerprint: 'fp_tt_7438192001002',
      visualSceneDesc: 'TikTok图文轮播卡片截图，纯白底黑字聊天话术复盘排版，无真人露脸',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
  ];

  return templates.slice(0, maxCount).map((t) => ({
    ...t,
    platform: 'tiktok',
    sourceKeyword: keyword,
    sourceBucket: bucket,
  }));
}

async function collect({ keyword, bucket = 'generic', maxCount = 3, mode = 'hybrid', apiCfg = {}, proxy = null, dateFrom = '', dateTo = '' }) {
  if (mode === 'sandbox') {
    return buildSandboxItems(keyword, bucket, maxCount, dateFrom, dateTo);
  }

  const apiItems = await base.fetchFromThirdPartyEndpoint({
    platform: 'tiktok',
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

  let entries = await base.discoverPublicPostsBySiteQuery('site:tiktok.com', keyword, proxy, Math.max(maxCount * 2, 8), dateFrom, dateTo, { platform: 'tiktok' });
  if (entries.length < maxCount) {
    const extra = await base.discoverPublicPostsBySiteQuery('site:tiktok.com/@', keyword, proxy, Math.max(maxCount * 2, 8) - entries.length, dateFrom, dateTo, { platform: 'tiktok' });
    const seen = new Set(entries.map((e) => e.url));
    for (const item of extra) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        entries.push(item);
      }
    }
  }

  const results = [];
  for (const entry of entries) {
    try {
      const ext = await mediaExtractor.extractFromUrl(entry.url, proxy, 'tt');
      const cand = base.buildCandidateFromPublicEntry({
        platform: 'tiktok',
        entry,
        ext,
        keyword,
        bucket,
        defaultHandle: 'tiktok_creator',
        defaultVideoBgm: 'TikTok Original Sound',
        buildCoverFn: coverSvg.buildDynamicCoverForCandidate,
      });
      if (cand) results.push(cand);
    } catch (e) {
      if (e.isRateLimit) throw e;
    }
  }
  results.sort((a, b) => (Number(b.likes || 0) * 10 + Number(b.plays || 0)) - (Number(a.likes || 0) * 10 + Number(a.plays || 0)));
  return results.slice(0, maxCount);
}

module.exports = {
  id: 'tiktok',
  name: 'TikTok',
  collect,
};
