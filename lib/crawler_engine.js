'use strict';
/**
 * 核心采集编排与反爬限流自愈引擎
 * 串联：平台轮询 -> 独立间隔控制 -> 代理IP轮换 -> 空结果/限流自动换新IP+替换近义词重试 ->
 *       跨平台去重合并 -> 视觉大模型防废片审核与植入脚本生成 -> 合格入库/废片进垃圾库 -> 1分钟内飞书实时同步
 */
const { uid } = require('./defaults');
const store = require('./store');
const proxyPool = require('./proxy_pool');
const deduper = require('./deduper');
const visionAuditor = require('./vision_auditor');
const feishuSync = require('./feishu_sync');
const registry = require('./collectors/registry');
const coverCache = require('./cover_cache');
const githubSync = require('./github_sync');
const fingerprintBrowser = require('./fingerprint_browser');

const BUILTIN_SYNONYMS = {
  语音匹配: ['处CP聊天', '女生连麦', '匿名语音速配'],
  语音连麦: ['处CP聊天', '深夜连麦哄睡', '女生连麦'],
  处CP: ['网恋处对象', '恋爱体验卡', '语音处CP'],
  聊天记录: ['暧昧聊天记录', '暈船聊天紀錄', '女生主动私信'],
  脱单: ['直男脱单', '母胎单身恋爱', '脫單日常'],
  女生搭讪: ['甜妹主动私信', '被女生倒追', '御姐撩人'],
  相亲奇葩事: ['相亲聊天记录', '网友面基故事'],
};

let activeJob = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSynonymsForKeyword(kwObj) {
  const custom = Array.isArray(kwObj.synonyms) ? kwObj.synonyms.filter(Boolean) : [];
  const builtin = BUILTIN_SYNONYMS[kwObj.word] || [];
  return Array.from(new Set([...custom, ...builtin])).filter((w) => w !== kwObj.word);
}

function buildSampleEntity(candidate, auditResult, db) {
  const customValues = {};
  for (const cf of db.customFields || []) {
    if (cf.key === 'hookStyle' && auditResult.hookStyle) {
      customValues[cf.key] = auditResult.hookStyle;
    } else {
      customValues[cf.key] = (candidate.customValues && candidate.customValues[cf.key]) ?? cf.defaultValue ?? '';
    }
  }

  return {
    id: uid('smp'),
    platform: candidate.platform,
    mediaType: candidate.mediaType || 'video',
    mergedPlatforms: [candidate.platform],
    alternateUrls: [],
    duplicateCount: 1,
    title: candidate.title || '未命名社媒交友样本',
    fullText: candidate.fullText || '',
    videoUrl: candidate.videoUrl || '',
    coverUrl: candidate.coverUrl || '',
    publishedAt: candidate.publishedAt || new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    durationSec: candidate.mediaType && candidate.mediaType !== 'video' ? 0 : Number(candidate.durationSec ?? 15),
    bgm: candidate.bgm || 'Original Audio',
    plays: Number(candidate.plays || 0),
    likes: Number(candidate.likes || 0),
    comments: Number(candidate.comments || 0),
    shares: Number(candidate.shares || 0),
    bookmarks: Number(candidate.bookmarks || 0),
    topComments: Array.isArray(candidate.topComments) ? candidate.topComments.slice(0, 3) : [],
    authorHandle: candidate.authorHandle || 'unknown',
    authorFollowers: Number(candidate.authorFollowers || 0),
    authorAgeDays: Number(candidate.authorAgeDays || 180),
    sourceKeyword: candidate.sourceKeyword || '',
    categoryGroup: auditResult.categoryGroup || candidate.sourceBucket || 'generic', // 'brand' | 'competitor' | 'generic'
    exposedBrands: auditResult.exposedBrands || [],
    contentType: auditResult.contentType || '聊天录屏类',
    hasHumanFace: Boolean(auditResult.hasHumanFace),
    isGameRelated: Boolean(auditResult.isGameOrAnime),
    implantDifficulty: Number(auditResult.implantDifficulty || 2),
    qualityScore: Number(auditResult.qualityScore || 75),
    dimensions: auditResult.dimensions || {},
    implantGuide: auditResult.implantGuide || {},
    replicationSteps: auditResult.replicationSteps || [],
    auditEngine: auditResult.auditEngine || 'vision_llm',
    contentHash: deduper.computeContentHash(candidate),
    mediaFingerprint: candidate.mediaFingerprint || '',
    favorited: false,
    markedUsed: false,
    feishuSynced: false,
    feishuSyncedAt: '',
    customValues,
  };
}

