'use strict';
/**
 * 平台采集器抽象基类 (BaseCollector)
 * 新增 TikTok / 抖音 / 小红书 时，只需继承或实现相同接口并在 registry.js 注册即可。
 *
 * 每个采集器统一输出标准 Candidate 结构：
 * {
 *   platform: 'instagram'|'facebook'|'x'|'threads',
 *   title: string,
 *   fullText: string,
 *   videoUrl: string,
 *   coverUrl: string,
 *   publishedAt: ISOString,
 *   durationSec: number,
 *   bgm: string,
 *   plays: number,
 *   likes: number,
 *   comments: number,
 *   shares: number,
 *   bookmarks: number,
 *   topComments: [{ author, text, likes }],
 *   authorHandle: string,
 *   authorFollowers: number,
 *   authorAgeDays: number,
 *   sourceKeyword: string,
 *   sourceBucket: 'brand'|'competitor'|'generic',
 *   mediaFingerprint: string,
 *   visualSceneDesc: string,
 *   visualHints: object
 * }
 */
const proxyPool = require('../proxy_pool');

const NON_DATING_LAYA_NOISE_RE = /laya\s*healthcare|layaair|laya\s*engine|laya\s*resort|laya\s*safari|laya\s*beach|laya\s*clinic|laya[_\s-]*dex|\$laya\b|tokenomics|airdrop|web3|瓦的陪玩|特戰英豪|valorant|bhutan|lunana|himalaya|masagang|glacial\s*lake|dzongkhag|\bgasa\b/i;
const CAPTCHA_GATE_RE = /captcha|anomaly\.js|verify you are human|are you a robot|turnstile/i;
const IG_SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_EPOCH_MS = 1314220021721n;
const LOGIN_WALL_PLACEHOLDER_RE = /^(?:log\s*in|sign\s*up|threads\s*[•·|-]\s*log\s*in|登入|註冊|注册|請先登入|请先登录|join\s+threads)$/i;
const LOGIN_WALL_BODY_RE = /(?:log\s*in\s*or\s*sign\s*up\s*for\s*threads|see\s*more\s*on\s*threads|登入以查看更多|登录查看更多)/i;
const UNSAFE_ADULT_SPAM_RE = /(?:\b(?:nsfw|onlyfans|porn|xxx|hentai|escort|prostitut|call\s*girl|sugardaddy|incest|underage|loli|r18|18\+|adult\s*video|sex\s*tape|nude\s*leak)\b|av[女优優]|無碼|无码|約炮|约炮|一夜情|援交|包養|包养|賣片|卖片|外流[片照]?|福利[姬姫]|裸照|色情|成人影片|賭博|赌博|娛樂城|娱乐城|六合彩|菠菜[盤盘]?|殺豬盤|杀猪盘|代孕|毒品|自殺|自杀|亂倫|乱伦|打樁|打桩|奶油泡芙|法友|炮友|砲友|固炮|約跑|约跑|唧唧|雞雞|鸡鸡|成人版|福利版|開車群|开车群|黃片|黄片|瑟瑟|大尺度|▓▓|私訊問我在哪看|私讯问我在哪看|父女.*(?:吻|床|片|系列)|母子.*(?:吻|床|片|系列)|約法|约法|台灣約|台湾约|發洩一次|发泄一次|車車|车车|新婚洞房|洞房花燭|不做不准出來|不做不准出来|騷擾粉絲|骚扰粉丝|私訊領|私讯领|看片群|福利群|免費看片|免费看片|情色|肉文|高H|NP文|強制愛|强制爱|\bav\b.*(?:認知|认知|大腦|大脑)|這幫出生|这帮出生|男同志大賽|卢关|ㄐㄐ)/i;
const OFF_TOPIC_POLITICAL_NEWS_RE = /沈伯洋|國民黨|国民党|民進黨|民进党|民眾黨|民众党|賴清德|赖清德|柯文哲|蔣萬安|蒋万安|蔡英文|馬英九|韓粉|青鳥|小草|立法院|國會|一國兩制|一国两制|兩岸和平|两岸和平|統戰|统战|台獨|台独|武統|武统|藍白|綠營|绿营|大罷免|罷免|罢免|選前|拉票|市長選舉|九合一|總統大選|真正的民意|共產黨|共产党|習近平|川普|拜登|關稅戰|議員|立委|政黨|政治人物|政見發表|政见发表|洋流祭|咱投票|新北隊|蘇巧慧|苏巧慧|巧慧|不同立場|政治立場|罷團|青鳥行動|選戰|造勢|競選|候选人|候選人|中國人的公司|中国人的公司/i;
const FOREIGN_GIBBERISH_RE = /(?:[\u0E00-\u0E7F\u0600-\u06FF]|\b(?:aku|kamu|banget|nggak|enggak|udah|bikin|karena|sama|yang|untuk|dalam|warga|jiran|sikit|rekomendasiin|kalau|gimana|kenapa|lagi|banyak)\b)/i;
const OFFICIAL_PLATFORM_HANDLES = new Set(['threads', 'instagram', 'mosseri', 'meta']);

