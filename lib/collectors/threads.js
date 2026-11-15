'use strict';
const crypto = require('crypto');
const base = require('./base_collector');
const coverSvg = require('./cover_svg');

const mediaExtractor = require('../media_extractor');

function buildSandboxItems(keyword, bucket, maxCount = 3, dateFrom = '', dateTo = '') {
  const hashSeed = crypto.createHash('md5').update(`threads:${keyword}`).digest('hex').slice(0, 8);
  const templates = [
    {
      title: `Threads 热议：为什么现在台湾男生脱单都不爱左滑右滑，全改玩深夜匿名语音了？`,
      fullText: `讲真的，看照片左滑右滑配对率不到1%，配对上了也是「安安你好在干嘛」尬聊死局。昨晚试了一下匿名语音速配，直接听声音对频，遇到个超健谈的高雄姐姐聊了两个钟头，比发一百条文字管用多了！ #${keyword} #Threads恋爱巷 #交友軟體實測 #語音連麥`,
      videoUrl: `https://www.threads.net/@taiwan_night_talk/post/TH_${hashSeed}_01`,
      coverUrl: coverSvg.buildChatCoverDataUri({
        platformName: 'Threads',
        title: `为什么台湾男生都不左滑全改语音速配了（${keyword}）`,
        bubble1: '左滑右滑太累了，直接听声音准多了',
        bubble2: '哈哈我也是第一次玩语音速配，你声音很像电台DJ诶',
        voiceSec: '16"',
        likes: 10850,
        bgm: '盧廣仲 - 幾分之幾',
        accent: '#10b981',
      }),
      publishedAt: base.resolvePublishedIsoByDateRange(5, dateFrom, dateTo),
      durationSec: 13,
      bgm: '盧廣仲 - 幾分之幾 (Acoustic Guitar Loop)',
      plays: 84200,
      likes: 10850,
      comments: 736,
      shares: 960,
      bookmarks: 1920,
      topComments: [
        { author: 'benny_kh', text: '真的！文字聊天根本看不出对方想不想理你，语音3秒就知道合不合拍', likes: 742 },
        { author: 'hank_0412', text: '串主用的是 Cheers 还是 Laya 啊？求分享', likes: 389 },
        { author: 'wayne_tw', text: '声音控表示语音匹配真的是伟大发明', likes: 205 },
      ],
      authorHandle: `taiwan_night_talk`,
      authorFollowers: 22400,
      authorAgeDays: 295,
      mediaFingerprint: `fp_th_${hashSeed}_01`,
      visualSceneDesc: 'Threads暗黑模式串文卡片转聊天语音条动态录屏，零露脸纯文字+声波视觉',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
    // 故意混入 1 条与 IG 完全同源搬运的视频，验证「跨平台搬运自动合并去重，不重复占表」
    {
      title: `凌晨1点在语音房匹配到声音超奶的台北妹妹，聊了40分钟直接暈船…`,
      fullText: `本来加班完超累只想找个人挂着语音听歌，随手点了匿名速配，结果对面妹妹开口第一句「哥哥今天怎么这么晚还没睡」直接让我破防了…聊到后面居然发现同城！`,
      videoUrl: `https://www.threads.net/@repost_account/post/TH_${hashSeed}_DUP`,
      coverUrl: coverSvg.buildChatCoverDataUri({ platformName: 'Threads', title: '跨平台搬运检测样本', accent: '#10b981' }),
      publishedAt: base.resolvePublishedIsoByDateRange(2, dateFrom, dateTo),
      durationSec: 16,
      bgm: 'keshi - LIMBO (Slowed + Reverb)',
      plays: 152000,
      likes: 14100,
      comments: 510,
      shares: 900,
      bookmarks: 1800,
      topComments: [],
      authorHandle: `repost_account`,
      authorFollowers: 12000,
      authorAgeDays: 190,
      mediaFingerprint: `fp_cross_latenight_01`, // 与 IG 第一条相同视频源指纹！
      visualSceneDesc: '跨平台搬运聊天录屏',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
  ];

  return templates.slice(0, maxCount).map((t) => ({
    ...t,
    platform: 'threads',
    sourceKeyword: keyword,
    sourceBucket: bucket,
  }));
}

async function collect({ keyword, bucket = 'generic', maxCount = 3, mode = 'hybrid', apiCfg = {}, proxy = null, dateFrom = '', dateTo = '' }) {
  if (mode === 'sandbox') {
    return buildSandboxItems(keyword, bucket, maxCount, dateFrom, dateTo);
  }

  const apiItems = await base.fetchFromThirdPartyEndpoint({
    platform: 'threads',
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

  let entries = await base.discoverPublicPostsBySiteQuery('site:threads.com', keyword, proxy, maxCount, dateFrom, dateTo, { platform: 'threads' });
  if (entries.length < maxCount) {
    const extra = await base.discoverPublicPostsBySiteQuery('site:threads.net', keyword, proxy, maxCount - entries.length, dateFrom, dateTo, { platform: 'threads' });
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
      const ext = await mediaExtractor.extractFromUrl(entry.url, proxy, 'th');
      const cand = base.buildCandidateFromPublicEntry({
        platform: 'threads',
        entry,
        ext,
        keyword,
        bucket,
        defaultHandle: 'threads_user',
        defaultVideoBgm: 'Threads Original Voice',
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
  id: 'threads',
  name: 'Threads',
  collect,
};
