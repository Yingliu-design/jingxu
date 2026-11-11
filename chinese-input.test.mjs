import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { translateInput, translateStoryboardToChinese } from "./chinese-input.mjs";
import { restoreOriginalDialogues } from "./dialogue-placement.mjs";

test("章节标题不作为台词锁定", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function containsDisallowedEnglish");
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, source.indexOf("function sanitizeSourceLine", start)), context);
  const dialogues = context.extractLockedDialogues("第二幕：即梦视频 2.0 完整视听改编分镜脚本\n布丁：我饿了！");
  assert.equal(dialogues.length, 1);
  assert.equal(dialogues[0].rendered, "布丁：我饿了！");
});

test("固定角色名也转中文，不需要调用模型", async () => {
  const source = "布丁：你好，Coco！\n\n画面：猫咪吃饭。";
  assert.equal(await translateInput(source, () => assert.fail("不应请求模型")), source.replace('Coco', '可可'));
});

test("常见技术术语本地转换，不消耗接口额度", async () => {
  assert.equal(await translateInput("Seedance 2.0｜4K｜Vlog｜Master Continuous Shot｜Coco", () => assert.fail("不应请求模型")),
    "即梦视频 2.0｜超高清｜生活记录｜连续长镜头｜可可");
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
    assert.deepEqual(pending.map(p => p.id), [0]);
    assert.deepEqual(pending.map(p => p.text), ['Good morning']);
    return { lines: [{ id: 0, text: "早上好" }] };
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

test("分镜翻译重试仍不合格时不把英文原样返回为成功结果", async () => {
  const source = '| 1 | 【特写】主人拿起 RTX 显卡，旁边是 SFX 提示。 | 主人：Hello！ |';
  await assert.rejects(translateInput(source, async () => ({ lines: [] })), /未能翻译为中文/);
  assert.ok(source.includes('RTX'));
});

test("翻译服务不可用时保留原稿并报错，不反复消耗请求", async () => {
  const source = Array.from({length: 50}, (_, i) => `| ${i+1} | 【全景】原文 Hello. | 无 |`).join('\n');
  let calls = 0;
  await assert.rejects(translateInput(source, async () => { calls++; throw new Error('额度不足'); }), /额度不足/);
  assert.equal(calls, 1);
});

test("部分翻译成功仍不能输出混有英文的结果", async () => {
  await assert.rejects(translateInput('主人：Hello！猫：Good morning！', async prompt => ({lines:JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1)).map(item=>({id:item.id,text:item.text==='Hello'?'你好':item.text}))})), /未能翻译为中文/);
});

test('真实原稿里的角色代号K在本地译为凯，不因单个代号反复消耗请求', async () => {
  assert.equal(await translateInput('商人：“你认错人了，我不是K。”', () => assert.fail('代号不应请求模型')),
    '商人：“你认错人了，我不是凯。”');
});

test('英文提示词按完整语义片段翻译，逗号不再拆成大量孤立短语', async () => {
  const text = '画面：A cute girl, warm lighting, detailed fur. 台词：少女：“走吧。”';
  let calls = 0;
  const result = await translateInput(text, async prompt => {
    calls++;
    const pending=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
    assert.equal(pending.length,1);
    assert.equal(pending[0].text,'A cute girl, warm lighting, detailed fur.');
    return {lines:[{id:'0',text:'可爱的少女，温暖的光照，细致的毛发。'}]};
  });
  assert.equal(calls,1);
  assert.equal(result,'画面：可爱的少女，温暖的光照，细致的毛发。 台词：少女：“走吧。”');
});

test('两轮批量翻译遗漏同一项后，自动单独补译且不重译已成功内容', async () => {
  let calls=0;
  const result=await translateInput('画面：A cat.\n配音：Hello！',async prompt=>{
    calls++;
    const pending=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
    if(calls===1)return {lines:[{id:0,text:'一只猫。'}]};
    assert.deepEqual(pending.map(item=>item.text),['Hello']);
    if(calls===2)return {lines:[]};
    assert.match(prompt,/此次只有一项/);
    return {lines:[{id:0,text:'你好'}]};
  });
  assert.equal(result,'画面：一只猫。\n配音：你好！');
  assert.equal(calls,3);
});

test('模型返回无法解析的数据时重试，额度或网络错误仍直接说明', async () => {
  let calls=0;
  assert.equal(await translateInput('Hello！',async()=>{
    if(++calls===1)throw new SyntaxError('无效结构');
    return {lines:[{id:0,text:'你好'}]};
  }),'你好！');
  assert.equal(calls,2);
});