function buildTrashEntity(candidate, filterCategory, vetoReason, auditResult, trashType = 'auto_filtered') {
  return {
    id: uid('trsh'),
    trashType, // 'auto_filtered' | 'manual_spam' | 'manual_deleted'
    filterCategory: filterCategory || '自动过滤',
    vetoReason: vetoReason || '未通过质量与防废片规则',
    platform: candidate.platform,
    mediaType: candidate.mediaType || 'video',
    title: candidate.title || '',
    fullText: candidate.fullText || '',
    videoUrl: candidate.videoUrl || '',
    coverUrl: candidate.coverUrl || '',
    publishedAt: candidate.publishedAt || new Date().toISOString(),
    trashedAt: new Date().toISOString(),
    durationSec: candidate.mediaType && candidate.mediaType !== 'video' ? 0 : Number(candidate.durationSec ?? 15),
    bgm: candidate.bgm || '',
    plays: Number(candidate.plays || 0),
    likes: Number(candidate.likes || 0),
    comments: Number(candidate.comments || 0),
    shares: Number(candidate.shares || 0),
    bookmarks: Number(candidate.bookmarks || 0),
    topComments: candidate.topComments || [],
    authorHandle: candidate.authorHandle || '',
    authorFollowers: Number(candidate.authorFollowers || 0),
    authorAgeDays: Number(candidate.authorAgeDays || 0),
    sourceKeyword: candidate.sourceKeyword || '',
    sourceBucket: candidate.sourceBucket || 'generic',
    qualityScore: Number((auditResult && auditResult.qualityScore) || 0),
    hasHumanFace: Boolean(auditResult && auditResult.hasHumanFace),
    isGameRelated: Boolean(auditResult && auditResult.isGameOrAnime),
    contentHash: deduper.computeContentHash(candidate),
    mediaFingerprint: candidate.mediaFingerprint || '',
  };
}

function pushLiveLog(msg) {
  if (!activeJob) return;
  if (!Array.isArray(activeJob.liveLogs)) activeJob.liveLogs = [];
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  activeJob.liveLogs.unshift({ time: t, text: msg });
  if (activeJob.liveLogs.length > 30) activeJob.liveLogs.length = 30;
}

function isWithinDateRange(isoDate, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true;
  const ts = new Date(isoDate || 0).getTime();
  if (Number.isNaN(ts)) return true;
  if (dateFrom) {
    const startMs = new Date(`${dateFrom}T00:00:00`).getTime();
    if (ts < startMs) return false;
  }
  if (dateTo) {
    const endMs = new Date(`${dateTo}T23:59:59.999`).getTime();
    if (ts > endMs) return false;
  }
  return true;
}

/**
 * 执行一次可配置的采集任务（支持按指定日期范围抓取 + 实时大白话播报）
 */
