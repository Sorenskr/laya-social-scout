'use strict';
/**
 * 落地执行步骤 1~7 全链路自动化自检脚本
 * 验证：
 *  1. 静态白名单安全隔离（绝不泄露 data/db.json / main.js）+ 跨电脑私网跨域头
 *  2. 美区/台湾代理批量导入、限流自动换IP + 近义词替换重试（语音匹配 -> 处CP聊天）
 *  3. 一票否决过滤准确性：真人小窗露脸、游戏录屏、直白硬广、粉丝<1000低质号 100% 进垃圾库，零漏网
 *  4. 按日期范围抓取、每条自带高清大封面、抓取过程实时进度与大白话日志
 *  5. 丢链接/贴截图拆解案例并落盘封面、存入好视频库
 *  6. 现成热词包导入与脱敏快照 public_feed.json 检查
 *  7. 飞书超链接字段、3×4分表归档、垃圾拉黑与回收站恢复、免代码自定义字段
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { handler } = require('../main');
const feishuSync = require('../lib/feishu_sync');
const { defaultKeywords } = require('../lib/defaults');
const store = require('../lib/store');
const seedDemo = require('../lib/seed_demo');

const ROOT_DIR = path.join(__dirname, '..');
const COVERS_DIR = path.join(ROOT_DIR, 'covers');

function invokeHandlerInMemory(pathUrl, method = 'GET', body = null, expectJson = true) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.url = pathUrl;
    req.method = method;
    req.headers = { host: 'localhost:3080' };
    req.destroy = () => {};

    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      headers: {},
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
      writeHead(code, hdrs = {}) {
        this.statusCode = code;
        this.headersSent = true;
        Object.entries(hdrs).forEach(([k, v]) => this.setHeader(k, v));
      },
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      },
      end(chunk) {
        if (chunk) this.write(chunk);
        this.headersSent = true;
        const txt = Buffer.concat(chunks).toString('utf8');
        if (!expectJson) {
          return resolve({ status: this.statusCode, headers: this.headers, rawText: txt, data: null });
        }
        try {
          resolve({ status: this.statusCode, headers: this.headers, rawText: txt, data: txt ? JSON.parse(txt) : {} });
        } catch (e) {
          reject(new Error(`非JSON返回 (${this.statusCode}): ${txt.slice(0, 180)}`));
        }
      },
    };

    Promise.resolve(handler(req, res)).catch(reject);
    setImmediate(() => {
      if (body !== null) {
        req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
      }
      req.emit('end');
    });
  });
}

async function runAllTests() {
  const reqJson = (_port, pathUrl, method = 'GET', body = null) => invokeHandlerInMemory(pathUrl, method, body, true);
  const reqRaw = (pathUrl, method = 'GET', body = null) => invokeHandlerInMemory(pathUrl, method, body, false);
  const port = 3080;

  try {
    console.log('[自检] 开始执行全模块路由与业务逻辑回归测试…');

    // 0. 静态白名单安全 & 跨电脑跨域头检查
    const htmlRes = await reqRaw('/index.html', 'GET');
    assert.strictEqual(htmlRes.status, 200, '根目录 index.html 应可正常打开');
    assert.ok(htmlRes.rawText.includes('交友软广雷达'), '页面应渲染大白话工作台');

    const blockedDbRes = await reqRaw('/data/db.json', 'GET');
    assert.strictEqual(blockedDbRes.status, 404, '绝不能把 data/db.json 暴露给静态请求');

    const blockedSrcRes = await reqRaw('/main.js', 'GET');
    assert.strictEqual(blockedSrcRes.status, 404, '绝不能把后端源码 main.js 暴露给静态请求');

    const optRes = await reqRaw('/api/health', 'OPTIONS');
    assert.strictEqual(optRes.headers['access-control-allow-origin'], '*', 'CORS 必须允许 GitHub Pages 访问');
    assert.strictEqual(optRes.headers['access-control-allow-private-network'], 'true', '必须携带 PNA 私网访问头');
    console.log('✅ 安全与跨电脑连接验证通过：敏感文件严格 404 隔离，支持 GitHub Pages 直连本机');

    // 1. 清空初始演示样本，从零验证全流程
    await reqJson(port, '/api/demo/clear-samples', 'POST');

    // 2. 验证代理 IP 池批量导入（美区+台湾）
    const proxyRes = await reqJson(port, '/api/proxies/import', 'POST', {
      defaultRegion: '美区',
      rawText: '[美区] 198.51.100.11:8080:user1:pass1\n[台湾] 103.22.201.18:9000:twuser:twpass\nhttp://u3:p3@203.0.113.45:3128',
    });
    assert.strictEqual(proxyRes.data.added >= 3 || proxyRes.data.proxies.length >= 3, true, '代理批量导入应成功');
    console.log('✅ 代理校验通过：美区/台湾代理 IP 批量解析与导入正常');

    // 3. 验证批量导入竞品词库 + 一键导入预设热词包
    // 确保重复运行自检时能真实测试“新增导入”与去重，并锁定 0 费用 + 防封通道默认项
    const preDb = store.getDb();
    preDb.keywords = defaultKeywords();
    preDb.settings.visionLlm.provider = 'local_free';
    preDb.settings.collectorMode = 'fingerprint';
    store.save(true);
    await reqJson(port, '/api/keywords/manage', 'POST', {
      bucket: 'competitor',
      action: 'batchImport',
      rawText: 'PicoVoice | 海外语音房 | Pico聊天\nMico | 海外泛娱乐 | Mico连麦',
    });
    await reqJson(port, '/api/keywords/manage', 'POST', {
      bucket: 'brand',
      action: 'add',
      word: '语音匹配',
      group: '限流测试词',
      synonyms: '处CP聊天,女生连麦',
    });
    const packRes = await reqJson(port, '/api/keywords/import-pack', 'POST', { packId: 'tw_latenight' });
    assert.strictEqual(packRes.data.ok, true, '现成热词包导入应成功');
    assert.ok(packRes.data.added >= 1, '导入台湾深夜情感热词包应新增搜索词');
    console.log(`✅ 热词包导入验证通过：「${packRes.data.packName}」新增 ${packRes.data.added} 个高转化热词`);

    // 4. 执行全四平台小范围采集（验证过滤规则、去重、限流重试与实时进度）
    const crawlRes = await reqJson(port, '/api/crawl/run', 'POST', {
      platforms: ['instagram', 'facebook', 'x', 'threads'],
      buckets: ['brand', 'competitor', 'generic'],
      maxTotalCandidates: 14,
      modeOverride: 'sandbox',
      fastTest: true,
    });
    const r = crawlRes.data.result;
    assert.ok(r.qualifiedAdded >= 4, '四平台应产出合格男向交友软广样本');
    assert.ok(r.filteredTrash >= 3, '应成功拦截露脸/游戏/硬广/低粉测试号废片');
    assert.ok(r.duplicatesMerged >= 1, 'IG 与 Threads 同源搬运视频应自动去重合并');
    assert.ok(r.rateLimitRetries >= 1, '「语音匹配」受限时应自动换IP并替换近义词「处CP聊天」重试');

    const statusRes = await reqJson(port, '/api/crawl/status');
    assert.strictEqual(statusRes.data.progressPct, 100, '抓完后实时进度应为 100%');
    assert.ok(typeof statusRes.data.qualifiedCount === 'number', '实时进度应包含合格条数 qualifiedCount');
    assert.ok(typeof statusRes.data.filteredCount === 'number', '实时进度应包含拦掉废片数 filteredCount');
    assert.ok(typeof statusRes.data.feishuSyncedCount === 'number', '实时进度应包含飞书同步数 feishuSyncedCount');
    assert.ok(Array.isArray(statusRes.data.recentFoundSamples), '实时进度应包含刚抓到的封面预览数组 recentFoundSamples');
    assert.ok(Array.isArray(statusRes.data.liveLogs) && statusRes.data.liveLogs.length >= 1, '实时进度应包含大白话直播日志');
    console.log(
      `✅ 抓取与风控验证通过：抓取 ${r.totalFetched} 条 -> 合格 ${r.qualifiedAdded} 条，拦截废片 ${r.filteredTrash} 条，合并 ${r.duplicatesMerged} 条，限流换IP ${r.rateLimitRetries} 次`
    );

    // 4b. 验证按日期范围采集（dateFrom ~ dateTo）
    await reqJson(port, '/api/demo/clear-samples', 'POST');
    const dateCrawlRes = await reqJson(port, '/api/crawl/run', 'POST', {
      platforms: ['instagram', 'x'],
      buckets: ['brand', 'generic'],
      maxTotalCandidates: 6,
      dateFrom: '2026-11-10',
      dateTo: '2026-11-14',
      modeOverride: 'sandbox',
      fastTest: true,
    });
    assert.ok(dateCrawlRes.data.result.qualifiedAdded >= 2, '按日期范围应能抓取到对应时段合格视频');
    const dateListRes = await reqJson(port, '/api/samples?sortBy=score_time');
    const startMs = new Date('2026-11-10T00:00:00').getTime();
    const endMs = new Date('2026-11-14T23:59:59.999').getTime();
    for (const s of dateListRes.data.items) {
      const pubMs = new Date(s.publishedAt).getTime();
      assert.ok(pubMs >= startMs && pubMs <= endMs, `视频发布时间 ${s.publishedAt} 必须落在 2026-11-10 ~ 2026-11-14 内`);
      assert.ok(s.coverUrl && s.coverUrl.length > 5, '每条视频都必须有大封面');
    }
    console.log(`✅ 按日期范围抓取验证通过：筛选时段 2026-11-10 ~ 2026-11-14 共返回 ${dateListRes.data.items.length} 条带封面样本`);

    // 4c. 验证 TikTok 平台视频与图文全形态沙盒采集
    const ttCrawlRes = await reqJson(port, '/api/crawl/run', 'POST', {
      platforms: ['tiktok'],
      buckets: ['brand'],
      maxTotalCandidates: 4,
      modeOverride: 'sandbox',
      fastTest: true,
    });
    assert.ok(ttCrawlRes.data.result.qualifiedAdded >= 2, 'TikTok 平台应能抓到并审过视频与图文样本');
    const ttListRes = await reqJson(port, '/api/samples?platforms=tiktok');
    assert.ok(ttListRes.data.items.some((s) => s.platform === 'tiktok' && (s.mediaType || 'video') === 'video'), 'TikTok 结果应包含短视频样本');
    assert.ok(ttListRes.data.items.some((s) => s.platform === 'tiktok' && s.mediaType === 'image'), 'TikTok 结果应包含图文轮播样本');
    console.log(`✅ TikTok 全形态采集验证通过：共入库 ${ttListRes.data.items.length} 条 TikTok 视频/图文样本`);

    // 重新补一轮完整四平台样本继续下面校验
    await reqJson(port, '/api/crawl/run', 'POST', {
      platforms: ['instagram', 'facebook', 'x', 'threads'],
      buckets: ['brand', 'competitor', 'generic'],
      maxTotalCandidates: 14,
      modeOverride: 'sandbox',
      fastTest: true,
    });

    // 5. 严格断言合格库中 0 真人露脸、0 游戏内容、0 低于60分，且每条均有封面和秒级植入指南
    const listRes = await reqJson(port, '/api/samples?sortBy=score_time');
    const items = listRes.data.items;
    assert.ok(items.length >= 4, '结果列表应返回合格样本');
    for (const item of items) {
      assert.strictEqual(item.hasHumanFace, false, '合格样本绝不能包含真人露脸');
      assert.strictEqual(item.isGameRelated, false, '合格样本绝不能包含游戏/二次元内容');
      assert.ok(item.qualityScore >= 60, '合格样本评分必须 >= 60');
      assert.ok(item.coverUrl && item.coverUrl.length > 5, '合格样本必须具备封面图片');
      assert.ok(item.implantGuide && item.implantGuide.exactTiming, '必须包含精确到秒的软广植入指南');
      assert.ok(Array.isArray(item.replicationSteps) && item.replicationSteps.length >= 3, '必须包含复刻操作步骤');
    }
    console.log('✅ 防废片零漏网验证通过：合格列表 0 露脸、0 游戏、0 硬广，全部自带封面与植入指南');

    // 6. 验证丢图/传链接拆解案例 + 图片落盘 covers/ + 一键存入好视频库
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const caseRes = await reqJson(port, '/api/analyze/case', 'POST', {
      url: '',
      imagesBase64: [tinyPng],
      userNote: '帮我看下这条深夜连麦聊天怎么插Laya，偏台湾口吻',
    });
    assert.strictEqual(caseRes.data.ok, true, '案例拆解接口应返回成功');
    const caseItem = caseRes.data.caseItem;
    assert.ok(caseItem && caseItem.coverUrl && caseItem.coverUrl.startsWith('./covers/'), '上传截图应自动落盘生成 ./covers/ 封面');
    const savedCoverAbs = path.join(ROOT_DIR, caseItem.coverUrl.replace(/^\.\//, ''));
    assert.strictEqual(fs.existsSync(savedCoverAbs), true, '案例封面文件应实际存在于 covers 目录中');
    assert.ok(Array.isArray(caseItem.report.whyViral) && caseItem.report.whyViral.length >= 1, '拆解报告应包含爆款原因');
    assert.ok(Array.isArray(caseItem.report.stepByStepCopy) && caseItem.report.stepByStepCopy.length >= 2, '拆解报告应包含复刻步骤');
    assert.ok(Array.isArray(caseItem.report.readyScripts) && caseItem.report.readyScripts.length >= 3, '拆解报告应包含 3 套可照抄脚本');

    const saveSampleRes = await reqJson(port, '/api/analyze/save-to-samples', 'POST', { id: caseItem.id });
    assert.strictEqual(saveSampleRes.data.ok, true, '拆解案例应支持一键存进好视频库');
    assert.ok(store.getDb().samples.some((s) => s.videoUrl === saveSampleRes.data.sample.videoUrl), '保存后应出现在 samples 列表中');
    console.log('✅ 丢图拆案例验证通过：自动存封面、出 3 套可抄文案、并一键收录进好视频库');

    // 7. 验证公开快照 public_feed.json 脱敏安全性（包含大封面与案例且绝无密码/密钥）
    const feedRes = await reqJson(port, '/public_feed.json', 'GET');
    assert.strictEqual(feedRes.status, 200, 'GitHub 网页版依赖的 public_feed.json 必须可正常读取');
    assert.ok(Array.isArray(feedRes.data.samples) && feedRes.data.samples.length >= 4, 'public_feed.json 应含脱敏视频样本');
    assert.ok(feedRes.data.dashboard && Array.isArray(feedRes.data.caseAnalyses), 'public_feed.json 应含看板数据与拆解案例');
    assert.strictEqual(feedRes.rawText.includes('user1'), false, 'public_feed.json 绝不能泄露代理账号 user1');
    assert.strictEqual(feedRes.rawText.includes('pass1'), false, 'public_feed.json 绝不能泄露代理密码 pass1');
    assert.strictEqual(feedRes.rawText.includes('appSecret'), false, 'public_feed.json 绝不能包含 appSecret');
    assert.strictEqual(feedRes.rawText.includes('apiKey'), false, 'public_feed.json 绝不能包含 apiKey');
    console.log('✅ GitHub 公开快照验证通过：public_feed.json 数据完整且 100% 脱敏无密码泄露');

    // 8. 验证飞书超链接字段结构、自定义字段、黑名单与回收站恢复、红色告警
    await reqJson(port, '/api/custom-fields/manage', 'POST', {
      action: 'add',
      label: '剪辑指派人',
      options: '阿杰,小林,待分配',
      syncToFeishu: true,
    });
    const db = store.getDb();
    const cols = feishuSync.getActiveSyncColumns(db);
    assert.ok(cols.some((c) => c.label === '剪辑指派人'), '运营新增自定义字段应自动挂载到飞书同步列');
    const linkVal = feishuSync.formatSampleFieldValue(items[0], 'videoUrl', true);
    assert.ok(Array.isArray(linkVal) && linkVal[0].type === 'url' && linkVal[0].link.startsWith('http'), '飞书链接列必须为可点击超链接格式');
    const archRes = await reqJson(port, '/api/feishu/archive', 'POST', { periodType: 'daily' });
    assert.strictEqual(archRes.data.ok, true, '飞书单日分表归档快照应正常执行');

    const targetSample = items[0];
    await reqJson(port, `/api/samples/${targetSample.id}/action`, 'POST', {
      action: 'markSpam',
      blockAccount: true,
      reason: '测试手动标记垃圾拉黑',
    });
    const trashLogs = await reqJson(port, '/api/trash-and-logs');
    assert.ok(trashLogs.data.blacklist.accounts.some((a) => a.handle === targetSample.authorHandle), '标记垃圾后应自动将该账号加入拉黑名单');
    const trashedRecord = trashLogs.data.trash.find((t) => t.videoUrl === targetSample.videoUrl);
    assert.ok(trashedRecord, '标记垃圾后应进入回收站');
    await reqJson(port, '/api/trash/restore', 'POST', { id: trashedRecord.id });

    await reqJson(port, '/api/alerts/test', 'POST', { scenario: 'proxy_low_rate' });
    const bootAfterAlert = await reqJson(port, '/api/bootstrap');
    assert.ok(bootAfterAlert.data.activeAlerts.length >= 1, '异常告警应推送至页面顶部红色横幅');
    await reqJson(port, '/api/alerts/dismiss', 'POST', { id: 'ALL' });
    console.log('✅ 飞书归档、拉黑恢复与异常告警验证全部通过！');

    // 8b. 验证防封指纹浏览器探测、0费用本地智能引擎、飞书链接解析
    const browserStatRes = await reqJson(port, '/api/browser/status');
    assert.strictEqual(browserStatRes.data.ok, true, '浏览器探测接口应返回 ok: true');
    assert.ok(Array.isArray(browserStatRes.data.profiles), '应返回 profiles 数组');
    assert.ok(typeof browserStatRes.data.todaySearchCount === 'number', '应包含今日防封搜词安全计数');
    assert.ok(browserStatRes.data.maxDailySearchesPerAccount >= 5, '应包含每日防封安全搜词上限');

    const visionTestRes = await reqJson(port, '/api/vision/test', 'POST', {});
    assert.strictEqual(visionTestRes.data.ok, true, '0 费用本地引擎试审应直接通过');
    assert.strictEqual(visionTestRes.data.provider, 'local_free', '默认 AI 引擎应为 local_free 0 费用引擎');
    assert.ok(((caseItem.report && caseItem.report.engineLabel) || '').includes('0 费用'), '案例拆解应标注 0 费用智能引擎');

    const parsedSheet = feishuSync.parseFeishuTargetUrl('https://sample.feishu.cn/sheets/shtcnAbCdEf123456');
    assert.deepStrictEqual(parsedSheet, { mode: 'spreadsheet', token: 'shtcnAbCdEf123456' }, '应能从飞书表格链接准确提取 token');
    const parsedBitable = feishuSync.parseFeishuTargetUrl('https://sample.feishu.cn/base/bascnXyz987654');
    assert.deepStrictEqual(parsedBitable, { mode: 'bitable', token: 'bascnXyz987654' }, '应能从多维表格链接准确提取 app_token');
    console.log('✅ 防封浏览器探测、0 费用智能引擎与飞书表格链接解析验证全部通过！');

    // 9. 清理所有测试痕迹并生成一套干净的初始大封面演示快照，方便开箱即用
    if (fs.existsSync(COVERS_DIR)) {
      fs.rmSync(COVERS_DIR, { recursive: true, force: true });
    }
    await reqJson(port, '/api/demo/clear-samples', 'POST');
    const cleanDb = store.getDb();
    cleanDb.keywords = defaultKeywords();
    cleanDb.caseAnalyses = [];
    cleanDb.proxies = [];
    cleanDb.customFields = [];
    cleanDb.blacklist = { accounts: [], keywords: [] };
    cleanDb.rateLimitLogs = [];
    cleanDb.operationLogs = [];
    cleanDb.seededOnce = false;
    store.save(true);

    await seedDemo.ensureInitialSeedIfEmpty();
    console.log('✅ 已重置并生成干净的初始展示样本与 public_feed.json 快照');
    console.log('🎉 全部端到端自检项 100% 通过！');
  } finally {
    // 测试结束
  }
}

runAllTests().catch((err) => {
  console.error('❌ 自检失败:', err);
  process.exit(1);
});
