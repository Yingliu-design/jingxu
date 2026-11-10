import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { translateInput } from "./chinese-input.mjs";

test("章节标题不作为台词锁定", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function containsDisallowedEnglish");
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, source.indexOf("function sanitizeSourceLine", start)), context);
  const dialogues = context.extractLockedDialogues("第二幕：即梦视频 2.0 完整视听改编分镜脚本\n布丁：我饿了！");
  assert.equal(dialogues.length, 1);
  assert.equal(dialogues[0].rendered, "布丁：我饿了！");
});

test("中文和固定角色名无需调用模型", async () => {
  const source = "布丁：你好，Coco！\n\n画面：猫咪吃饭。";
  assert.equal(await translateInput(source, () => assert.fail("不应请求模型")), source);
});

test("常见技术术语本地转换，不消耗接口额度", async () => {
  assert.equal(await translateInput("Seedance 2.0｜4K｜Vlog｜Master Continuous Shot｜Coco", () => assert.fail("不应请求模型")),
    "即梦视频 2.0｜超高清｜生活记录｜连续长镜头｜Coco");
});

test("只替换英文片段，中文、镜号、时间码和表格逐字保留", async () => {
  const source = '第二幕：Seedance 2.0 完整视听改编分镜脚本\n中文原文。\n\n| **1** | 00:01—00:03 A cat eats fish. | 布丁："I am hungry." |';
  const result = await translateInput(source, async () => ({ lines: [
    { id: 1, text: "我饿了。" }, { id: 0, text: "一只猫吃鱼。" }
  ] }));
  assert.equal(result, '第二幕：即梦视频 2.0 完整视听改编分镜脚本\n中文原文。\n\n| **1** | 00:01—00:03 一只猫吃鱼。 | 布丁："我饿了。" |');
});

test("遗漏、重复编号、英文残留和表格注入均重试", async () => {
  for (const lines of [[], [{ id: 1, text: "猫" }], [{ id: 0, text: "Cat" }], [{ id: 0, text: "| 猫 |" }], [{ id: 0, text: "猫" }, { id: 0, text: "猫" }]]) {
    let calls = 0;
    assert.equal(await translateInput("| Cat |", async () => (++calls === 1 ? { lines } : { lines: [{ id: 0, text: "猫" }] })), "| 猫 |");
    assert.equal(calls, 2);
  }
});

test("重试只请求失败片段，保留已成功的翻译", async () => {
  let calls = 0;
  const result = await translateInput("主人：Hello！\n布丁：Good morning！", async prompt => {
    calls++;
    if (calls === 1) return { lines: [{ id: 0, text: "你好" }, { id: 1, text: "Good morning" }] };
    const pending = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assert.deepEqual(pending.map(p => p.id), [1]);
    return { lines: [{ id: 1, text: "早上好" }] };
  });
  assert.equal(result, "主人：你好！\n布丁：早上好！");
  assert.equal(calls, 2);
});

test("长文本分批处理，不遗漏片段或改变顺序", async () => {
  let calls = 0;
  const source = Array.from({length: 50}, (_, i) => `| ${i + 1} | A cat. | 中文${i} |`).join("\n");
  const result = await translateInput(source, async prompt => {
    calls++;
    const pending = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assert.ok(pending.length <= 24);
    return { lines: pending.map(p => ({id: p.id, text: "一只猫。"})) };
  });
  assert.equal(calls, 3);
  assert.equal(result, source.replaceAll("A cat.", "一只猫。"));
});

test("校验失败不返回部分翻译，不覆盖用户原稿", async () => {
  const source = "主人：Hello！";
  await assert.rejects(translateInput(source, async () => ({ lines: [{ id: 0, text: "Hello" }] })), /没有改动原始内容/);
  assert.equal(source, "主人：Hello！");
});

test("生成模式下翻译两次不合格也保留原文，不阻断生成", async () => {
  const source = '| 1 | 【特写】主人拿起 RTX 显卡，旁边是 SFX 提示。 | 主人：Hello！ |';
  let warning;
  const result = await translateInput(source, async () => ({ lines: [] }), {
    strict: false, onWarning: value => { warning = value; }
  });
  assert.equal(result, source);
  assert.equal(warning.unresolvedCount, 3);
});

test("翻译服务不可用时已有分镜仍可按原文整理，不重复消耗请求", async () => {
  const source = Array.from({length: 50}, (_, i) => `| ${i+1} | 【全景】原文 Hello. | 无 |`).join('\n');
  let calls = 0;
  let warning;
  const result = await translateInput(source, async () => { calls++; throw new Error('quota'); }, {
    strict: false, onWarning: value => { warning = value; }
  });
  assert.equal(result, source);
  assert.equal(calls, 1);
  assert.equal(warning.translationUnavailable, true);
});

test("部分翻译成功时只保留失败片段的原文", async () => {
  const result = await translateInput('主人：Hello！猫：Good morning！', async () => ({lines:[{id:0,text:'你好'},{id:1,text:'Good morning'}]}), {strict:false});
  assert.equal(result, '主人：你好！猫：Good morning！');
});

test("未翻译的英文台词或术语不再使有效分镜被判失败，顺序和数量仍校验", () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function normalizeStoryboard(');
  const context = vm.createContext({ cleanMarkdown: value => String(value).trim(),
    containsDisallowedEnglish: value => /[a-z]/i.test(value) });
  vm.runInContext(source.slice(start, source.indexOf('\nfunction ', start + 1)), context);
  const data = {title:'演示',shots:[{visual:'【特写】主人拿起 RTX 显卡，仔细展示外观。',dialogue:'D1'}]};
  const locks = [{id:'D1',rendered:'主人：Hello！'}];
  const result = context.normalizeStoryboard(data, 1, locks);
  assert.ok(result);
  assert.equal(result.shots[0].dialogue, '主人：Hello！');
  assert.equal(result.chineseOnly, false);
  assert.equal(context.normalizeStoryboard(data, 2, locks), null);
  assert.equal(context.normalizeStoryboard({...data,shots:[{...data.shots[0],dialogue:'D2'}]},1,locks),null);
});

test("无损整理不得删除尚未翻译的英文术语", () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function sanitizeSourceLine(');
  const context = vm.createContext({cleanMarkdown: value => String(value)});
  vm.runInContext(source.slice(start, source.indexOf('\nfunction ', start + 1)), context);
  assert.equal(context.sanitizeSourceLine('原文 RTX 显卡与 Bokeh 效果'), '原文 RTX 显卡与 Bokeh 效果');
});
