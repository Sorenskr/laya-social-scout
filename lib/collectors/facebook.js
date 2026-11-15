'use strict';
const crypto = require('crypto');
const base = require('./base_collector');
const coverSvg = require('./cover_svg');

const mediaExtractor = require('../media_extractor');

function buildSandboxItems(keyword, bucket, maxCount = 3, dateFrom = '', dateTo = '') {
  const hashSeed = crypto.createHash('md5').update(`fb:${keyword}`).digest('hex').slice(0, 8);
  const templates = [
    {
      title: `单身第3年才懂：下班回家耳机里有人温柔问你「今天累不累」有多治愈`,
      fullText: `三十岁男人的快乐其实很简单，不用查户口式的相亲，下班把车停在地下车库，打开语音连麦听对面的温柔姐姐聊十分钟废话，整个人都被治愈了。 #${keyword} #深夜陪伴 #男人的快乐 #脫單日常`,
      videoUrl: `https://www.facebook.com/reel/FB_${hashSeed}_01`,
      coverUrl: coverSvg.buildMoodCoverDataUri({
        platformName: 'FB Reels',
        title: `下班停好车不想上楼的10分钟（${keyword}）`,
        headline: '下班停好车不想上楼的10分钟',
        subline: '耳机里传来一句：今天辛苦啦',
        likes: 11200,
        bgm: 'Raining in Taipei',
        accent: '#1877f2',
      }),
      publishedAt: base.resolvePublishedIsoByDateRange(6, dateFrom, dateTo),
      durationSec: 17,
      bgm: 'Raining in Taipei · 深夜车载钢琴曲',
      plays: 96500,
      likes: 11200,
      comments: 518,
      shares: 1340,
      bookmarks: 2080,
      topComments: [
        { author: 'Mark Lin', text: '太真实了，每天在车库待半小时才上楼，求问这是什么语音软体？', likes: 615 },
        { author: 'David Wu', text: '之前在 Omi 划半天没人理，还是这种直接语音连麦舒服', likes: 244 },
        { author: 'Chris Ho', text: '求老哥私一个软件名，晚上失眠太需要人陪聊了', likes: 169 },
      ],
      authorHandle: `carpark.story.${hashSeed.slice(0, 4)}`,
      authorFollowers: 27600,
      authorAgeDays: 510,
      mediaFingerprint: `fp_fb_${hashSeed}_01`,
      visualSceneDesc: '雨夜车内中控台与城市霓虹空镜混剪，叠加手机锁屏语音消息弹窗，全程不露脸',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
    // 故意混入 1 条「王者荣耀/手游开黑」废片验证游戏一票否决过滤
    {
      title: `王者荣耀五排带妹连麦语音，辅助妹妹操作笑死我了`,
      fullText: `昨晚打排位赛游戏陪玩连麦全场爆笑，这操作真是绝了 #${keyword} #王者荣耀 #电竞开黑`,
      videoUrl: `https://www.facebook.com/reel/FB_${hashSeed}_TRAP_GAME`,
      coverUrl: coverSvg.buildTrapCoverDataUri({ trapType: 'game', label: '王者荣耀排位赛手游录屏画面' }),
      publishedAt: base.resolvePublishedIsoByDateRange(4, dateFrom, dateTo),
      durationSec: 24,
      bgm: 'Game Battle BGM',
      plays: 53000,
      likes: 2100,
      comments: 140,
      shares: 90,
      bookmarks: 150,
      topComments: [{ author: 'gamer1', text: '带我上星耀！', likes: 33 }],
      authorHandle: `moba_king_clips`,
      authorFollowers: 14000,
      authorAgeDays: 200,
      mediaFingerprint: `fp_trap_game_${hashSeed}`,
      visualSceneDesc: '横屏MOBA手游对战摇杆与技能录屏画面',
      visualHints: { isGameOrAnime: true },
    },
  ];

  return templates.slice(0, maxCount).map((t) => ({
    ...t,
    platform: 'facebook',
    sourceKeyword: keyword,
    sourceBucket: bucket,
  }));
}

async function collect({ keyword, bucket = 'generic', maxCount = 3, mode = 'hybrid', apiCfg = {}, proxy = null, dateFrom = '', dateTo = '' }) {
  if (mode === 'sandbox') {
    return buildSandboxItems(keyword, bucket, maxCount, dateFrom, dateTo);
  }

  const apiItems = await base.fetchFromThirdPartyEndpoint({
    platform: 'facebook',
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

  const entries = await base.discoverPublicPostsBySiteQuery('site:facebook.com', keyword, proxy, maxCount, dateFrom, dateTo, { platform: 'facebook' });
  const results = [];
  for (const entry of entries) {
    try {
      const ext = await mediaExtractor.extractFromUrl(entry.url, proxy, 'fb');
      const cand = base.buildCandidateFromPublicEntry({
        platform: 'facebook',
        entry,
        ext,
        keyword,
        bucket,
        defaultHandle: 'fb_creator',
        defaultVideoBgm: 'Facebook Reels Original Sound',
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
  id: 'facebook',
  name: 'Facebook',
  collect,
};
