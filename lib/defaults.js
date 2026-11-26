'use strict';
/**
 * 默认配置与预设词库定义
 * 涵盖：我方品牌词库、竞品词库、泛话题词库（含分组标签与近义词自动重试映射）、
 * 系统反爬限流参数、视觉大模型配置、飞书3×4分表同步配置与自定义扩展字段。
 */
const crypto = require('crypto');

const PLATFORMS = [
  { id: 'instagram', name: 'Instagram', shortName: 'IG', color: '#E1306C', defaultIntervalSec: 12 },
  { id: 'facebook', name: 'Facebook', shortName: 'FB', color: '#1877F2', defaultIntervalSec: 10 },
  { id: 'x', name: 'X (Twitter)', shortName: 'X', color: '#111827', defaultIntervalSec: 8 },
  { id: 'threads', name: 'Threads', shortName: 'Threads', color: '#000000', defaultIntervalSec: 10 },
  { id: 'tiktok', name: 'TikTok', shortName: 'TikTok', color: '#ff0050', defaultIntervalSec: 10 },
];

const ALL_SYNC_FIELDS = [
  { key: 'title', label: '📌 作品标题', required: true, enabled: true },
  { key: 'coverImage', label: '🖼️ 画面封面', required: false, enabled: true },
  { key: 'likes', label: '👍 点赞数', required: false, enabled: true },
  { key: 'plays', label: '▶️ 浏览/播放量', required: false, enabled: true },
  { key: 'comments', label: '💬 评论数', required: false, enabled: true },
  { key: 'viralLevel', label: '🔥 热度等级', required: false, enabled: true },
  { key: 'videoUrl', label: '🔗 原帖直达', required: true, enabled: true },
  { key: 'platformLabel', label: '📱 所属平台', required: true, enabled: true },
  { key: 'mediaFormat', label: '🎨 内容形态', required: false, enabled: true },
  { key: 'categoryLabel', label: '🏷️ 赛道归属', required: false, enabled: true },
  { key: 'publishedAt', label: '📅 发布日期', required: false, enabled: true },
  { key: 'fullText', label: '📝 原帖文案摘要', required: false, enabled: true },
  { key: 'implantGuideText', label: '🎯 软广植入与改写话术', required: false, enabled: true },
  { key: 'qualityScore', label: '💯 质量评分', required: false, enabled: false },
  { key: 'easyStarRating', label: '⭐ 好抄指数', required: false, enabled: false },
  { key: 'contentType', label: '🎬 内容分类', required: false, enabled: false },
  { key: 'implantDifficulty', label: '🚦 翻拍难度', required: false, enabled: false },
  { key: 'exposedBrandsText', label: '🏷️ 涉及品牌', required: false, enabled: false },
  { key: 'usedStatusText', label: '📌 跟进状态', required: false, enabled: false },
  { key: 'durationSec', label: '视频时长', required: false, enabled: false },
  { key: 'bgm', label: '所用BGM', required: false, enabled: false },
  { key: 'shares', label: '转发量', required: false, enabled: false },
  { key: 'bookmarks', label: '收藏量', required: false, enabled: false },
  { key: 'topCommentsText', label: 'Top3高赞热评', required: false, enabled: false },
  { key: 'replicationStepsText', label: '复刻操作步骤', required: false, enabled: false },
];

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