async function runCrawlTask({
  platforms = ['instagram', 'facebook', 'x', 'threads', 'tiktok'],
  buckets = ['brand', 'competitor', 'generic'],
  customKeywords = [],
  maxTotalCandidates = 24,
  targetQualifiedCount = 0,
  dateFrom = '',
  dateTo = '',
  modeOverride = '',
  ignoreDailyQuota = false,
  fastTest = true,
  awaitFeishuSync = false,
  operator = '运营手动触发',
} = {}) {
  if (activeJob && activeJob.running) {
    return { alreadyRunning: true, job: activeJob };
  }

  const db = store.getDb();
  const mode = modeOverride || db.settings.collectorMode || 'hybrid';
  const antiCrawl = db.settings.antiCrawl || {};
  const maxRetries = Number(antiCrawl.maxRetriesPerKeyword ?? 2);
  const pauseMinutes = Number(antiCrawl.pauseMinutesOnRateLimit ?? 5);
  const dateLabel = dateFrom || dateTo ? `${dateFrom || '最早'} 至 ${dateTo || '今天'}` : '不限发布日期';

  const parsedCustomList = Array.isArray(customKeywords)
    ? customKeywords.map((s) => String(s || '').trim()).filter(Boolean)
    : String(customKeywords || '').split(/[,，\r\n;；]+/).map((s) => s.trim()).filter(Boolean);
  const hasCustomKeywords = parsedCustomList.length > 0;

  activeJob = {
    id: uid('job'),
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    mode,
    browserChannelLabel: mode === 'fingerprint' ? '🛡️ 指纹/防封浏览器通道' : mode === 'sandbox' ? '🧪 本地模拟演练' : '🌐 公开网页/代理通道',
    platforms,
    dateFrom,
    dateTo,
    dateRangeLabel: dateLabel,
    targetMax: maxTotalCandidates,
    progressPct: 5,
    totalFetched: 0,
    fetchedCount: 0,
    qualifiedAdded: 0,
    qualifiedCount: 0,
    filteredTrash: 0,
    filteredCount: 0,
    feishuSyncedCount: 0,
    duplicatesMerged: 0,
    rateLimitRetries: 0,
    recentFoundSamples: [],
    currentStep: `正在启动抓视频任务（时间范围：${dateLabel}${hasCustomKeywords ? ` · 指定词：${parsedCustomList.slice(0, 3).join('/')}` : ''}）…`,
    liveLogs: [],
  };
  pushLiveLog(`🚀 开始抓视频（范围：${dateLabel}，通道：${activeJob.browserChannelLabel}，${hasCustomKeywords ? `只搜指定词 [${parsedCustomList.join('、')}]` : `计划最多看 ${maxTotalCandidates} 条`}）`);

  let noBrowserHinted = false;
  let effectiveMode = mode;
  const unloggedFpPlatforms = new Set();

  try {
    // 若传入指定关键词，则 100% 仅按指定词搜索；否则组装已启用的词库（均衡兼顾泛流量与竞品词）
    const orderedBuckets = [...(buckets.includes('brand') ? ['brand'] : []), ...buckets.filter((b) => b !== 'brand')];
    const keywordQueue = [];
    if (hasCustomKeywords) {
      for (const word of parsedCustomList) {
        keywordQueue.push({
          id: uid('ckw'),
          word,
          group: '指定搜索词',
          synonyms: [],
          bucket: 'generic',
          _isCustom: true,
        });
      }
    } else {
      for (const bucket of orderedBuckets) {
        const list = (db.keywords[bucket] || []).filter((k) => k.enabled !== false);
        for (const kw of list) {
          keywordQueue.push({ ...kw, bucket });
        }
      }
    }

    if (!keywordQueue.length) {
      throw new Error('当前所选词库没有启用的关键词，请先在【搜索词管理页】添加或开启关键词，或直接在弹窗里填指定关键词');
    }

    let fetchedCount = 0;
    const perPlatformBudget = Math.max(4, Math.ceil(maxTotalCandidates / Math.max(1, platforms.length)));

    for (const platformId of platforms) {
      if (fetchedCount >= maxTotalCandidates) break;
      const collector = registry.getCollector(platformId);
      if (!collector) continue;

      const rt = db.platformRuntime[platformId] || (db.platformRuntime[platformId] = {});
      rt.lastAttemptAt = new Date().toISOString();
      let platformFetched = 0;

      // 若使用指定关键词，逐词全跑；否则最多取 2 个 brand 词，把剩余配额均匀留给 generic / competitor 热词
      let selectedKws = [];
      if (hasCustomKeywords) {
        selectedKws = [...keywordQueue];
      } else {
        const perPlatformKwLimit = Math.max(8, Math.ceil(perPlatformBudget / 2));
        const brandKws = orderedBuckets.includes('brand') ? keywordQueue.filter((k) => k.bucket === 'brand') : [];
        const nonBrandKws = keywordQueue.filter((k) => k.bucket !== 'brand');
        const brandPart = brandKws.slice(0, nonBrandKws.length > 0 ? 2 : perPlatformKwLimit);
        selectedKws = [
          ...brandPart,
          ...nonBrandKws.slice(0, Math.max(0, perPlatformKwLimit - brandPart.length)),
        ];
      }

      for (let kIdx = 0; kIdx < selectedKws.length; kIdx++) {
        if (fetchedCount >= maxTotalCandidates || platformFetched >= perPlatformBudget) break;
        if (targetQualifiedCount > 0 && activeJob.qualifiedCount >= targetQualifiedCount) break;
        const kwObj = selectedKws[kIdx];
        const synonyms = antiCrawl.autoSynonymRetry !== false ? getSynonymsForKeyword(kwObj) : [];

        let triedProxyIds = [];
        let attempt = 0;
        let currentWord = kwObj.word;
        let rawItems = [];
        let skipPlatformBecauseLogin = false;

        while (attempt <= maxRetries) {
          const proxy = proxyPool.selectProxyForPlatform(platformId, triedProxyIds);
          if (proxy) triedProxyIds.push(proxy.id);
          const proxyLabel = proxyPool.formatProxyLabel(proxy);

          activeJob.currentStep = `正在去 ${collector.name} 搜「${currentWord}」(第${attempt + 1}次)…`;
          pushLiveLog(`🔍 正在去 ${collector.name} 搜「${currentWord}」（${effectiveMode === 'fingerprint' ? '防封静默窗口' : `使用线路：${proxyLabel}`}）`);

          try {
            const perCallMax = Math.min(
              Math.max(4, Number(db.settings.schedule?.maxSamplesPerKeyword || 12)),
              perPlatformBudget - platformFetched,
              maxTotalCandidates - fetchedCount
            );
            if (effectiveMode === 'fingerprint') {
              if (!unloggedFpPlatforms.has(platformId)) {
                try {
                  rawItems = await fingerprintBrowser.collectViaFingerprintBrowser({
                    platform: platformId,
                    keywordObj: { ...kwObj, word: currentWord },
                    settings: db.settings,
                    maxItems: Math.max(1, perCallMax),
                    dateFrom,
                    dateTo,
                    ignoreDailyQuota: Boolean(ignoreDailyQuota || hasCustomKeywords),
                    onProgress: (msg) => {
                      activeJob.currentStep = msg;
                      pushLiveLog(msg);
                    },
                  });
                } catch (fpErr) {
                  if (fpErr && fpErr.code === 'NEED_MANUAL_LOGIN_OR_CHECK') {
                    unloggedFpPlatforms.add(platformId);
                    activeJob.currentStep = fpErr.message;
                    pushLiveLog(`⚠️ ${collector.name} 在防封窗口未登录，已自动无缝切换公开检索通道补充抓取`);
                    await store.raiseAlert({
                      type: `browser_login_${platformId}`,
                      level: 'warning',
                      title: `${collector.name} 需要你先手动登录或确认一下`,
                      message: fpErr.message,
                    });
                    rawItems = [];
                  } else if (fpErr && fpErr.message === 'NO_FINGERPRINT_BROWSER_ONLINE') {
                    effectiveMode = 'hybrid';
                    activeJob.browserChannelLabel = '🌐 公开网页兜底通道（未开防封窗）';
                    if (!noBrowserHinted) {
                      noBrowserHinted = true;
                      pushLiveLog('💡 还没检测到开着的比特浏览器或免费防封窗口，已先自动切到公开网页通道抓一轮（点设置可一键打开专属防封浏览器）');
                    }
                    rawItems = [];
                  } else {
                    throw fpErr;
                  }
                }
              }
              if (!Array.isArray(rawItems) || rawItems.length === 0) {
                pushLiveLog(`🌐 ${collector.name} 正在通过公开检索通道补充搜「${currentWord}」…`);
                rawItems = await collector.collect({
                  keyword: currentWord,
                  bucket: kwObj.bucket,
                  maxCount: Math.max(1, perCallMax),
                  mode: 'hybrid',
                  apiCfg: db.settings.thirdPartyApi || {},
                  proxy,
                  retryAttempt: attempt,
                  dateFrom,
                  dateTo,
                });
              }
            } else {
              rawItems = await collector.collect({
                keyword: currentWord,
                bucket: kwObj.bucket,
                maxCount: Math.max(1, perCallMax),
                mode: effectiveMode,
                apiCfg: db.settings.thirdPartyApi || {},
                proxy,
                retryAttempt: attempt,
                dateFrom,
                dateTo,
              });
            }

            if (proxy) await proxyPool.reportProxyResult(proxy.id, true);

            if (Array.isArray(rawItems) && rawItems.length > 0) {
              if (attempt > 0) {
                pushLiveLog(`🔄 「${kwObj.word}」遇到拦截，已自动换新IP改搜「${currentWord}」成功！`);
                store.addRateLimitLog({
                  platform: platformId,
                  proxyLabel,
                  keyword: kwObj.word,
                  fallbackKeyword: currentWord,
                  retryCount: attempt,
                  reason: '更换新代理IP并替换近义词后重试抓取成功',
                  resolved: true,
                });
              }
              break;
            }

            // 返回 0 条空结果 -> 触发换新IP + 自动替换近义词重试，不直接返回 0 条！
            const nextSynonym = synonyms[attempt] || `${kwObj.word} 恋爱`;
            activeJob.rateLimitRetries++;
            pushLiveLog(`⚠️ 在 ${collector.name} 搜「${currentWord}」没抓到东西，正在换新IP改搜「${nextSynonym}」…`);
            store.addRateLimitLog({
              platform: platformId,
              proxyLabel,
              keyword: kwObj.word,
              fallbackKeyword: nextSynonym,
              retryCount: attempt + 1,
              reason: `关键词「${currentWord}」返回空结果，记录5分钟冷却标记并切换新IP+近义词「${nextSynonym}」重试`,
              resolved: false,
            });
            rt.cooldownUntil = Date.now() + pauseMinutes * 60 * 1000;
            currentWord = nextSynonym;
            attempt++;
          } catch (err) {
            if (proxy) await proxyPool.reportProxyResult(proxy.id, false, err.message);
            const nextSynonym = synonyms[attempt] || currentWord;
            activeJob.rateLimitRetries++;
            rt.cooldownUntil = Date.now() + pauseMinutes * 60 * 1000;
            rt.lastError = err.message;
            pushLiveLog(`🛡️ ${collector.name}「${currentWord}」被限流，已换新IP改搜「${nextSynonym}」重试`);

            store.addRateLimitLog({
              platform: platformId,
              proxyLabel,
              keyword: kwObj.word,
              fallbackKeyword: nextSynonym,
              retryCount: attempt + 1,
              reason: `${err.message || '平台风控限流'}（已标记暂停冷却 ${pauseMinutes} 分钟，立即切换新IP与近义词「${nextSynonym}」重试）`,
              resolved: false,
            });

            currentWord = nextSynonym;
            attempt++;
            if (!fastTest) {
              await sleep(Math.min(3000, pauseMinutes * 60 * 1000));
            }
          }
        }

        if (skipPlatformBecauseLogin) break;

        // 优先处理 Laya 相关及高赞高浏览内容
        rawItems.sort((a, b) => {
          const textA = `${a.title || ''} ${a.fullText || ''} ${a.matchedKeyword || ''}`;
          const textB = `${b.title || ''} ${b.fullText || ''} ${b.matchedKeyword || ''}`;
          const layaA = a.keywordBucket === 'brand' || /laya|拉雅/i.test(textA) ? 1 : 0;
          const layaB = b.keywordBucket === 'brand' || /laya|拉雅/i.test(textB) ? 1 : 0;
          if (layaA !== layaB) return layaB - layaA;
          return Number(b.likes || 0) * 10 + Number(b.plays || 0) - (Number(a.likes || 0) * 10 + Number(a.plays || 0));
        });

        // 逐条执行日期过滤、封面下载、去重、AI防废片审核、入库与飞书同步
        for (const cand of rawItems) {
          if (fetchedCount >= maxTotalCandidates || platformFetched >= perPlatformBudget) break;
          if (targetQualifiedCount > 0 && activeJob.qualifiedCount >= targetQualifiedCount) break;
          if (!isWithinDateRange(cand.publishedAt, dateFrom, dateTo)) {
            pushLiveLog(`⏭️ 跳过不在所选日期内的旧视频：《${(cand.title || '').slice(0, 18)}》`);
            continue;
          }

          fetchedCount++;
          platformFetched++;
          activeJob.totalFetched++;
          activeJob.fetchedCount = activeJob.totalFetched;
          activeJob.progressPct = Math.min(95, Math.max(10, Math.round((fetchedCount / maxTotalCandidates) * 90) + 5));
          rt.totalFetched = (rt.totalFetched || 0) + 1;

          if (kwObj._isCustom) {
            cand._forceCustomKeyword = true;
          }

          // 确保封面大图尽可能保存到本地 covers/ 文件夹，跨电脑打开不裂图
          if (cand.coverUrl && /^https?:\/\//i.test(cand.coverUrl)) {
            cand.coverUrl = await coverCache.cacheCoverImage(cand.coverUrl, platformId.slice(0, 2));
          }
          if (!cand.coverUrl || !String(cand.coverUrl).startsWith('./covers/')) {
            try {
              await fingerprintBrowser.ensureRealJpgCoversViaCdp([cand], db.settings);
            } catch (_) {}
          }

          // 1. 跨平台搬运与重复识别
          const dupCheck = deduper.findDuplicate(cand, db.samples, db.trash);
          if (dupCheck.isDuplicate) {
            if (dupCheck.location === 'samples' && dupCheck.matchedItem) {
              deduper.mergeDuplicateIntoExisting(dupCheck.matchedItem, cand);
              activeJob.duplicatesMerged++;
              pushLiveLog(`🔗 发现跨平台搬运同款视频，已自动合并省去重复占表：《${(cand.title || '').slice(0, 18)}》`);
            } else {
              activeJob.filteredTrash++;
              activeJob.filteredCount = activeJob.filteredTrash;
            }
            continue;
          }

          // 2. 全量本地0费用/大模型防废片审核 + 五维评分 + 定制植入脚本
          activeJob.currentStep = `正在检查《${(cand.title || '').slice(0, 18)}》的封面是不是露脸/游戏废片…`;
          const auditOutcome = await visionAuditor.auditCandidateSample(cand, null);

          if (!auditOutcome.qualified) {
            const trashItem = buildTrashEntity(
              cand,
              auditOutcome.filterCategory,
              auditOutcome.vetoReason,
              auditOutcome.auditResult,
              'auto_filtered'
            );
            db.trash.unshift(trashItem);
            if (db.trash.length > 500) db.trash.length = 500;
            activeJob.filteredTrash++;
            activeJob.filteredCount = activeJob.filteredTrash;
            pushLiveLog(`❌ 踢掉废片《${(cand.title || '').slice(0, 16)}》— ${auditOutcome.filterCategory}`);
            continue;
          }

          // 3. 合格样本入库并边抓边写飞书当日表
          const sample = buildSampleEntity(cand, auditOutcome.auditResult, db);
          db.samples.unshift(sample);
          activeJob.qualifiedAdded++;
          activeJob.qualifiedCount = activeJob.qualifiedAdded;
          activeJob.recentFoundSamples.unshift({
            id: sample.id,
            title: sample.title,
            platform: sample.platform,
            coverUrl: sample.coverUrl,
            likes: sample.likes,
            qualityScore: sample.qualityScore,
          });
          if (activeJob.recentFoundSamples.length > 6) activeJob.recentFoundSamples.length = 6;

          rt.totalQualified = (rt.totalQualified || 0) + 1;
          rt.lastSuccessAt = new Date().toISOString();
          rt.lastError = '';
          pushLiveLog(`✅ 留下好视频《${(sample.title || '').slice(0, 18)}》(${sample.qualityScore}分 · 大封面已保存)`);

          if (db.settings.feishu && db.settings.feishu.autoRealtimeSync !== false) {
            feishuSync.enqueueSampleForFeishu(sample.id);
            if (awaitFeishuSync) {
              try {
                const fsRes = await feishuSync.processFeishuQueue({ operator: '边抓边实时同步飞书' });
                if (fsRes && fsRes.synced > 0 && activeJob) {
                  activeJob.feishuSyncedCount = (activeJob.feishuSyncedCount || 0) + fsRes.synced;
                  pushLiveLog(`📤 刚刚抓到的好内容已实时写进今日飞书表格（累计 ${activeJob.feishuSyncedCount} 条）`);
                }
              } catch {}
            } else {
              setImmediate(() => {
                feishuSync
                  .processFeishuQueue({ operator: '边抓边实时同步飞书' })
                  .then((fsRes) => {
                    if (fsRes && fsRes.synced > 0 && activeJob) {
                      activeJob.feishuSyncedCount = (activeJob.feishuSyncedCount || 0) + fsRes.synced;
                      pushLiveLog(`📤 刚刚抓到的好内容已实时写进今日飞书表格（累计 ${activeJob.feishuSyncedCount} 条）`);
                    }
                  })
                  .catch(() => {});
              });
            }
          }
        }

        // 遵守各平台独立请求间隔（手动快速联调时控制在 350ms，后台定时全量抓取按配置秒数等待）
        const intervalSec = Number((antiCrawl.intervalsSec && antiCrawl.intervalsSec[platformId]) || 8);
        const waitMs = fastTest ? 200 : intervalSec * 1000;
        if (kIdx < selectedKws.length - 1 && fetchedCount < maxTotalCandidates) {
          await sleep(waitMs);
        }
      }
    }

    activeJob.finishedAt = new Date().toISOString();
    activeJob.running = false;
    activeJob.progressPct = 100;
    activeJob.currentStep = `本次抓取完成！留下 ${activeJob.qualifiedAdded} 条好视频，踢掉 ${activeJob.filteredTrash} 条废片`;
    pushLiveLog(`🎉 抓取收工：共看 ${activeJob.totalFetched} 条，留下好视频 ${activeJob.qualifiedAdded} 条，踢掉废片 ${activeJob.filteredTrash} 条`);

    store.addOpLog({
      module: '采集引擎',
      action: `执行社媒采集任务 (${mode === 'sandbox' ? '联调沙盒' : mode === 'fingerprint' ? '防封浏览器静默抓' : '真实混合通道'})`,
      operator,
      status: activeJob.qualifiedAdded > 0 ? 'success' : 'warning',
      detail: `日期范围=${dateLabel}，共抓取 ${activeJob.totalFetched} 条：合格入库 ${activeJob.qualifiedAdded} 条，一票否决过滤废片 ${activeJob.filteredTrash} 条，跨平台搬运合并 ${activeJob.duplicatesMerged} 条，限流换IP重试 ${activeJob.rateLimitRetries} 次`,
    });
    store.save(true);
    githubSync.writePublicFeedSnapshot(db, activeJob);

    // 同步或异步触发飞书队列推送（无需人工点同步）
    if (db.settings.feishu && db.settings.feishu.autoRealtimeSync !== false) {
      if (awaitFeishuSync && (activeJob.qualifiedAdded > 0 || (db.feishuQueue && db.feishuQueue.length > 0))) {
        try {
          const fsRes = await feishuSync.processFeishuQueue({ forceAll: true, operator: '抓取完成实时同步飞书' });
          if (fsRes && fsRes.synced > 0 && activeJob) {
            activeJob.feishuSyncedCount = (activeJob.feishuSyncedCount || 0) + fsRes.synced;
            pushLiveLog(`📤 抓取完成，已实时写入今日飞书表格 ${fsRes.synced} 条（本轮累计 ${activeJob.feishuSyncedCount} 条）`);
          }
        } catch {}
      } else if (activeJob.qualifiedAdded > 0) {
        setImmediate(() => {
          feishuSync.processFeishuQueue({ operator: '采集后1分钟内自动同步' }).catch(() => {});
        });
      }
    }

    await checkPlatformZeroYieldAlerts();
    return { ...activeJob };
  } catch (err) {
    activeJob.running = false;
    activeJob.finishedAt = new Date().toISOString();
    activeJob.currentStep = `异常中止：${err.message}`;
    store.addOpLog({
      module: '采集引擎',
      action: '采集任务异常终止',
      operator,
      status: 'error',
      detail: err.message,
      errorReason: err.message,
    });
    throw err;
  } finally {
    store.save(true);
    githubSync.writePublicFeedSnapshot(db, activeJob);
    if (db.settings.githubSync && db.settings.githubSync.autoPushAfterCrawl) {
      githubSync
        .pushToGithub({ db, activeJob })
        .then(() => {
          store.save(true);
        })
        .catch(() => {});
    }
  }
}