/**
 * 通过 Threads / Instagram 帖文短码（Base64 雪花 Media ID）反解精确发布时间 ISO 字符串
 */
function decodeThreadsPostTimestamp(urlOrCode = '') {
  let code = String(urlOrCode || '').trim();
  const match = code.match(/\/post\/([A-Za-z0-9_-]+)/);
  if (match) code = match[1];
  if (!code || code.length < 9 || code.length > 13) return '';
  let mediaId = 0n;
  for (const ch of code) {
    const idx = IG_SHORTCODE_ALPHABET.indexOf(ch);
    if (idx < 0) return '';
    mediaId = (mediaId * 64n) + BigInt(idx);
  }
  const tsMs = Number((mediaId >> 23n) + IG_EPOCH_MS);
  const minTs = Date.UTC(2023, 6, 1); // Threads 上线月份 2023-07
  const maxTs = Date.now() + 24 * 3600 * 1000;
  if (!Number.isFinite(tsMs) || tsMs < minTs || tsMs > maxTs) return '';
  return new Date(tsMs).toISOString();
}

/**
 * 严格健康与合规内容过滤器：拦截色情/低俗/擦边导流/涉政/外语噪音/纯回复及未登录占位文案
 */
function isCompliantHealthyPost(item = {}) {
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  const fullText = String(item.fullText || '').replace(/\s+/g, ' ').trim();
  const body = fullText || title;
  if (!body || body.length < 4) return false;
  if (LOGIN_WALL_PLACEHOLDER_RE.test(body) || LOGIN_WALL_PLACEHOLDER_RE.test(title)) return false;
  if (LOGIN_WALL_BODY_RE.test(body)) return false;

  const cleanHandle = String(item.authorHandle || '').replace(/^@/, '').trim().toLowerCase();
  if (OFFICIAL_PLATFORM_HANDLES.has(cleanHandle)) return false;
  if (/^(?:Replying to @|回覆\s*@|回复\s*@)/i.test(title) || /^(?:Replying to @|回覆\s*@|回复\s*@)/i.test(fullText)) {
    return false;
  }

  const combined = `${title} ${fullText} ${item.authorHandle || ''} ${item.videoUrl || ''}`;
  if (UNSAFE_ADULT_SPAM_RE.test(combined)) return false;
  if (OFF_TOPIC_POLITICAL_NEWS_RE.test(combined)) return false;
  if (/^(?:panda|penguin|dawang)\.\d{5,}$/i.test(cleanHandle)) return false;

  const hasLaya = /laya|拉雅/i.test(combined);
  if (FOREIGN_GIBBERISH_RE.test(combined)) return false;
  if (item.platform === 'threads' && !hasLaya) {
    if (!/(?:[\u4e00-\u9fff].*){4,}/.test(body)) return false;
  }
  return true;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&rsquo;|&apos;|&#39;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return _; }
    });
}