const PRESET_KEYWORD_PACKS = {
  male_appeal_viral: {
    name: '🔥 男性向高转化软广对标全量包（女友视角/高颜值日常/暧昧截图/搭讪）',
    bucket: 'generic',
    group: '男性向高转化对标',
    words: [
      '女友視角 | 女友视角日常 | 女友感,男友視角',
      '約會穿搭 | 高颜值日常 | 今日穿搭,對鏡自拍',
      '睡不著聊天 | 深夜陪伴破冰 | 有人還沒睡嗎,陪我聊天',
      '曖昧聊天紀錄 | 暧昧聊天截图 | 對話截圖,心動瞬間',
      '搭訕 | 脱单搭讪破冰 | 要IG,交友軟體配對',
      '脫單日常 | 脱单分享 | 甜妹日常,神回覆',
      '單身女生 | 脱单交友 | 想談戀愛,語音連麥',
    ],
  },
  tw_latenight: {
    name: '台湾/繁中深夜晕船高赞词包',
    bucket: 'generic',
    group: '深夜语音晕船类',
    words: [
      '暈船聊天紀錄 | 深夜语音晕船类 | 曖昧對話截圖,深夜聊天破防',
      '交友軟體實測 | 深夜语音晕船类 | 交友軟體推薦,語音配對',
      '語音連麥哄睡 | 深夜语音晕船类 | 女生連麥,處CP聊天',
      '女生主動私訊 | 深夜语音晕船类 | 被女生倒追,直男脫單',
      '網友見面奔現 | 深夜语音晕船类 | 網戀奔現,約會日常',
    ],
  },
  us_flirty: {
    name: '华语心动聊天与夜景氛围高赞词包（纯简繁中文）',
    bucket: 'generic',
    group: '深夜心动对话类',
    words: [
      '女生主動發消息 | 深夜心动对话类 | 曖昧訊息截圖,男生會心動的瞬間',
      '交友軟體對話 | 深夜心动对话类 | 交友軟體神回覆,匿名聊天紀錄',
      '語音聊天實測 | 深夜心动对话类 | 語音配對連麥,睡前掛睡語音',
      '直男被撩翻 | 深夜心动对话类 | 甜妹撒嬌日常,被女生倒追',
    ],
  },
  competitor_full: {
    name: '海外语音交友竞品全量包',
    bucket: 'competitor',
    group: '语音交友竞品',
    words: [
      'Litmatch | 海外语音交友 | Litmatch voice,Litmatch chat',
      'Goodnight | 台湾语音交友 | Goodnight語音,Goodnight聊天',
      'Omi | 海外恋爱交友 | Omi交友,Omi配對',
      'Cheers | 台湾语音交友 | Cheers語音,Cheers交友',
      'Soul | 语音灵魂交友 | Soul连麦,Soul语音匹配',
      'Sugo | 海外语音房 | Sugo语聊,Sugo交友',
      'WePlay | 语音互动 | WePlay语音,WePlay连麦',
      'Bumble | 海外恋爱交友 | Bumble chat',
    ],
  },
};

