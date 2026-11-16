import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoUrl, normalizeVideoUrl } from './public/video-links.js';
import { resolveVideoUrl, downloaderError, downloadWithRetries, findChromePath } from './video-download.mjs';

const note = 'https://www.xiaohongshu.com/discovery/item/6abbe5ff000000000a021f5c?xsec_token=test-share-value&type=video';
const login = `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(note.replace('https:', 'http:'))}`;
const fail = text => { throw downloaderError(text); };

test('小红书分享文字中的短链接和末尾中文标点可正确识别', () => {
  assert.equal(extractVideoUrl('你问一句话 https://xhslink.cn/o/example，来【小红书】瞅瞅~'), 'https://xhslink.cn/o/example');
});

test('小红书登录中转页还原公开视频地址，保留分享参数并使用 HTTPS', () => {
  assert.equal(normalizeVideoUrl(login), note);
  assert.equal(normalizeVideoUrl('https://www.xiaohongshu.com/login?redirectPath=%2Fexplore%2Fabc123'), 'https://www.xiaohongshu.com/explore/abc123');
});

test('只接受真实小红书笔记地址，拒绝外站、凭据、非标准端口和非网页协议', () => {
  for (const target of ['https://xiaohongshu.com.evil.test/explore/abc123', 'https://evil.test/explore/abc123',
    'https://name:secret@www.xiaohongshu.com/explore/abc123', 'https://www.xiaohongshu.com:444/explore/abc123',
    'file:///explore/abc123', 'https://www.xiaohongshu.com/settings']) {
    assert.throws(() => normalizeVideoUrl(`https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(target)}`));
  }
  assert.throws(() => extractVideoUrl('https://douyin.com.evil.test/video/123'));
  assert.throws(() => extractVideoUrl('https://douyin.com:444/video/123'));
});

test('小红书短链接跳转到登录页时交给笔记解析器，不请求登录页', async () => {
  const visited = [];
  const url = await resolveVideoUrl('https://xhslink.cn/o/example', async (url, options) => {
    visited.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: login } });
  });
  assert.equal(url, note);
  assert.deepEqual(visited, ['https://xhslink.cn/o/example']);
});

test('短链接每次跳转检查域名、限制跳转次数，并取消未使用的响应流', async () => {
  await assert.rejects(resolveVideoUrl('https://xhslink.com/a', async () => new Response(null, {
    status: 302, headers: { location: 'http://127.0.0.1/private' }
  })), /公开视频链接/);
  let cancelled = 0;
  await assert.rejects(resolveVideoUrl('https://xhslink.com/a', async () => ({
    status: 302, headers: new Headers({ location: '/a' }), body: { cancel: async () => cancelled++ }
  })), /跳转次数/);
  assert.equal(cancelled, 6);
});

test('抖音桌面弹层、分享页和视频链接统一为单视频地址', () => {
  for (const url of ['https://www.douyin.com/?modal_id=6961737553342991651',
    'https://www.iesdouyin.com/share/video/6961737553342991651/?region=CN',
    'https://www.douyin.com/note/6961737553342991651']) {
    assert.equal(normalizeVideoUrl(url), 'https://www.douyin.com/video/6961737553342991651');
  }
});

test('抖音短链接和B站短链接还原真实单视频地址', async () => {
  for (const [short, long, result] of [
    ['https://v.douyin.com/example/', 'https://www.iesdouyin.com/share/video/6961737553342991651/', 'https://www.douyin.com/video/6961737553342991651'],
    ['https://b23.tv/example', 'https://www.bilibili.com/video/BV1xx/?share_source=copy', 'https://www.bilibili.com/video/BV1xx/?share_source=copy']
  ]) {
    assert.equal(await resolveVideoUrl(short, async () => new Response(null, { status: 302, headers: { location: long } })), result);
  }
});

