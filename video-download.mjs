import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { extractVideoUrl, normalizeVideoUrl, hostMatches } from './public/video-links.js';
export { extractVideoUrl, hostMatches };

const shortHosts = ['xhslink.com', 'xhslink.cn', 'v.douyin.com', 'b23.tv'];

// Follow only supported public share redirects. Never fetch an arbitrary login return URL.
export async function resolveVideoUrl(value, fetcher = fetch) {
  let url = normalizeVideoUrl(value);
  if (!hostMatches(new URL(url).hostname, shortHosts)) return url;
  const deadline = AbortSignal.timeout(30_000);
  for (let hop = 0; hop < 6; hop++) {
    let response;
    try {
      response = await fetcher(url, {
        redirect: 'manual', signal: deadline,
        headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }
      });
    } catch { throw failure('NETWORK', '无法连接视频分享链接，请检查本机网络后重试。'); }
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) throw new Error(`视频分享链接暂时无法访问（${response.status}）。`);
      return url;
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('视频分享链接没有返回目标地址。');
    url = normalizeVideoUrl(new URL(location, url).href);
    if (!hostMatches(new URL(url).hostname, shortHosts)) return url;
  }
  throw new Error('视频分享链接跳转次数过多，请重新复制视频链接。');
}

function failure(code, message) { return Object.assign(new Error(message), { code }); }

export function downloaderError(log) {
  if (/ffmpeg.*(?:not found|not installed|does not exist)|ffprobe.*not found|no such file or directory.*ffmpeg/i.test(log)) {
    return failure('DEPENDENCY', '视频合并工具未安装或路径无效，请安装 FFmpeg 后重启服务。');
  }
  if (/could not copy.*cookie|failed to decrypt|could not find.*cookies|keyring|keychain|failed to load cookies/i.test(log)) {
    return failure('COOKIES', '无法读取配置的浏览器登录状态，请确认本机浏览器已安装并允许读取；也可清空 VIDEO_COOKIE_BROWSER 后重试公开下载。');
  }
  if (/larger than max-filesize|maximum file size/i.test(log)) return failure('SIZE', '视频文件超过 1 GB，已停止下载。');
  if (/requested format (?:is )?not available|no video formats found/i.test(log)) return failure('FORMAT', '该视频没有符合所选清晰度的可用格式。');
  if (/fresh cookies|failed to parse json/i.test(log)) return failure('EXTRACTOR', '平台暂未向下载器返回有效的视频数据。');
  if (/private video|video is private|has been removed|video (?:is |has been )?unavailable|copyright|私密|已删除/i.test(log)) {
    return failure('UNAVAILABLE', '该视频已不可用，或受到私密、地区或版权限制。');
  }
  if (/sign in|log[ -]?in (?:required|to|with)|login required|authentication required|use --cookies|需要登录|账号权限/i.test(log)
    || /https?:\/\/[^\s]+\/login(?:[?\s]|$)/i.test(log)) {
    return failure('AUTH', '平台要求登录或账号权限；公开下载未获得可用的视频数据。可在本机配置 VIDEO_COOKIE_BROWSER 使用自己的登录状态。');
  }
  if (/timed? out|unable to download webpage|HTTP Error (?:403|429|5\d\d)|connection|network|certificate|resolve.*host/i.test(log)) {
    return failure('NETWORK', '连接视频平台失败或请求受限，请稍后重试并检查本机网络。');
  }
  if (/unsupported url|no suitable extractor/i.test(log)) return failure('UNSUPPORTED', '暂时无法解析这个链接，请更新 yt-dlp 或重新复制视频分享链接。');
  return failure('DOWNLOAD', '视频下载失败，请确认链接可公开播放，并检查下载工具是否为最新版本。');
}

// Try public access first, retry formats once, then use only explicitly configured browser cookies.
export async function downloadWithRetries({ url, quality, cookieBrowser = '', run, report = () => {} }) {
  let selectedQuality = quality;
  let browser = '';
  if (cookieBrowser && !/^(?:chrome|chromium|edge|firefox|brave|safari)(?::[^\r\n]+)?$/.test(cookieBrowser)) {
    throw failure('CONFIG', 'VIDEO_COOKIE_BROWSER 配置无效，请填写本机使用的浏览器名称。');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await run({ url, quality: selectedQuality, cookieBrowser: browser }); }
    catch (error) {
      if (error.code === 'FORMAT' && selectedQuality !== 'best') {
        selectedQuality = 'best';
        report({ phase: '正在重试可用画质', detail: '使用源站提供的最佳格式…', percent: 10 });
      } else if (['AUTH', 'EXTRACTOR'].includes(error.code) && cookieBrowser && !browser) {
        browser = cookieBrowser;
        report({ phase: '正在读取登录状态', detail: '使用本机配置的浏览器重试…', percent: 12 });
      } else { throw error; }
    }
  }
}

export async function findChromePath(explicit = '', env = process.env, platform = process.platform, exists = access) {
  const candidates = explicit ? [explicit] : platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : platform === 'win32'
      ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(root => join(root, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try { await exists(candidate); return candidate; } catch { /* try the next installation */ }
  }
  throw failure('BROWSER', '抖音浏览器辅助下载需要本机安装 Chrome 或 Chromium；自定义安装位置可通过 CHROME_PATH 配置。');
}