test('真实模型返回“OC渲染”时直接规范成中文，不再反复请求同一模型', async () => {
  let calls=0;
  const result=await translateInput('提示词：An orange cat, rendering.\n台词：少女：“走吧。”',async prompt=>{
    calls++;
    const pending=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
    assert.equal(pending.length,1);
    return {lines:[{id:0,text:calls===1?'一只橘猫，OC渲染。':'一只橘猫，奥克坦渲染。'}]};
  });
  assert.equal(calls,1);
  assert.equal(result,'提示词：一只橘猫，奥克坦渲染。\n台词：少女：“走吧。”');
});

test('原文和译文中的标准渲染术语都在本地转中文，允许缩写与汉字间有空格', async () => {
  assert.equal(await translateInput('Octane render｜OC 渲染',()=>assert.fail('不应请求模型')),'奥克坦渲染｜奥克坦渲染');
});

test('真实接口返回半截译文时自动拆小，不重复请求同一大段也不拼接残缺结果', async () => {
  const counts=[];
  const result=await translateInput('画面：A cat.\n台词：Hello！',async prompt=>{
    const pending=JSON.parse(prompt.split('\n').at(-1));
    counts.push(pending.length);
    if(pending.length>1)throw new SyntaxError('半截译文');
    return {lines:[{id:0,text:pending[0].text==='Hello'?'你好':'一只猫。'}]};
  });
  assert.deepEqual(counts,[2,1,1]);
  assert.equal(result,'画面：一只猫。\n台词：你好！');
});

test('译文不能注入控制字符改变标题、画面与台词的字段边界', async () => {
  const source = { title: '演示', shots: [{ number: 1, visual: '【特写】猫咪说 Hello。', dialogue: '无' }] };
  await assert.rejects(translateStoryboardToChinese(source, async () => ({ lines: [{ id: 0, text: '你好\u001e错误字段' }] })), /未能翻译为中文/);
  assert.equal(source.shots[0].visual, '【特写】猫咪说 Hello。');
});

test("生成草稿先保留原文台词，最后统一翻译；数量仍校验", () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function normalizeStoryboard(');
  const context = vm.createContext({ restoreOriginalDialogues, cleanMarkdown: value => String(value).trim(),
    containsDisallowedEnglish: value => /[a-z]/i.test(value) });
  vm.runInContext(source.slice(start, source.indexOf('\nfunction ', start + 1)), context);
  const data = {title:'演示',shots:[{visual:'【特写】主人拿起 RTX 显卡，仔细展示外观。',dialogue:'D1'}]};
  const locks = [{id:'D1',rendered:'主人：Hello！'}];
  const result = context.normalizeStoryboard(data, 1, locks);
  assert.ok(result);
  assert.equal(result.shots[0].dialogue, '主人：Hello！');
  assert.equal(result.chineseOnly, false);
  assert.equal(context.normalizeStoryboard(data, 2, locks), null);
  const repaired = context.normalizeStoryboard({...data,shots:[{...data.shots[0],dialogue:'D2'}]},1,locks);
  assert.equal(repaired.shots[0].dialogue, '主人：Hello！');
  assert.equal(repaired.dialoguePlacementNeedsReview,true);
});

test('不同台词格式按原文位置排序，同一句重复出现不被删掉', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function containsDisallowedEnglish');
  const context = vm.createContext({});
  vm.runInContext(source.slice(start,source.indexOf('function sanitizeSourceLine',start)),context);
  const lines = context.extractLockedDialogues('主人：“第一句。”\n台词（布丁）： “第二句。”\n主人：第三句。\n主人：“第一句。”');
  assert.equal(lines.length,4);
  assert.equal(lines.map(l=>l.rendered).join('\n'),'主人：“第一句。”\n布丁：“第二句。”\n主人：第三句。\n主人：“第一句。”');
  assert.equal(lines.map(l=>l.id).join(','),'D1,D2,D3,D4');
});

test("无损整理不得删除尚未翻译的英文术语", () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function sanitizeSourceLine(');
  const context = vm.createContext({cleanMarkdown: value => String(value)});
  vm.runInContext(source.slice(start, source.indexOf('\nfunction ', start + 1)), context);
  assert.equal(context.sanitizeSourceLine('原文 RTX 显卡与 Bokeh 效果'), '原文 RTX 显卡与 Bokeh 效果');
});
