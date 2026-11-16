export const videoHosts = [
  'youtube.com', 'youtu.be', 'douyin.com', 'iesdouyin.com', 'bilibili.com', 'b23.tv',
  'x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'fb.watch',
  'kuaishou.com', 'kwai.com', 'xiaohongshu.com', 'xhslink.com', 'xhslink.cn'
];

export function hostMatches(hostname, hosts) {
  const host = hostname.toLowerCase();
  return hosts.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function extractVideoUrl(value) {
  const match = (typeof value === 'string' ? value : '').match(/https?:\/\/[^\s，。！？；【】<>"']+/i);
  if (!match) throw new Error('请粘贴包含 http 或 https 的公开视频链接。');
  let url;
  try { url = new URL(match[0].replace(/[）)\]】>，,。.!！?？;；'\"]+$/g, '')); }
  catch { throw new Error('没有识别到有效的视频链接。'); }
  if (url.username || url.password) throw new Error('链接中不能包含账号或密码。');
  if (!['http:', 'https:'].includes(url.protocol) || url.port || !hostMatches(url.hostname, videoHosts)) {
    throw new Error('请使用抖音、B站、YouTube、X、Instagram、TikTok、Facebook、快手或小红书的公开视频链接。');
  }
  return url.href;
}

export function normalizeVideoUrl(value) {
  const url = new URL(extractVideoUrl(value));
  if (hostMatches(url.hostname, ['xiaohongshu.com']) && url.pathname === '/login') {
    const original = url.searchParams.get('redirectPath');
    if (original) {
      const target = new URL(original, 'https://www.xiaohongshu.com');
      if (!target.username && !target.password && !target.port
        && ['http:', 'https:'].includes(target.protocol)
        && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(target.hostname)
        && /^\/(?:explore|discovery\/item)\/[a-f\d]+\/?$/i.test(target.pathname)) {
        target.protocol = 'https:';
        return target.href;
      }
    }
    throw new Error('小红书中转页没有提供有效的视频地址，请使用视频的分享链接。');
  }
  if (hostMatches(url.hostname, ['douyin.com', 'iesdouyin.com'])) {
    const id = url.pathname.match(/\/(?:video|note|slides)\/(\d+)/)?.[1]
      || ['modal_id', 'aweme_id', 'item_ids'].map(key => url.searchParams.get(key)).find(value => /^\d+$/.test(value || ''));
    if (id) return `https://www.douyin.com/video/${id}`;
  }
  return url.href;
}
