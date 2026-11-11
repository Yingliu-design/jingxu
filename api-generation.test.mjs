import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extractMarkdownShots } from './markdown-shots.mjs';

// Exercise the real API handler, with only the external provider replaced.
let handlerPromise;
let activeHarness;
async function loadApiHandler() {
  const serverUrl = new URL('./server.mjs', import.meta.url);
  let handler;
  const context = vm.createContext({ process: { env: {} }, console: { log() {}, error() {} },
    Buffer, URL, Error, SyntaxError, AbortSignal, TextDecoder, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(await readFile(serverUrl, 'utf8'), {
    context, initializeImportMeta(meta) { meta.url = serverUrl.href; }
  });
  await module.link(async spec => {
    const ns = spec === 'undici' ? { ProxyAgent: class {}, fetch() { throw new Error('未模拟的外部请求'); } }
      : await import(spec.startsWith('.') ? new URL(spec, serverUrl).href : spec);
    const exports = { ...ns };
    if (spec === 'node:http') exports.createServer = fn => { handler = fn; return { listen() {} }; };
    if (spec === './api-config.mjs') exports.createApiConfigStore = async () => ({
      get: () => ({ apiKey: activeHarness.configured ? 'test-only-fake-key' : '', defaultModel: 'test-model' })
    });
    if (spec === 'undici') exports.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      const translation = body.generationConfig.responseSchema.properties.lines;
      activeHarness.calls.push(translation ? 'translation' : 'storyboard');
      const data = translation ? { lines: activeHarness.failedTranslation ? []
        : JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).map(item => {
          const text = { 'from barrel': '从木桶内部观察', 'I am not K.': '我不是凯。' }[item.text];
          assert.ok(text, `未预期的英文片段：${item.text}`);
          return { id: item.id, text };
        }) } : { title: '庭院故事', shots: Array.from({ length: 30 }, (_, i) => ({
          number: i + 1, visual: '【全景】少女手中捏着铜板，满脸愁容。 POV from barrel', dialogue: '无'
        })) };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] }) };
    };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  // Keep one module/context alive for the suite. Repeated cross-context module
  // creation can crash the Node 22 experimental VM loader during collection.
  return { handler, module };
}

async function createHarness({ configured = true, failedTranslation = false } = {}) {
  const calls = [];
  activeHarness = { configured, failedTranslation, calls };
  const { handler } = await (handlerPromise ||= loadApiHandler());
  return { calls, async post(path, body) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method: 'POST', url: path, headers: { host: '127.0.0.1:4173', 'content-type': 'application/json' } });
    let status, data;
    await handler(request, { writeHead(code) { status = code; }, end(body) { data = JSON.parse(body); } });
    return { status, data };
  } };
}

const originalChinese = '少女手中捏着铜板，满脸愁容。';
const originalDialogue = '少女：“银子好像不够了……”';
const table = ['| 镜号 | 时间 | 画面 | AI Prompt | 台词 / 声效 |', '| --- | --- | --- | --- | --- |',
  ...Array.from({ length: 30 }, (_, i) => `| **Shot ${i + 1}** | 00:00-00:03 | 【俯视】${originalChinese} | *POV from barrel --ar 9:16 --v 6.0* | ${originalDialogue}<br>SFX：钱币轻微碰撞声。${i === 5 ? '<br>商人：“I am not K.”' : ''} |`)].join('\n');
const body = script => ({ script, durationSeconds: 60, taskCount: 6, provider: 'gemini', model: 'test-model' });