function cleanReadableTitle(rawTitle, { fallbackText = '', authorHandle = '', platform = '' } = {}) {
  const stripTrailingSite = (s) =>
    decodeHtmlEntities(String(s || ''))
      .replace(/[\uFFFC\u2591-\u2593]+/g, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:@\S+\s+)?(?:\d+\s*(?:秒|分|分鐘|分钟|小時|小时|天|日|週|周|[smhdw])|昨天|剛剛|刚刚|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*/i, '')
      .replace(/\s*[|\-–—·•]\s*(?:TikTok|Instagram|Facebook|Threads|X(?:\s*\(Twitter\))?|Video)\s*$/i, '')
      .replace(/\s+(?:Translate|翻譯|翻译|查看翻譯|Spoiler)(?:\s+[\d.,kKwWM万萬千/]+)*\s*$/i, '')
      .replace(/\s+\d+\s*\/\s*\d+(?:\s+[\d.,kKwWM万萬千]+)*\s*$/, '')
      .replace(/(?:\s+\d+(?:\.\d+)?[kKwWM万萬千]?){2,5}\s*$/, '')
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .trim();

  const isBarePlatformName = (s) =>
    !s || /^(?:instagram|facebook|tiktok|threads|x(?:\s*\(twitter\))?|log\s*in|sign\s*up|see posts)$/i.test(s);

  let clean = stripTrailingSite(rawTitle);
  if (isBarePlatformName(clean) && fallbackText) {
    const fb = stripTrailingSite(fallbackText);
    if (!isBarePlatformName(fb)) clean = fb;
  }
  if (isBarePlatformName(clean)) {
    const handle = String(authorHandle || '').replace(/^@/, '').trim();
    const platName = platform ? platform.toUpperCase() : '社媒';
    clean = handle && !['social_creator', 'creator'].includes(handle)
      ? `@${handle} · ${platName} 爆款热帖`
      : `${platName} 交友话题精选`;
  }
  return clean.slice(0, 80);
}

