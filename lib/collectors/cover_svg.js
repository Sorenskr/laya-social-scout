'use strict';
/**
 * 高辨识度 9:16 竖屏真机感大封面生成器
 * 当海外视频一时拉不到远程大图时，自动根据每一条视频自己的真实标题、前两句对白、
 * 所属平台颜色、点赞量和歌曲名动态排版专属封面，保证绝不千篇一律，不用点开就能分清哪条对哪条！
 */

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapLines(text, maxChars = 14, maxLines = 3) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  let i = 0;
  while (i < clean.length && lines.length < maxLines) {
    lines.push(clean.slice(i, i + maxChars));
    i += maxChars;
  }
  if (i < clean.length && lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, Math.max(1, maxChars - 1)) + '…';
  }
  return lines;
}

function formatLikesShort(n) {
  const num = Number(n || 0);
  if (num >= 10000) return (num / 10000).toFixed(1) + 'w 赞';
  return num.toLocaleString('zh-CN') + ' 赞';
}

const PLATFORM_THEME = {
  IG: { bg1: '#1a0b2e', bg2: '#3b0764', accent: '#e1306c', pill: 'Instagram 爆款' },
  FB: { bg1: '#0b192c', bg2: '#172554', accent: '#2563eb', pill: 'Facebook 热门' },
  X: { bg1: '#090d16', bg2: '#1e293b', accent: '#0ea5e9', pill: 'X (Twitter)' },
  Threads: { bg1: '#052e16', bg2: '#0f172a', accent: '#10b981', pill: 'Threads 热议' },
  TikTok: { bg1: '#090d16', bg2: '#2e081c', accent: '#fe2c55', pill: 'TikTok 爆款' },
};

