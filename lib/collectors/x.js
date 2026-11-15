'use strict';
const crypto = require('crypto');
const base = require('./base_collector');
const coverSvg = require('./cover_svg');

const mediaExtractor = require('../media_extractor');

function buildSandboxItems(keyword, bucket, maxCount = 3, dateFrom = '', dateTo = '') {
  const hashSeed = crypto.createHash('md5').update(`x:${keyword}`).digest('hex').slice(0, 8);
  const templates = [
    {
      title: `网友面基前先连麦了三天，没想到见到真人比语音里还要甜（纯聊天记录复盘）`,
      fullText: `以前一直觉得交友软件上都是照骗或者冷场王，直到上周在语音速配遇到这个学插画的妹妹，连续三天挂着语音睡觉，今天约在信义区猫咖奔现成功！给兄弟们分享全套破冰聊天记录 #${keyword} #网友面基 #处CP #恋爱日常`,
      videoUrl: `https://x.com/dating_memo_${hashSeed.slice(0, 4)}/status/18900${hashSeed.replace(/\D/g, '8').slice(0, 8)}`,
      coverUrl: coverSvg.buildChatCoverDataUri({
        platformName: 'X Video',
        title: `网友面基前先连麦三天奔现成功（${keyword}）`,
        bubble1: '我到猫咖门口啦，穿白色针织衫那个是不是你？',
        bubble2: '别回头！我已经看到你拿着热美式了哈哈',
        voiceSec: '8"',
        likes: 8940,
        bgm: 'Sunset Rollercoaster - My Jinji',
        accent: '#0ea5e9',
      }),
      publishedAt: base.resolvePublishedIsoByDateRange(8, dateFrom, dateTo),
      durationSec: 15,
      bgm: 'Sunset Rollercoaster - My Jinji (Instrumental)',
      plays: 112000,
      likes: 8940,
      comments: 412,
      shares: 1520,
      bookmarks: 4210,
      topComments: [
        { author: 'taipei_bro', text: '求问老哥用的哪个App？Litmatch 还是 Laya？', likes: 520 },
        { author: 'sky_walker9', text: '先语音连麦听声音真的能筛掉99%的抠脚大汉和冷场王', likes: 318 },
        { author: 'raymond_k', text: '已收藏，今晚就照着第一句开场白去试试', likes: 145 },
      ],
      authorHandle: `dating_memo_${hashSeed.slice(0, 4)}`,
      authorFollowers: 41200,
      authorAgeDays: 680,
      mediaFingerprint: `fp_x_${hashSeed}_01`,
      visualSceneDesc: 'X平台竖版双人聊天滚动录屏配咖啡杯手部局部空镜，无任何人物正脸或小窗露脸',
      visualHints: { hasHumanFace: false, isGameOrAnime: false },
    },
    // 故意混入 1 条「直白硬广推销」废片验证硬广一票否决
    {
      title: `同城高颜值小姐姐在线陪聊，快来下载领取新人免费连麦券！`,
      fullText: `还在单身吗？扫码领福利，我在甜心语音等你，点击主页链接快来下载立即脱单！ #${keyword}`,
      videoUrl: `https://x.com/spam_ad_bot/status/18999${hashSeed.replace(/\D/g, '2').slice(0, 8)}`,
      coverUrl: coverSvg.buildTrapCoverDataUri({ trapType: 'ad', label: '全屏大字海报：扫码领福利快来下载' }),
      publishedAt: base.resolvePublishedIsoByDateRange(2, dateFrom, dateTo),
      durationSec: 12,
      bgm: 'Promo Beat',
      plays: 15000,
      likes: 320,
      comments: 12,
      shares: 5,
      bookmarks: 9,
      topComments: [],
      authorHandle: `spam_ad_bot`,
      authorFollowers: 2600,
      authorAgeDays: 90,
      mediaFingerprint: `fp_trap_ad_${hashSeed}`,
      visualSceneDesc: '硬广下载二维码海报',
      visualHints: { isHardAd: true },
    },
    // 故意混入 1 条「粉丝<1000、注册<30天」低质测试号内容验证硬过滤
    {
      title: `测试发布一段聊天视频看看有没有流量`,
      fullText: `随手发一条聊天截图 #${keyword}`,
      videoUrl: `https://x.com/newbie_test_001/status/18988${hashSeed.replace(/\D/g, '3').slice(0, 8)}`,
      coverUrl: coverSvg.buildChatCoverDataUri({ platformName: 'X', title: '低粉测试号聊天截图', accent: '#64748b' }),
      publishedAt: base.resolvePublishedIsoByDateRange(1, dateFrom, dateTo),
      durationSec: 9,
      bgm: 'None',
      plays: 6500,
      likes: 210,
      comments: 4,
      shares: 2,
      bookmarks: 6,
      topComments: [],
      authorHandle: `newbie_test_001`,
      authorFollowers: 380, // < 1000 粉丝！应被一票否决
      authorAgeDays: 12,    // < 30 天！应被一票否决
      mediaFingerprint: `fp_trap_lowacc_${hashSeed}`,
      visualSceneDesc: '简单聊天截图',
      visualHints: {},
    },
  ];

  return templates.slice(0, maxCount).map((t) => ({
    ...t,
    platform: 'x',
    sourceKeyword: keyword,
    sourceBucket: bucket,
  }));
}

async function collect({ keyword, bucket = 'generic', maxCount = 3, mode = 'hybrid', apiCfg = {}, proxy = null, dateFrom = '', dateTo = '' }) {
  if (mode === 'sandbox') {
    return buildSandboxItems(keyword, bucket, maxCount, dateFrom, dateTo);
  }

  const apiItems = await base.fetchFromThirdPartyEndpoint({
    platform: 'x',
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

  const fetchLimit = Math.max(maxCount, 6);
  let entries = await base.discoverPublicPostsBySiteQuery('site:x.com', keyword, proxy, fetchLimit, dateFrom, dateTo, { platform: 'x' });
  if (entries.length < maxCount) {
    const extra = await base.discoverPublicPostsBySiteQuery('site:twitter.com', keyword, proxy, fetchLimit - entries.length, dateFrom, dateTo, { platform: 'x' });
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
      const ext = await mediaExtractor.extractFromUrl(entry.url, proxy, 'x');
      const cand = base.buildCandidateFromPublicEntry({
        platform: 'x',
        entry,
        ext,
        keyword,
        bucket,
        defaultHandle: 'x_creator',
        defaultVideoBgm: 'X Viral Voice Clip',
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
  id: 'x',
  name: 'X (Twitter)',
  collect,
};