/**
 * 巡检「某平台连续 2 小时抓不到内容」告警规则
 */
async function checkPlatformZeroYieldAlerts() {
  const db = store.getDb();
  const hours = Number(db.settings.antiCrawl?.zeroYieldAlertHours || 2);
  const windowMs = hours * 3600 * 1000;
  const now = Date.now();

  for (const pId of ['instagram', 'facebook', 'x', 'threads', 'tiktok']) {
    const rt = db.platformRuntime[pId];
    if (!rt || !rt.lastAttemptAt) continue;
    const lastOkMs = rt.lastSuccessAt ? new Date(rt.lastSuccessAt).getTime() : 0;
    const firstTryMs = new Date(rt.lastAttemptAt).getTime();
    if (lastOkMs > 0 && now - lastOkMs >= windowMs && firstTryMs > lastOkMs) {
      await store.raiseAlert({
        type: 'platform_zero_2h',
        level: 'critical',
        platform: pId,
        title: `${pId.toUpperCase()} 平台已连续超过 ${hours} 小时未抓到合格内容`,
        message: `请检查 ${pId.toUpperCase()} 平台代理IP池连通性、搜索词库或第三方采集源状态。`,
      });
    }
  }
}

/**
 * 运营一键标记某条内容为垃圾内容 -> 移入回收站并自动拉黑该账号及高频特征词，后续同类内容自动过滤！
 */