function defaultKeywords() {
  const now = new Date().toISOString();
  return {
    brand: [
      { id: uid('kw'), word: 'Laya', group: '品牌主词', synonyms: ['Laya语音', 'Laya App', 'Laya語音', 'Laya voice', 'Laya chat', '拉雅语音'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Laya交友', group: '品牌主词', synonyms: ['Laya聊天', 'Laya处CP'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Laya暗号', group: '暗号短链', synonyms: ['Laya房间号', 'laya.chat'], enabled: true, createdAt: now },
    ],
    competitor: [
      { id: uid('kw'), word: 'Goodnight 聊天紀錄', group: '海外语音交友', synonyms: ['Goodnight語音', 'Goodnight 交友'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Goodnight 語音', group: '海外语音交友', synonyms: ['Goodnight聊天', 'Goodnight 語音房'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Litmatch 語音', group: '海外语音交友', synonyms: ['Litmatch 聊天', 'Litmatch voice'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Litmatch 聊天', group: '海外语音交友', synonyms: ['Litmatch chat', 'Litmatch 交友'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Omi 聊天紀錄', group: '海外恋爱交友', synonyms: ['Omi 奇葩', 'Omi 網友'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Omi 奇葩', group: '海外恋爱交友', synonyms: ['Omi 交友', 'Omi 配對'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Cheers 交友', group: '台湾语音交友', synonyms: ['Cheers 語音', 'Cheers 聊天'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'WePlay 語音', group: '语音互动社交', synonyms: ['WePlay 連麥', 'WePlay 聊天'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Soul 連麥', group: '语音灵魂交友', synonyms: ['Soul 語音匹配', 'Soul 聊天記錄'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Sugo 語聊', group: '海外语音房', synonyms: ['Sugo 語音', 'Sugo 交友'], enabled: true, createdAt: now },
      { id: uid('kw'), word: 'Tinder 聊天紀錄', group: '海外恋爱交友', synonyms: ['Bumble 聊天紀錄', '交友軟體神回覆'], enabled: true, createdAt: now },
    ],
    generic: [
      { id: uid('kw'), word: '曖昧聊天紀錄', group: '可复刻聊天模板', synonyms: ['暧昧聊天记录', '聊天紀錄截圖'], enabled: true, createdAt: now },
      { id: uid('kw'), word: '對話截圖', group: '可复刻聊天模板', synonyms: ['聊天截圖', '聊天記錄'], enabled: true, createdAt: now },
      { id: uid('kw'), word: '交友軟體奇葩', group: '可复刻吐槽模板', synonyms: ['交友軟體奇遇記', '交友軟體遇到'], enabled: true, createdAt: now },
      { id: uid('kw'), word: '交友軟體神回覆', group: '可复刻对话模板', synonyms: ['神回覆', '直男聊天截圖'], enabled: true, createdAt: now },
      { id: uid('kw'), word: '語音連麥', group: '语音切片模板', synonyms: ['語音匹配', '連麥哄睡'], enabled: true, createdAt: now },
      { id: uid('kw'), word: '暈船語錄', group: '语录字卡模板', synonyms: ['備忘錄語錄', '曖昧語錄'], enabled: true, createdAt: now },
    ],
  };
}

function createDefaultDb() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {
      brandName: 'Laya',
      brandPositioning: '主打男性用户的海外高颜值语音陪伴与恋爱交友App（深夜连麦、甜妹/御姐1v1语音匹配、高回复率异性破冰）',
      operatorName: '新媒体运营团队',
      // 采集通道模式: 'fingerprint' (指纹/防封浏览器静默抓取) | 'hybrid' (公开通道抓取) | 'api_only' | 'sandbox'
      collectorMode: 'fingerprint',
      // 指纹浏览器 / 免费防封独立浏览器配置
      fingerprintBrowser: {
        provider: 'auto', // 'auto' | 'bitbrowser' | 'adspower' | 'dedicated'
        bitbrowserUrl: 'http://127.0.0.1:54345',
        bitbrowserToken: '',
        adspowerUrl: 'http://127.0.0.1:50325',
        customDebugPort: 9222,
        selectedProfileId: '',
        selectedProfileName: '',
        humanDelayMinSec: 3,
        humanDelayMaxSec: 6,
        maxDailySearchesPerAccount: 300,
        todayDate: '',
        todaySearchCount: 0,
      },
      thirdPartyApi: {
        provider: 'apify', // 'apify' | 'rapidapi' | 'rsshub' | 'custom'
        apiKey: '',
        baseUrl: '',
        apifyToken: '',
        rsshubBaseUrl: 'https://rsshub.app',
      },
      // 智能防废片与植入脚本引擎（默认使用 0 额外费用的本地智能引擎）
      visionLlm: {
        provider: 'local_free', // 'local_free' | 'gemini' | 'openai_compatible'
        apiKey: '',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        openaiBaseUrl: 'https://api.openai.com/v1',
        model: 'gemini-3.8-flash',
        openaiModel: 'gpt-4o-mini',
        strictVisionMode: true,
        allowOfflineFallbackForTest: true,
      },
      // 反爬与限流参数
      antiCrawl: {
        intervalsSec: {
          instagram: 12,
          facebook: 10,
          x: 8,
          threads: 10,
          tiktok: 10,
        },
        maxReqPerIpPerMin: 6,
        pauseMinutesOnRateLimit: 5,
        autoSynonymRetry: true,
        maxRetriesPerKeyword: 2,
        autoEvictBadProxy: true,
        proxyAlertThresholdPct: 30,
        zeroYieldAlertHours: 2,
      },
      // 过滤与评分阈值（专注高流量 + 可无限复刻自然流）
      thresholds: {
        minPlays: 20000,
        minLikes: 500,
        minQualityScore: 70,
        minAuthorFollowers: 1000,
        minAuthorAgeDays: 30,
        highLikeGreenThreshold: 10000, // 点赞>1万飞书标绿
        highDifficultyRedStar: 4,      // 植入难度>=4星飞书标红
      },
      // 定时任务设置（默认早8点、晚5点半两次全量抓取）
      schedule: {
        enabled: true,
        dailyTimes: ['08:00', '17:30'],
        activeWindowStart: '00:00',
        activeWindowEnd: '23:59',
        maxSamplesPerKeyword: 12,
        autoArchiveEnabled: true,
      },
      // 飞书授权与分表实时同步配置
      feishu: {
        appId: process.env.FEISHU_APP_ID || '',
        appSecret: process.env.FEISHU_APP_SECRET || '',
        redirectUri: '', // 为空时自动根据当前访问域名拼接 /api/feishu/oauth/callback
        authorized: false,
        userName: '',
        userOpenId: '',
        userAvatar: '',
        accessToken: '',
        refreshToken: '',
        tokenExpiresAt: 0,
        // 目标形态: 'spreadsheet' (3总表×4平台工作表) | 'bitable' (多维表格)
        targetMode: 'spreadsheet',
        // 分表维度: 'platform' (IG/FB/X/Threads) | 'contentType' (聊天录屏类/素材混剪类/泛软广类)
        splitBy: 'platform',
        targetDocUrl: '',         // 直接粘贴现有飞书表格或多维表格链接
        masterTab: true,          // 自动维护最左侧「📊 全部内容总表」（跨平台跨日汇总）
        dailyDateTab: true,       // 自动按每天日期（YYYY-MM-DD）建立今日子表并实时写入
        realtimeWebhookUrl: '',   // 免建应用极速通道：飞书群机器人 / 多维表格自动化 Webhook
        folderToken: '',
        bitableAppToken: '',
        workbooks: {
          daily: { token: '', url: '', title: '海外交友软广_单日样本总表', sheets: {} },
          weekly: { token: '', url: '', title: '海外交友软广_周度样本总表', sheets: {} },
          monthly: { token: '', url: '', title: '海外交友软广_月度样本总表', sheets: {} },
        },
        bitableTables: {},
        syncFields: ALL_SYNC_FIELDS.map((f) => ({ ...f })),
        autoRealtimeSync: true,
        syncIntervalSec: 20,
        alertWebhookUrl: process.env.FEISHU_ALERT_WEBHOOK || '',
        consecutiveFailures: 0,
        lastSyncAt: '',
        lastSyncStatus: '未绑定',
        lastArchiveDailyDate: '',
        lastArchiveWeeklyKey: '',
        lastArchiveMonthlyKey: '',
      },
      // GitHub 跨电脑网页同步配置
      githubSync: {
        repoUrl: 'https://github.com/Sorenskr/laya-social-scout.git',
        branch: 'main',
        autoPushAfterCrawl: true,
        lastPushAt: '',
        pagesUrl: 'https://sorenskr.github.io/laya-social-scout/',
      },
      // 跨电脑同网址远程控制与开机守护配置（pin 仅保存在本机 data/db.json，绝不外泄）
      remoteControl: {
        enabled: true,
        pin: '8888',
        autoStartGuardian: true,
      },
    },
    keywords: defaultKeywords(),
    customFields: [
      {
        id: 'cf_hook_style',
        key: 'hookStyle',
        label: '情绪钩子类型',
        type: 'select',
        options: ['深夜孤独破防', '甜妹反差主动', '神回复反转', '奔现暧昧纪实', '脱单干货共鸣'],
        defaultValue: '甜妹反差主动',
        syncToFeishu: true,
      },
    ],
    proxies: [],
    samples: [],       // 合格样本列表（≥合格线且通过一票否决）
    trash: [],         // 垃圾库 / 回收站（含一票否决废片、低分过滤片、人工删除/标记垃圾内容，可一键恢复）
    caseAnalyses: [],  // 丢链接/传图片拆解的案例历史
    blacklist: {
      accounts: [],    // { id, platform, handle, reason, sourceSampleId, createdAt }
      keywords: [      // 人工标记垃圾后沉淀的特征屏蔽词
        { id: uid('blk'), word: '王者荣耀五排', reason: '游戏开黑废片特征', createdAt: new Date().toISOString() },
        { id: uid('blk'), word: '和平精英陪玩', reason: '游戏陪玩废片特征', createdAt: new Date().toISOString() },
        { id: uid('blk'), word: '扫码领福利下载', reason: '直白硬广话术', createdAt: new Date().toISOString() },
      ],
    },
    feishuQueue: [],   // 待实时写入飞书队列 { id, sampleId, attempts, nextRetryAt, lastError, status }
    rateLimitLogs: [], // 限流与换IP换近义词重试日志
    operationLogs: [], // 全操作留痕日志
    alerts: [],        // 页面顶部告警与飞书推送告警记录
    platformRuntime: {
      instagram: { lastSuccessAt: '', lastAttemptAt: '', cooldownUntil: 0, totalFetched: 0, totalQualified: 0, lastError: '' },
      facebook: { lastSuccessAt: '', lastAttemptAt: '', cooldownUntil: 0, totalFetched: 0, totalQualified: 0, lastError: '' },
      x: { lastSuccessAt: '', lastAttemptAt: '', cooldownUntil: 0, totalFetched: 0, totalQualified: 0, lastError: '' },
      threads: { lastSuccessAt: '', lastAttemptAt: '', cooldownUntil: 0, totalFetched: 0, totalQualified: 0, lastError: '' },
      tiktok: { lastSuccessAt: '', lastAttemptAt: '', cooldownUntil: 0, totalFetched: 0, totalQualified: 0, lastError: '' },
    },
  };
}

module.exports = {
  PLATFORMS,
  ALL_SYNC_FIELDS,
  PRESET_KEYWORD_PACKS,
  uid,
  defaultKeywords,
  createDefaultDb,
};