function stripHtmlTags(str) {
  return decodeHtmlEntities(String(str || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFormattedNumber(numStr, unitStr = '') {
  const num = parseFloat(String(numStr || '').replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return 0;
  const u = String(unitStr || '').trim().toLowerCase();
  if (u === 'k' || u === '千') return Math.round(num * 1000);
  if (u === 'm') return Math.round(num * 1000000);
  if (u === 'w' || u === '万' || u === '萬') return Math.round(num * 10000);
  return Math.round(num);
}

/**
 * 从搜索引擎摘要或页面文本中提取点赞、评论、浏览/播放量
 */
function parseEngagementFromSnippet(text) {
  const src = String(text || '');
  const out = { likes: 0, comments: 0, plays: 0 };
  if (!src) return out;

  const numPart = '(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*([kKmMwW万萬千]?)';
  const likeMatch = src.match(new RegExp(`${numPart}\\s*(?:likes?|reactions?|個心情|个心情|個讚|个赞|讚|赞)`, 'i'));
  if (likeMatch) out.likes = parseFormattedNumber(likeMatch[1], likeMatch[2]);

  const commentMatch = src.match(new RegExp(`${numPart}\\s*(?:comments?|replies|則留言|条评论|条回复|評論|评论)`, 'i'));
  if (commentMatch) out.comments = parseFormattedNumber(commentMatch[1], commentMatch[2]);

  const playMatch = src.match(new RegExp(`${numPart}\\s*(?:views?|plays?|次觀看|次观看|次播放|觀看|观看|浏览)`, 'i'));
  if (playMatch) out.plays = parseFormattedNumber(playMatch[1], playMatch[2]);

  return out;
}

/**
 * 校验链接是否为对应平台的有效帖子（同时涵盖视频、图文、纯文字帖）
 */
function isValidPlatformPostUrl(url, platform) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/\/(?:login|accounts\/login|help|policies|plugins|privacy|terms)\b/i.test(u)) return false;

  switch (platform) {
    case 'instagram':
      return /instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+/i.test(u);
    case 'facebook':
      return /facebook\.com\/(?:reel\/|watch\/?\?v=|share\/|permalink\.php|story\.php|photo(?:\.php|\/)|[^/?#]+\/(?:posts|videos|photos)\/)/i.test(u);
    case 'x':
      return /(?:x\.com|twitter\.com)\/(?!i\/|intent\/|search|hashtag|explore|login)[^/?#]+\/status\/\d+/i.test(u);
    case 'threads':
      return /threads\.(?:net|com)\/@[^/?#]+\/post\/[A-Za-z0-9_-]+/i.test(u);
    case 'tiktok':
      return /(?:^|\/\/)(?:www\.|m\.|vt\.|vm\.)?tiktok\.com\/(?:@[^/?#]+\/(?:video|photo)\/\d+|t\/[A-Za-z0-9_-]+)/i.test(u) && !/shop\.tiktok\.com/i.test(u);
    default:
      return true;
  }
}

function extractMetaTag(html, propName) {
  if (!html) return '';
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${propName}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m1 = html.match(re1);
  if (m1) return decodeHtmlEntities(m1[1]);
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${propName}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeHtmlEntities(m2[1]) : '';
}

function normalizeUrlCandidate(rawHref) {
  let u = decodeHtmlEntities(String(rawHref || '').trim());
  if (!u) return '';
  // 解析 Bing ck/a 重定向 Base64 参数 u=a1...
  if (u.includes('bing.com/ck/a')) {
    try {
      const parsed = new URL(u);
      const uParam = parsed.searchParams.get('u');
      if (uParam && uParam.startsWith('a1')) {
        const b64 = uParam.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(decoded)) u = decoded;
      }
    } catch (_) { /* ignore */ }
  }
  // 解析 Yahoo RU= 或 DuckDuckGo uddg= 跳转链接
  const ruMatch = u.match(/\/RU=([^/]+)\//i);
  if (ruMatch) {
    try {
      u = decodeURIComponent(ruMatch[1]);
    } catch (_) { /* ignore */ }
  }
  const uddgMatch = u.match(/[?&]uddg=([^&]+)/i);
  if (uddgMatch) {
    try {
      u = decodeURIComponent(uddgMatch[1]);
    } catch (_) { /* ignore */ }
  }
  return /^https?:\/\//i.test(u) ? u : '';
}

function parseBingRssItems(xml) {
  const results = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const url = normalizeUrlCandidate((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    if (!url) continue;
    const title = stripHtmlTags((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const snippet = stripHtmlTags((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]);
    const pubDate = stripHtmlTags((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    results.push({ url, title, snippet, pubDate });
  }
  return results;
}

function parseBingHtmlItems(html) {
  const results = [];
  const algoRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = algoRe.exec(html)) !== null) {
    const block = m[1];
    const h2 = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!h2) continue;
    const url = normalizeUrlCandidate(h2[1]);
    if (!url) continue;
    const title = stripHtmlTags(h2[2]);
    const capMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = stripHtmlTags(capMatch ? capMatch[1] : '');
    results.push({ url, title, snippet, pubDate: '' });
  }
  return results;
}

function parseYahooHtmlItems(html) {
  const results = [];
  const blockRe = /<(?:div|li)[^>]+class="[^"]*\bcompTitle\b[^"]*"[^>]*>([\s\S]*?)(?=<(?:div|li)[^>]+class="[^"]*\bcompTitle\b|$)/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const chunk = m[1];
    const aMatch = chunk.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const url = normalizeUrlCandidate(aMatch[1]);
    if (!url || /search\.yahoo\.com|r\.search\.yahoo\.com/i.test(url)) continue;
    const h3Match = aMatch[2].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const rawTitle = stripHtmlTags(h3Match ? h3Match[1] : aMatch[2]);
    const title = rawTitle
      .replace(/^(?:Instagram|Facebook|Threads|X|Twitter|TikTok)\s+https?:\/\/\S+(?:\s*›\s*\S+)*\s*/i, '')
      .trim() || rawTitle;
    const pMatch = html.slice(m.index, m.index + 1600).match(/<div[^>]+class="[^"]*compText[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = stripHtmlTags(pMatch ? pMatch[1] : '');
    results.push({ url, title, snippet, pubDate: '' });
  }
  if (!results.length) {
    const ruRe = /href=["']([^"']*\/RU=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = ruRe.exec(html)) !== null) {
      const url = normalizeUrlCandidate(m[1]);
      if (!url || /yahoo\.com/i.test(url)) continue;
      results.push({ url, title: stripHtmlTags(m[2]), snippet: '', pubDate: '' });
    }
  }
  return results;
}

function parseDdgHtmlItems(html) {
  const results = [];
  const resRe = /<div[^>]+class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = resRe.exec(html)) !== null) {
    const block = m[1];
    const aMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const url = normalizeUrlCandidate(aMatch[1]);
    if (!url) continue;
    const h3Match = aMatch[2].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const rawTitle = stripHtmlTags(h3Match ? h3Match[1] : aMatch[2]);
    const title = rawTitle
      .replace(/^(?:Instagram|Facebook|Threads|X|Twitter|TikTok)\s+https?:\/\/\S+(?:\s*›\s*\S+)*\s*/i, '')
      .trim() || rawTitle;
    const snipMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = stripHtmlTags(snipMatch ? snipMatch[1] : '');
    results.push({ url, title, snippet, pubDate: '' });
  }
  if (!results.length) {
    const uddgRegex = /uddg=([^&"']+)/g;
    while ((m = uddgRegex.exec(html)) !== null) {
      const url = normalizeUrlCandidate(`?uddg=${m[1]}`);
      if (url) results.push({ url, title: '', snippet: '', pubDate: '' });
    }
  }
  return results;
}

/**
 * 通过多路公开搜索引擎索引发现指定站点下的视频/图文/纯文字帖子（遇到验证码/限流页干净跳过）
 */
async function discoverPublicPostsBySiteQuery(siteFilter, keyword, proxy, maxLinks = 6, dateFrom = '', dateTo = '', options = {}) {
  let dateClause = '';
  if (dateFrom) dateClause += ` after:${dateFrom}`;
  if (dateTo) dateClause += ` before:${dateTo}`;
  const isRecentWeek = Boolean(dateFrom && (Date.now() - Date.parse(dateFrom)) <= 9 * 24 * 3600 * 1000);

  const rawKw = String(keyword || '').trim();
  const queryVariants = /^laya$/i.test(rawKw)
    ? ['"Laya" 交友', '"Laya" 语音', 'layacouples OR "Laya: App" OR "Laya app"', '"Laya" voice chat dating', 'Laya 聊天 恋爱']
    : /^laya/i.test(rawKw)
      ? [rawKw, 'Laya 语音交友', '"Laya" app chat']
      : [rawKw];

  const engines = [
    {
      name: 'yahoo_html',
      timeoutMs: 6500,
      buildUrl: (qStr) => `https://search.yahoo.com/search?p=${encodeURIComponent(qStr)}${isRecentWeek ? '&btf=w' : ''}`,
      parse: parseYahooHtmlItems,
    },
    {
      name: 'ddg_html',
      timeoutMs: 6500,
      buildUrl: (qStr) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(qStr)}${isRecentWeek ? '&df=w' : ''}`,
      parse: parseDdgHtmlItems,
    },
    {
      name: 'bing_rss',
      timeoutMs: 5000,
      buildUrl: (qStr) => `https://www.bing.com/search?q=${encodeURIComponent(qStr)}&format=rss&count=15${isRecentWeek ? '&filters=ex1%3a%22ez2%22' : ''}`,
      parse: parseBingRssItems,
    },
  ];

  const collected = [];
  const seenUrls = new Set();
  let hadHealthyEngine = false;
  let blockedCount = 0;
  let totalEngineTries = 0;
  const pathHint = options.platform === 'x' ? ' status' : options.platform === 'threads' ? ' post' : '';

  for (const kwVariant of queryVariants) {
    if (collected.length >= maxLinks) break;
    const queryStr = `${siteFilter}${pathHint} ${kwVariant}${dateClause}`;

    for (const eng of engines) {
      if (collected.length >= maxLinks) break;
      totalEngineTries++;
      try {
        const resp = await proxyPool.requestRaw(
          eng.buildUrl(queryStr),
          {
            timeoutMs: eng.timeoutMs || 6500,
            headers: {
              'Accept-Language': 'zh-TW,zh-CN;q=0.9,en-US;q=0.8,en;q=0.7',
            },
          },
          proxy
        );

        if (resp.statusCode === 429 || resp.statusCode === 403) {
          blockedCount++;
          continue;
        }
        const rawBody = resp.text();
        if (CAPTCHA_GATE_RE.test(rawBody)) {
          blockedCount++;
          continue;
        }

        hadHealthyEngine = true;
        const parsed = eng.parse(rawBody);
        for (const item of parsed) {
          const cleanUrl = String(item.url || '').split('#')[0];
          if (!cleanUrl || seenUrls.has(cleanUrl)) continue;
          if (NON_DATING_LAYA_NOISE_RE.test(`${item.title} ${item.snippet} ${cleanUrl}`)) continue;
          if (options.platform && !isValidPlatformPostUrl(cleanUrl, options.platform)) continue;

          seenUrls.add(cleanUrl);
          collected.push({
            url: cleanUrl,
            title: item.title || '',
            snippet: item.snippet || '',
            pubDate: item.pubDate || '',
            parsedMetrics: parseEngagementFromSnippet(`${item.title} ${item.snippet}`),
          });
          if (collected.length >= maxLinks) break;
        }

        // 若该词条已经从健康引擎拿到数据，不重复扫后面兜底引擎；Laya 词表若数量不够则继续下一个关键词变体
        if (parsed.length > 0 && collected.length >= maxLinks) break;
        if (collected.length > 0 && eng.name === 'yahoo_html') break;
      } catch (_) {
        blockedCount++;
      }
    }
  }

  if (!hadHealthyEngine && totalEngineTries > 0 && blockedCount >= totalEngineTries) {
    const err = new Error('公开检索引擎均触发频率限制（需切换代理IP或使用防封浏览器窗口）');
    err.isRateLimit = true;
    throw err;
  }

  return collected;
}

/**
 * 向后兼容的纯 URL 列表发现函数
 */
async function discoverPublicUrlsBySiteQuery(siteFilter, keyword, proxy, maxLinks = 5, dateFrom = '', dateTo = '', options = {}) {
  const posts = await discoverPublicPostsBySiteQuery(siteFilter, keyword, proxy, maxLinks, dateFrom, dateTo, options);
  return posts.map((p) => p.url);
}

/**
 * 拉取公开帖子页面 OpenGraph 元数据
 */
async function fetchOpenGraphMetadata(postUrl, proxy) {
  const resp = await proxyPool.requestRaw(postUrl, { timeoutMs: 10000 }, proxy);
  if (resp.statusCode === 429) {
    const err = new Error('目标平台触发 HTTP 429 频率限制');
    err.isRateLimit = true;
    throw err;
  }
  const html = resp.text();
  return {
    title: extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title'),
    description: extractMetaTag(html, 'og:description') || extractMetaTag(html, 'description'),
    image: extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image'),
    duration: Number(extractMetaTag(html, 'video:duration') || 15) || 15,
  };
}

/**
 * 对接第三方 API（Apify / Custom JSON API / RSSHub）通用适配器
 */
async function fetchFromThirdPartyEndpoint({ platform, keyword, bucket, maxCount = 5, apiCfg = {}, proxy = null, dateFrom = '', dateTo = '' }) {
  // 1. 自定义标准 JSON 接口（支持团队内部中转站或购买的 API）
  if (apiCfg.baseUrl && apiCfg.baseUrl.startsWith('http')) {
    const endpoint = new URL(apiCfg.baseUrl);
    endpoint.searchParams.set('platform', platform);
    endpoint.searchParams.set('keyword', keyword);
    endpoint.searchParams.set('limit', String(maxCount));
    if (dateFrom) endpoint.searchParams.set('dateFrom', dateFrom);
    if (dateTo) endpoint.searchParams.set('dateTo', dateTo);
    const headers = {};
    if (apiCfg.apiKey) headers.Authorization = `Bearer ${apiCfg.apiKey}`;
    const resp = await proxyPool.requestRaw(endpoint.toString(), { headers, timeoutMs: 20000 }, proxy);
    if (resp.statusCode === 429) {
      const err = new Error('第三方采集接口触发 429 限流');
      err.isRateLimit = true;
      throw err;
    }
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const body = resp.json();
      const items = Array.isArray(body) ? body : body.items || body.data || [];
      return items.slice(0, maxCount).map((raw) => normalizeExternalItem(raw, platform, keyword, bucket));
    }
  }

  // 2. Apify Actor 标准调用（若配置了 apifyToken）
  if (apiCfg.provider === 'apify' && apiCfg.apifyToken) {
    const actorMap = {
      instagram: 'apify~instagram-hashtag-scraper',
      facebook: 'apify~facebook-posts-scraper',
      x: 'apidojo~tweet-scraper',
      threads: 'apify~threads-scraper',
      tiktok: 'clockworks~free-tiktok-scraper',
    };
    const actorId = actorMap[platform];
    if (actorId) {
      const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(apiCfg.apifyToken)}&limit=${maxCount}`;
      const inputPayload =
        platform === 'instagram'
          ? { hashtags: [keyword.replace(/\s+/g, '')], resultsLimit: maxCount, onlyPostsNewerThan: dateFrom || undefined }
          : { searchTerms: [keyword], maxItems: maxCount, start: dateFrom || undefined, end: dateTo || undefined };
      const resp = await proxyPool.requestRaw(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(inputPayload),
          timeoutMs: 30000,
        },
        null
      );
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        const list = resp.json();
        if (Array.isArray(list)) {
          return list.slice(0, maxCount).map((raw) => normalizeExternalItem(raw, platform, keyword, bucket));
        }
      }
    }
  }

  return [];
}

function normalizeExternalItem(raw, platform, keyword, bucket) {
  const text = raw.caption || raw.fullText || raw.text || raw.description || raw.title || '';
  const firstLine = text.split(/\r?\n/)[0].slice(0, 64) || `${platform.toUpperCase()} 热门交友素材`;
  const postUrl = raw.videoUrl || raw.url || raw.postUrl || raw.permalink || '';
  const rawCover = raw.coverUrl || raw.displayUrl || raw.thumbnailUrl || raw.image || '';
  const hasVideoHint = Boolean(raw.videoDuration || raw.videoPlayCount || /\/(?:reel|reels|videos|watch)/i.test(postUrl) || raw.type === 'Video');
  const mediaType = ['video', 'image', 'text'].includes(raw.mediaType)
    ? raw.mediaType
    : hasVideoHint
      ? 'video'
      : rawCover || /\/(?:p|photo)/i.test(postUrl)
        ? 'image'
        : 'text';

  return {
    platform,
    mediaType,
    title: raw.title || firstLine,
    fullText: text,
    videoUrl: postUrl,
    coverUrl: rawCover,
    publishedAt: raw.publishedAt || raw.timestamp || raw.createdAt || new Date().toISOString(),
    durationSec: mediaType === 'video' ? (Number(raw.durationSec || raw.videoDuration || 15) || 15) : 0,
    bgm: mediaType === 'video' ? (raw.bgm || raw.musicInfo?.song_name || 'Original Audio · 原声深夜电台') : (mediaType === 'image' ? '图文热帖（无音频）' : '纯文字热帖（无音频）'),
    plays: Number(raw.plays || raw.videoPlayCount || raw.viewCount || 12000),
    likes: Number(raw.likes || raw.likesCount || raw.likeCount || 650),
    comments: Number(raw.comments || raw.commentsCount || raw.replyCount || 48),
    shares: Number(raw.shares || raw.sharesCount || raw.retweetCount || 85),
    bookmarks: Number(raw.bookmarks || raw.savesCount || raw.bookmarkCount || 120),
    topComments: Array.isArray(raw.topComments)
      ? raw.topComments.slice(0, 3)
      : (raw.latestComments || []).slice(0, 3).map((c) => ({
          author: c.ownerUsername || c.author || 'user',
          text: c.text || String(c),
          likes: Number(c.likesCount || c.likes || 12),
        })),
    authorHandle: raw.authorHandle || raw.ownerUsername || raw.author?.userName || 'creator_social',
    authorFollowers: Number(raw.authorFollowers ?? raw.ownerFollowersCount ?? 8500),
    authorAgeDays: Number(raw.authorAgeDays ?? 365),
    sourceKeyword: keyword,
    sourceBucket: bucket,
    mediaFingerprint: raw.mediaFingerprint || raw.id || '',
    visualSceneDesc: raw.visualSceneDesc || '',
    visualHints: raw.visualHints || {},
  };
}

function resolvePublishedIsoByDateRange(defaultHoursAgo = 4, dateFrom = '', dateTo = '') {
  if (dateFrom || dateTo) {
    const startMs = dateFrom ? new Date(`${dateFrom}T09:00:00`).getTime() : new Date(`${dateTo}T09:00:00`).getTime() - 2 * 24 * 3600 * 1000;
    const endMs = dateTo ? new Date(`${dateTo}T21:00:00`).getTime() : Date.now();
    const safeEnd = Math.max(startMs, endMs);
    const midMs = Math.round(startMs + (safeEnd - startMs) * Math.min(0.85, Math.max(0.15, (defaultHoursAgo % 10) / 10)));
    return new Date(midMs).toISOString();
  }
  return new Date(Date.now() - defaultHoursAgo * 3600 * 1000).toISOString();
}

function buildCandidateFromPublicEntry({
  platform,
  entry,
  ext = {},
  keyword = '',
  bucket = 'generic',
  defaultHandle = 'social_creator',
  defaultVideoBgm = 'Original Audio',
  buildCoverFn = null,
}) {
  const snippetTitle = String(entry.title || '').trim();
  const snippetBody = String(entry.snippet || '').trim();
  const extTitle = ext.isPlaceholderText ? '' : String(ext.title || '').trim();
  const extBody = ext.isPlaceholderText ? '' : String(ext.fullText || '').trim();

  let urlSlugText = '';
  const thSlugMatch = String(entry.url || '').match(/threads\.(?:net|com)\/@[^/?#]+\/post\/[A-Za-z0-9_-]+\/([^/?#]+)/i);
  if (thSlugMatch && thSlugMatch[1]) {
    try {
      urlSlugText = decodeURIComponent(thSlugMatch[1]).replace(/[-_+]+/g, ' ').trim();
    } catch (_) {
      urlSlugText = '';
    }
  }
  const hasSlug = !extBody && urlSlugText.length >= 6;
  const desc = decodeHtmlEntities(extBody || (hasSlug ? urlSlugText : '') || snippetBody || extTitle || snippetTitle || '').trim();
  if (!desc || desc.length < 4) return null;

  let authorHandle = ext.authorHandle || '';
  if (!authorHandle || authorHandle === 'creator') {
    const mHandle =
      entry.url.match(/threads\.(?:net|com)\/@([^/?#]+)/i) ||
      entry.url.match(/tiktok\.com\/@([^/?#]+)/i) ||
      entry.url.match(/(?:x\.com|twitter\.com)\/([^/?#]+)\/status/i) ||
      entry.url.match(/instagram\.com\/([^/?#]+)\//i) ||
      entry.url.match(/facebook\.com\/([^/?#]+)\//i);
    const candidateHandle = mHandle ? mHandle[1] : '';
    const invalidHandles = ['reel', 'reels', 'p', 'tv', 'watch', 'share', 'photo', 'photo.php', 'permalink.php', 'story.php'];
    authorHandle = candidateHandle && !invalidHandles.includes(candidateHandle.toLowerCase()) ? candidateHandle : defaultHandle;
  }

  const title = cleanReadableTitle(extTitle || (hasSlug ? urlSlugText : '') || snippetTitle || desc, {
    fallbackText: desc,
    authorHandle,
    platform,
  });
  const mediaType = ['video', 'image', 'text'].includes(ext.mediaType)
    ? ext.mediaType
    : /\/(?:reel|reels|videos|watch)/i.test(entry.url) || /tiktok\.com\/@[^/?#]+\/video\//i.test(entry.url)
      ? 'video'
      : /\/(?:p|photo|photos)/i.test(entry.url) || /tiktok\.com\/@[^/?#]+\/photo\//i.test(entry.url) || ext.coverUrl
        ? 'image'
        : 'text';

  const pm = entry.parsedMetrics || {};
  const likes = Number(ext.likes || pm.likes || 0);
  const plays = Number(ext.plays || pm.plays || (likes > 0 ? likes * 14 : 0));
  const comments = Number(ext.comments || pm.comments || 0);
  const shares = Number(ext.shares || 0);
  const bookmarks = Number(ext.bookmarks || 0);
  const metricsUnknown = likes === 0 && plays === 0;

  const decodedThreadsIso = platform === 'threads' ? decodeThreadsPostTimestamp(entry.url) : '';
  let publishedIso = decodedThreadsIso || ext.publishedAt || new Date().toISOString();
  if (!decodedThreadsIso && (!ext.publishedAt || ext.isPlaceholderText) && entry.pubDate) {
    const pd = new Date(entry.pubDate);
    if (!Number.isNaN(pd.getTime())) publishedIso = pd.toISOString();
  }

  const cand = {
    platform,
    mediaType,
    title,
    fullText: desc,
    videoUrl: entry.url,
    coverUrl: ext.coverUrl || '',
    publishedAt: publishedIso,
    durationSec: mediaType === 'video' ? (Number(ext.durationSec || 15) || 15) : 0,
    bgm: mediaType === 'video' ? (ext.bgm || defaultVideoBgm) : mediaType === 'image' ? '图文热帖（无音频）' : '纯文字热帖（无音频）',
    plays,
    likes,
    comments,
    shares,
    bookmarks,
    topComments: [],
    authorHandle,
    authorFollowers: Number(ext.authorFollowers || 8500),
    authorAgeDays: 240,
    sourceKeyword: keyword,
    sourceBucket: bucket,
    mediaFingerprint: '',
    visualSceneDesc: mediaType === 'text' ? `纯文字社交热帖：${title}` : title,
    visualHints: {},
    _metricsUnknown: metricsUnknown,
  };

  if (!cand.coverUrl && typeof buildCoverFn === 'function') {
    cand.coverUrl = buildCoverFn(cand);
  }
  return cand;
}

module.exports = {
  NON_DATING_LAYA_NOISE_RE,
  decodeThreadsPostTimestamp,
  isCompliantHealthyPost,
  decodeHtmlEntities,
  cleanReadableTitle,
  extractMetaTag,
  parseEngagementFromSnippet,
  isValidPlatformPostUrl,
  discoverPublicPostsBySiteQuery,
  discoverPublicUrlsBySiteQuery,
  fetchOpenGraphMetadata,
  fetchFromThirdPartyEndpoint,
  normalizeExternalItem,
  buildCandidateFromPublicEntry,
  resolvePublishedIsoByDateRange,
};