function markSampleAsSpam(sampleId, reason = '运营手动标记垃圾废片', blockAccount = true, blockKeyword = '', operator) {
  const db = store.getDb();
  const idx = db.samples.findIndex((s) => s.id === sampleId);
  if (idx < 0) return null;

  const [removed] = db.samples.splice(idx, 1);
  const trashEntry = {
    ...removed,
    trashType: 'manual_spam',
    filterCategory: '人工标记垃圾内容',
    vetoReason: reason,
    trashedAt: new Date().toISOString(),
  };
  db.trash.unshift(trashEntry);

  if (blockAccount && removed.authorHandle && removed.authorHandle !== 'unknown') {
    const exists = db.blacklist.accounts.some(
      (a) => a.handle.toLowerCase() === removed.authorHandle.toLowerCase() && a.platform === removed.platform
    );
    if (!exists) {
      db.blacklist.accounts.unshift({
        id: uid('bla'),
        platform: removed.platform,
        handle: removed.authorHandle,
        reason: `人工标记垃圾内容联动拉黑（原片：${(removed.title || '').slice(0, 20)}）`,
        sourceSampleId: removed.id,
        createdAt: new Date().toISOString(),
      });
    }
  }

  if (blockKeyword && blockKeyword.trim()) {
    const kw = blockKeyword.trim();
    if (!db.blacklist.keywords.some((k) => k.word.toLowerCase() === kw.toLowerCase())) {
      db.blacklist.keywords.unshift({
        id: uid('blk'),
        word: kw,
        reason: '运营标记垃圾同步屏蔽词',
        createdAt: new Date().toISOString(),
      });
    }
  }

  store.addOpLog({
    module: '内容审核',
    action: '标记垃圾内容并自动加黑过滤',
    operator,
    status: 'success',
    detail: `已将「${(removed.title || '').slice(0, 24)}」移入垃圾回收站${blockAccount ? `，并自动拉黑账号 @${removed.authorHandle}` : ''}`,
  });
  store.save();
  return trashEntry;
}