for (const path of ['/api/preview', '/api/generate']) {
  test(`${path}：截图中的五列表格转为全中文，30镜、6任务、中文台词和画幅均保留`, async () => {
    const api = await createHarness();
    const result = await api.post(path, body(table));
    assert.equal(result.status, 200, result.data.error);
    const { data } = result;
    assert.equal(data.meta.chineseOnly, true);
    assert.equal(data.meta.translatedToChinese, true);
    assert.equal(data.meta.shotCount, 30);
    assert.equal(data.tasks.length, 6);
    assert.deepEqual(api.calls, ['translation', 'translation', 'translation']);
    const shots = extractMarkdownShots(data.storyboardMarkdown);
    assert.equal(shots.length, 30);
    shots.forEach(shot => {
      assert.ok(shot.visual.includes(originalChinese));
      assert.ok(shot.visual.includes('从木桶内部观察'));
      assert.ok(shot.visual.includes('画幅 9:16'));
      assert.ok(shot.visual.includes('版本 6.0'));
      assert.ok(shot.dialogue.includes(originalDialogue));
      assert.ok(shot.dialogue.includes('音效：钱币轻微碰撞声。'));
    });
    assert.ok(shots[5].dialogue.includes('商人：“我不是凯。”'));
    assert.doesNotMatch(data.title + data.storyboardMarkdown + data.tasks.map(task => task.prompt).join(''), /[a-z]/i);
    data.tasks.forEach((task, i) => assert.equal(task.shotRange, `${i * 5 + 1}-${i * 5 + 5}`));
  });
  test(`${path}：逐步缩小重试范围仍失败时不返回英文结果、不改变原稿`, async () => {
    const api = await createHarness({ failedTranslation: true });
    const request = body(table);
    const result = await api.post(path, request);
    assert.equal(result.status, 400);
    assert.match(result.data.error, /未能翻译为中文/);
    assert.equal(result.data.storyboardMarkdown, undefined);
    assert.equal(request.script, table);
    assert.equal(api.calls.length, 5);
    assert.ok(api.calls.every(call => call === 'translation'));
  });
}

test('新生成镜头在台词回填后也经过全中文校验', async () => {
  const api = await createHarness();
  const result = await api.post('/api/generate', body('少女和橘猫在庭院里数铜板。\n少女：“银子好像不够了……”\n两人一起想办法。'));
  assert.equal(result.status, 200, result.data.error);
  assert.equal(result.data.meta.chineseOnly, true);
  assert.equal(result.data.meta.dialogueLockCount, 1);
  assert.doesNotMatch(result.data.storyboardMarkdown + result.data.tasks.map(task => task.prompt).join(''), /[a-z]/i);
  assert.ok(result.data.storyboardMarkdown.includes(originalDialogue));
  assert.deepEqual(api.calls, ['storyboard', 'translation', 'translation', 'translation']);
});

test('中文原稿无需模型，常见英文标签在本地转中文', async () => {
  const api = await createHarness({ configured: false });
  const result = await api.post('/api/preview', { ...body('| 1 | 【全景】少女和猫咪一起走进庭院，坐下来清点零钱。 | SFX：脚步声。BGM：轻柔音乐。 |'), taskCount: 1 });
  assert.equal(result.status, 200, result.data.error);
  assert.equal(result.data.meta.chineseOnly, true);
  assert.ok(result.data.storyboardMarkdown.includes('音效：脚步声。背景音乐：轻柔音乐。'));
  assert.deepEqual(api.calls, []);
});

test('未配置模型时不能将英文原样作为整理成功的结果', async () => {
  const api = await createHarness({ configured: false });
  const result = await api.post('/api/preview', body(table));
  assert.equal(result.status, 400);
  assert.equal(result.data.storyboardMarkdown, undefined);
  assert.deepEqual(api.calls, []);
});

test('页面拒绝旧服务的英文结果，即使后台错误地声称已全中文', async () => {
  const source = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function assertChineseStoryboard(');
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, source.indexOf('\nfunction ', start + 1)), context);
  for (const chineseOnly of [false, true]) {
    assert.throws(() => context.assertChineseStoryboard({ title: '已有分镜',
      storyboardMarkdown: '| 1 | 少女与橘猫。 POV from barrel | 无 |',
      tasks: [{ prompt: '少女与橘猫。' }], meta: { chineseOnly } }), /尚未全部转为中文/);
  }
  assert.throws(() => context.assertChineseStoryboard({ title: '已有分镜',
    storyboardMarkdown: '| 1 | 少女与橘猫。 | 无 |', tasks: [{ prompt: 'SFX：钱币声。' }],
    meta: { chineseOnly: true } }), /尚未全部转为中文/);
  assert.doesNotThrow(() => context.assertChineseStoryboard({ title: '已有分镜',
    storyboardMarkdown: '| 1 | 少女与橘猫。 | 无 |', tasks: [{ prompt: '音效：钱币声。' }],
    meta: { chineseOnly: true } }));
});