test('直接视频链接无需额外访问中转页', async () => {
  const url = 'https://www.youtube.com/watch?v=abc123';
  assert.equal(await resolveVideoUrl(url, () => { throw new Error('不应请求'); }), url);
});

test('工具报错区分依赖、网络、格式、登录和平台解析，不臆测已读取Chrome', () => {
  for (const [log, code] of [
    ['ffmpeg not found. Please install', 'DEPENDENCY'],
    ['Could not copy Chrome cookie database', 'COOKIES'],
    ['Failed to decrypt with keychain', 'COOKIES'],
    ['Requested format is not available', 'FORMAT'],
    ['Fresh cookies (not necessarily logged in) are needed', 'EXTRACTOR'],
    ['Sign in to confirm your age', 'AUTH'],
    [`Unsupported URL: ${login}`, 'AUTH'],
    ['Unsupported URL: https://xhslink.cn/a', 'UNSUPPORTED'],
    ['Unable to download webpage: HTTP Error 429', 'NETWORK'],
    ['This video is private', 'UNAVAILABLE'],
    ['larger than max-filesize', 'SIZE']
  ]) {
    const error = downloaderError(log);
    assert.equal(error.code, code, log);
    assert.doesNotMatch(error.message, /已尝试读取 Chrome|登录状态正常/);
  }
});

test('公开视频优先匿名下载，即使配置了浏览器也不直接读取登录数据', async () => {
  const calls = [];
  const result = await downloadWithRetries({ url: note, quality: '1080', cookieBrowser: 'chrome',
    run: async options => { calls.push(options); return 'ok'; } });
  assert.equal(result, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cookieBrowser, '');
});

test('画质不匹配自动切换最高可用格式，保留原链接', async () => {
  const calls = [];
  await downloadWithRetries({ url: note, quality: '1080', run: async options => {
    calls.push(options);
    if (calls.length === 1) fail('Requested format is not available');
  } });
  assert.deepEqual(calls.map(value => value.quality), ['1080', 'best']);
  assert.ok(calls.every(value => value.url === note));
});

test('平台确实要求登录时只重试用户明确配置的浏览器，重试次数有限', async () => {
  const calls = [];
  await assert.rejects(downloadWithRetries({ url: note, quality: '1080', cookieBrowser: 'firefox', run: async options => {
    calls.push(options);
    fail('Sign in to confirm your age');
  } }), { code: 'AUTH' });
  assert.deepEqual(calls.map(value => value.cookieBrowser), ['', 'firefox']);
});

test('未配置浏览器、网络失败、超大文件均不会读取Chrome或无休止重试', async () => {
  for (const text of ['Sign in to confirm your age', 'HTTP Error 429', 'larger than max-filesize']) {
    let count = 0;
    await assert.rejects(downloadWithRetries({ url: note, quality: '1080', run: async () => { count++; fail(text); } }));
    assert.equal(count, 1);
  }
});

test('先画质降级再登录重试组合可正常完成', async () => {
  const calls = [];
  const result = await downloadWithRetries({ url: note, quality: '720', cookieBrowser: 'chrome', run: async options => {
    calls.push(options);
    if (calls.length === 1) fail('No video formats found');
    if (calls.length === 2) fail('Fresh cookies are needed');
    return 'ok';
  } });
  assert.equal(result, 'ok');
  assert.deepEqual(calls.map(value => [value.quality, value.cookieBrowser]), [['720', ''], ['best', ''], ['best', 'chrome']]);
});

test('抖音浏览器辅助解析支持Mac、Linux、Windows且不使用个人机器路径', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const candidates = [];
    const result = await findChromePath('', { PROGRAMFILES: 'C:/Program Files' }, platform, async path => { candidates.push(path); });
    assert.ok(result.includes('Chrome') || result.includes('chrome'));
    assert.equal(candidates.length, 1);
  }
  await assert.rejects(findChromePath('/missing/chrome', {}, 'linux', async () => { throw new Error(); }), { code: 'BROWSER' });
});