function buildChatCoverDataUri({
  platformName = 'IG',
  title = '',
  bubble1 = '睡了吗？刚连麦听到你声音好温柔',
  bubble2 = '还没呢，要不要挂着语音一起听歌？',
  voiceSec = '11"',
  likes = 5200,
  bgm = '深夜微醺伴奏',
  accent = '',
}) {
  const key = platformName.includes('FB')
    ? 'FB'
    : platformName.includes('X')
      ? 'X'
      : platformName.includes('Threads')
        ? 'Threads'
        : platformName.includes('TikTok')
          ? 'TikTok'
          : 'IG';
  const theme = PLATFORM_THEME[key] || PLATFORM_THEME.IG;
  const mainAccent = accent || theme.accent;
  const titleLines = wrapLines(title || bubble1, 13, 2);
  const b1Lines = wrapLines(bubble1, 15, 2);
  const b2Lines = wrapLines(bubble2, 15, 2);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="760" viewBox="0 0 540 760">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="${theme.bg1}"/>
      <stop offset="100%" stop-color="${theme.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="540" height="760" fill="url(#bg)"/>
  <circle cx="470" cy="110" r="120" fill="${escapeXml(mainAccent)}" opacity="0.18"/>
  <rect x="26" y="28" width="488" height="54" rx="15" fill="rgba(255,255,255,0.09)"/>
  <circle cx="58" cy="55" r="8" fill="#22c55e"/>
  <text x="78" y="62" fill="#f8fafc" font-size="20" font-family="sans-serif" font-weight="700">${escapeXml(theme.pill)}</text>
  <rect x="366" y="38" width="132" height="34" rx="17" fill="${escapeXml(mainAccent)}"/>
  <text x="432" y="61" text-anchor="middle" fill="#ffffff" font-size="18" font-family="sans-serif" font-weight="700">${escapeXml(formatLikesShort(likes))}</text>

  <rect x="26" y="102" width="488" height="106" rx="18" fill="rgba(15,23,42,0.58)" stroke="rgba(255,255,255,0.14)"/>
  <text x="48" y="144" fill="#ffffff" font-size="27" font-family="sans-serif" font-weight="800">${escapeXml(titleLines[0] || '')}</text>
  <text x="48" y="186" fill="#e2e8f0" font-size="24" font-family="sans-serif" font-weight="700">${escapeXml(titleLines[1] || '')}</text>

  <rect x="32" y="238" width="388" height="98" rx="22" fill="#1e293b" stroke="rgba(255,255,255,0.14)"/>
  <text x="54" y="278" fill="#f8fafc" font-size="21" font-family="sans-serif">${escapeXml(b1Lines[0] || '')}</text>
  <text x="54" y="312" fill="#cbd5e1" font-size="20" font-family="sans-serif">${escapeXml(b1Lines[1] || '')}</text>

  <rect x="116" y="362" width="392" height="98" rx="22" fill="${escapeXml(mainAccent)}"/>
  <text x="140" y="402" fill="#ffffff" font-size="21" font-family="sans-serif" font-weight="600">${escapeXml(b2Lines[0] || '')}</text>
  <text x="140" y="436" fill="#fdf2f8" font-size="20" font-family="sans-serif">${escapeXml(b2Lines[1] || '')}</text>

  <rect x="32" y="488" width="310" height="74" rx="22" fill="#1e293b" stroke="rgba(255,255,255,0.16)"/>
  <circle cx="70" cy="525" r="17" fill="${escapeXml(mainAccent)}"/>
  <polygon points="65,517 65,533 78,525" fill="#ffffff"/>
  <rect x="104" y="512" width="8" height="26" rx="4" fill="#cbd5e1"/>
  <rect x="120" y="502" width="8" height="44" rx="4" fill="#f472b6"/>
  <rect x="136" y="515" width="8" height="20" rx="4" fill="#cbd5e1"/>
  <rect x="152" y="506" width="8" height="38" rx="4" fill="#f472b6"/>
  <rect x="168" y="514" width="8" height="22" rx="4" fill="#cbd5e1"/>
  <rect x="184" y="509" width="8" height="32" rx="4" fill="#f472b6"/>
  <text x="262" y="533" fill="#f8fafc" font-size="22" font-family="sans-serif" font-weight="700">${escapeXml(voiceSec)}</text>

  <rect x="26" y="644" width="488" height="86" rx="18" fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.12)"/>
  <text x="48" y="681" fill="#a7f3d0" font-size="19" font-family="sans-serif" font-weight="700">✓ 聊天录屏模板 · 无真人露脸可照抄</text>
  <text x="48" y="712" fill="#cbd5e1" font-size="18" font-family="sans-serif">🎵 ${escapeXml(String(bgm).slice(0, 26))}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

function buildMoodCoverDataUri({
  platformName = 'FB',
  title = '',
  headline = '凌晨一点没人说话的瞬间',
  subline = '直到耳机里传来那句轻轻的晚安',
  likes = 8500,
  bgm = '深夜情绪钢琴曲',
  accent = '#6366f1',
}) {
  const titleLines = wrapLines(title || headline, 12, 3);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="760" viewBox="0 0 540 760">
  <defs>
    <linearGradient id="night" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#090d16"/>
      <stop offset="55%" stop-color="#1e1b4b"/>
      <stop offset="100%" stop-color="#311042"/>
    </linearGradient>
  </defs>
  <rect width="540" height="760" fill="url(#night)"/>
  <circle cx="410" cy="170" r="110" fill="${escapeXml(accent)}" opacity="0.24"/>
  <circle cx="120" cy="540" r="140" fill="#ec4899" opacity="0.16"/>

  <rect x="28" y="30" width="484" height="52" rx="14" fill="rgba(255,255,255,0.08)"/>
  <text x="48" y="63" fill="#f8fafc" font-size="20" font-family="sans-serif" font-weight="700">${escapeXml(platformName)} · 空镜混剪</text>
  <text x="486" y="63" text-anchor="end" fill="#6ee7b7" font-size="19" font-family="sans-serif" font-weight="700">${escapeXml(formatLikesShort(likes))}</text>

  <rect x="36" y="114" width="468" height="108" rx="22" fill="rgba(255,255,255,0.11)" stroke="rgba(255,255,255,0.2)"/>
  <text x="64" y="156" fill="#94a3b8" font-size="18" font-family="sans-serif">📱 深夜消息通知 · 刚刚</text>
  <text x="64" y="194" fill="#ffffff" font-size="22" font-family="sans-serif" font-weight="600">「${escapeXml(String(subline).slice(0, 18))}」</text>

  <text x="270" y="352" text-anchor="middle" fill="#ffffff" font-size="33" font-family="sans-serif" font-weight="800">${escapeXml(titleLines[0] || '')}</text>
  <text x="270" y="406" text-anchor="middle" fill="#f1f5f9" font-size="31" font-family="sans-serif" font-weight="700">${escapeXml(titleLines[1] || '')}</text>
  <text x="270" y="460" text-anchor="middle" fill="#cbd5e1" font-size="26" font-family="sans-serif" font-weight="600">${escapeXml(titleLines[2] || '')}</text>

  <rect x="28" y="644" width="484" height="86" rx="18" fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.14)"/>
  <text x="48" y="681" fill="#a7f3d0" font-size="19" font-family="sans-serif" font-weight="700">✓ 夜景空镜混剪 · 可一键套文案</text>
  <text x="48" y="712" fill="#cbd5e1" font-size="18" font-family="sans-serif">🎵 ${escapeXml(String(bgm).slice(0, 26))}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

function buildTrapCoverDataUri({ trapType = 'face', label = '右下角真人小窗露脸口播' }) {
  const bg = trapType === 'game' ? '#14532d' : trapType === 'ad' ? '#7c2d12' : '#4c0519';
  const badge = trapType === 'game' ? '已拦截：游戏录屏废片' : trapType === 'ad' ? '已拦截：直白硬广推销' : '已拦截：画面有真人露脸';
  const lines = wrapLines(label, 14, 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="760" viewBox="0 0 540 760">
  <rect width="540" height="760" fill="${bg}"/>
  <rect x="40" y="60" width="460" height="64" rx="14" fill="rgba(0,0,0,0.5)"/>
  <text x="270" y="100" text-anchor="middle" fill="#fca5a5" font-size="24" font-family="sans-serif" font-weight="800">⛔ ${escapeXml(badge)}</text>
  <text x="270" y="330" text-anchor="middle" fill="#ffffff" font-size="27" font-family="sans-serif" font-weight="700">${escapeXml(lines[0] || '')}</text>
  <text x="270" y="376" text-anchor="middle" fill="#fecaca" font-size="24" font-family="sans-serif">${escapeXml(lines[1] || '')}</text>
  <rect x="320" y="480" width="180" height="210" rx="18" fill="rgba(255,255,255,0.15)" stroke="#f87171" stroke-width="3"/>
  <text x="410" y="592" text-anchor="middle" fill="#fecaca" font-size="20" font-family="sans-serif" font-weight="700">${trapType === 'game' ? '游戏操作画面' : '小窗真人区'}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

function formatCountShort(n) {
  const num = Number(n || 0);
  if (num >= 10000) return (num / 10000).toFixed(1) + 'w';
  return num.toLocaleString('zh-CN');
}

function buildTextPostCoverDataUri({
  platformName = 'Threads',
  title = '',
  bodyText = '',
  likes = 1200,
  plays = 18000,
  mediaType = 'text',
  accent = '',
}) {
  const key = platformName.includes('FB')
    ? 'FB'
    : platformName.includes('X')
      ? 'X'
      : platformName.includes('Threads')
        ? 'Threads'
        : platformName.includes('TikTok')
          ? 'TikTok'
          : 'IG';
  const theme = PLATFORM_THEME[key] || PLATFORM_THEME.Threads;
  const mainAccent = accent || theme.accent;
  const badgeLabel = mediaType === 'image' ? '🖼️ 图文热帖' : '📝 纯文字热帖';
  const titleLines = wrapLines(title || bodyText, 13, 2);
  const bodyLines = wrapLines(bodyText || title, 16, 5);
  const metricsText = `${formatLikesShort(likes)}${Number(plays) > 0 ? ' · ' + formatCountShort(plays) + ' 浏览' : ''}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="760" viewBox="0 0 540 760">
  <defs>
    <linearGradient id="txtbg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="${theme.bg1}"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="540" height="760" fill="url(#txtbg)"/>
  <circle cx="460" cy="130" r="115" fill="${escapeXml(mainAccent)}" opacity="0.18"/>
  <rect x="26" y="28" width="488" height="54" rx="15" fill="rgba(255,255,255,0.09)"/>
  <text x="48" y="62" fill="#f8fafc" font-size="20" font-family="sans-serif" font-weight="800">${escapeXml(badgeLabel)} · ${escapeXml(key)}</text>
  <rect x="330" y="38" width="168" height="34" rx="17" fill="${escapeXml(mainAccent)}"/>
  <text x="414" y="61" text-anchor="middle" fill="#ffffff" font-size="16" font-family="sans-serif" font-weight="700">${escapeXml(metricsText)}</text>

  <rect x="26" y="102" width="488" height="114" rx="18" fill="rgba(15,23,42,0.72)" stroke="rgba(255,255,255,0.16)"/>
  <text x="48" y="148" fill="#ffffff" font-size="27" font-family="sans-serif" font-weight="800">${escapeXml(titleLines[0] || '')}</text>
  <text x="48" y="192" fill="#e2e8f0" font-size="24" font-family="sans-serif" font-weight="700">${escapeXml(titleLines[1] || '')}</text>

  <rect x="26" y="238" width="488" height="380" rx="22" fill="rgba(30,41,59,0.88)" stroke="rgba(255,255,255,0.14)"/>
  <text x="50" y="294" fill="#94a3b8" font-size="18" font-family="sans-serif" font-weight="600">正文内容摘要</text>
  <text x="50" y="346" fill="#f8fafc" font-size="22" font-family="sans-serif">${escapeXml(bodyLines[0] || '')}</text>
  <text x="50" y="396" fill="#f1f5f9" font-size="22" font-family="sans-serif">${escapeXml(bodyLines[1] || '')}</text>
  <text x="50" y="446" fill="#e2e8f0" font-size="22" font-family="sans-serif">${escapeXml(bodyLines[2] || '')}</text>
  <text x="50" y="496" fill="#cbd5e1" font-size="21" font-family="sans-serif">${escapeXml(bodyLines[3] || '')}</text>
  <text x="50" y="546" fill="#cbd5e1" font-size="21" font-family="sans-serif">${escapeXml(bodyLines[4] || '')}</text>

  <rect x="26" y="644" width="488" height="86" rx="18" fill="rgba(0,0,0,0.48)" stroke="rgba(255,255,255,0.14)"/>
  <text x="48" y="681" fill="#a7f3d0" font-size="19" font-family="sans-serif" font-weight="700">✓ 图文/文字高赞帖 · 可直接套文案复刻</text>
  <text x="48" y="712" fill="#cbd5e1" font-size="18" font-family="sans-serif">${escapeXml(metricsText || '社媒原生热帖')}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

/**
 * 兜底按标题与平台给任意无封面视频/图文/文字帖生成专属大封面
 */
function buildDynamicCoverForCandidate(cand) {
  const pMap = { instagram: 'IG', facebook: 'FB', x: 'X', threads: 'Threads', tiktok: 'TikTok' };
  const pName = pMap[cand.platform] || 'IG';
  if (cand.mediaType === 'text' || cand.mediaType === 'image') {
    return buildTextPostCoverDataUri({
      platformName: pName,
      title: cand.title,
      bodyText: cand.fullText || cand.title,
      likes: cand.likes || 0,
      plays: cand.plays || 0,
      mediaType: cand.mediaType,
    });
  }
  const text = `${cand.title || ''} ${cand.fullText || ''}`;
  if (/混剪|空镜|夜景|车库|情绪|独白/i.test(text)) {
    return buildMoodCoverDataUri({
      platformName: pName,
      title: cand.title,
      subline: cand.fullText,
      likes: cand.likes || 3000,
      bgm: cand.bgm || '深夜氛围感背景音',
    });
  }
  const sentences = String(cand.fullText || cand.title || '')
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  return buildChatCoverDataUri({
    platformName: pName,
    title: cand.title,
    bubble1: sentences[0] || cand.title || '深夜语音连麦聊天录屏',
    bubble2: sentences[1] || '没想到对面声音这么温柔，直接聊上头了',
    voiceSec: `${Math.max(6, Math.min(19, Math.round((cand.durationSec || 15) * 0.7)))}"`,
    likes: cand.likes || 3000,
    bgm: cand.bgm || 'Original Audio',
  });
}

module.exports = {
  buildChatCoverDataUri,
  buildMoodCoverDataUri,
  buildTextPostCoverDataUri,
  buildTrapCoverDataUri,
  buildDynamicCoverForCandidate,
};