/**
 * 从回收站恢复误删或误判垃圾样本回合格列表
 */
function restoreFromTrash(trashId, operator) {
  const db = store.getDb();
  const idx = db.trash.findIndex((t) => t.id === trashId);
  if (idx < 0) return null;

  const [item] = db.trash.splice(idx, 1);
  const restored = {
    id: item.id.startsWith('smp_') ? item.id : uid('smp'),
    platform: item.platform || 'instagram',
    mergedPlatforms: item.mergedPlatforms || [item.platform || 'instagram'],
    alternateUrls: item.alternateUrls || [],
    duplicateCount: item.duplicateCount || 1,
    title: item.title || '恢复样本',
    fullText: item.fullText || '',
    videoUrl: item.videoUrl || '',
    coverUrl: item.coverUrl || '',
    publishedAt: item.publishedAt || new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    durationSec: item.durationSec || 15,
    bgm: item.bgm || 'Original Audio',
    plays: item.plays || 0,
    likes: item.likes || 0,
    comments: item.comments || 0,
    shares: item.shares || 0,
    bookmarks: item.bookmarks || 0,
    topComments: item.topComments || [],
    authorHandle: item.authorHandle || 'unknown',
    authorFollowers: item.authorFollowers || 1500,
    authorAgeDays: item.authorAgeDays || 180,
    sourceKeyword: item.sourceKeyword || '',
    categoryGroup: item.categoryGroup || item.sourceBucket || 'generic',
    exposedBrands: item.exposedBrands || [],
    contentType: item.contentType || '聊天录屏类',
    hasHumanFace: false,
    isGameRelated: false,
    implantDifficulty: item.implantDifficulty || 2,
    qualityScore: Math.max(60, Number(item.qualityScore || 72)),
    dimensions: item.dimensions || {},
    implantGuide: item.implantGuide || {
      exactTiming: '第 06 秒对话转折处',
      visualHook: '顶部露出匿名语音通话状态条',
      copyScript: '可根据原片情绪替换为深夜连麦陪伴切入话术',
      commentSeedScript: '双小号热评互动引出软件名称',
    },
    replicationSteps: item.replicationSteps || ['按原片节奏替换对话文案与语音条卡点复刻'],
    contentHash: item.contentHash || '',
    mediaFingerprint: item.mediaFingerprint || '',
    favorited: false,
    markedUsed: false,
    feishuSynced: false,
    customValues: item.customValues || {},
  };

  db.samples.unshift(restored);
  // 若之前联动拉黑了该账号，同时自动解除拉黑方便后续正常抓取
  if (restored.authorHandle) {
    db.blacklist.accounts = db.blacklist.accounts.filter((a) => a.sourceSampleId !== item.id);
  }

  store.addOpLog({
    module: '回收站',
    action: '恢复样本至合格列表',
    operator,
    status: 'success',
    detail: `已从回收站恢复样本「${(restored.title || '').slice(0, 26)}」`,
  });
  store.save();
  return restored;
}

function getActiveJobStatus() {
  return (
    activeJob || {
      running: false,
      fetchedCount: 0,
      qualifiedCount: 0,
      filteredCount: 0,
      feishuSyncedCount: 0,
      recentFoundSamples: [],
      liveLogs: [],
    }
  );
}

module.exports = {
  runCrawlTask,
  buildSampleEntity,
  markSampleAsSpam,
  restoreFromTrash,
  checkPlatformZeroYieldAlerts,
  getActiveJobStatus,
};
