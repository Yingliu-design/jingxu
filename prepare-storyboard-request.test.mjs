import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStoryboardRequest, rememberChineseStoryboard, parseTranslationResponse } from './public/prepare-storyboard-request.js';
import { extractMarkdownShots } from './markdown-shots.mjs';

test('提交前按列翻译，原输入不被替换，旧服务只会收到全中文三列表格', async () => {
  const original = '| 镜号 | 时间 | 画面 | AI Prompt | 台词 / 声效 |\n|---|---|---|---|---|\n| Shot 1 | 00:00-00:03 | 【俯视】少女捏着铜板。 | POV from barrel --ar 9:16 | 商人：“我不是K。”<br>SFX：铜板声。 |';
  let calls=0;
  const result=await prepareStoryboardRequest(original,async prompt=>{
    calls++;
    const pending=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
    assert.deepEqual(pending.map(item=>item.text),['from barrel']);
    return {lines:[{id:0,text:'从木桶内部观察'}]};
  });
  assert.equal(calls,1);
  assert.equal(result.translated,true);
  assert.match(original,/POV from barrel/);
  assert.doesNotMatch(result.script,/[a-z]/i);
  const [shot]=extractMarkdownShots(result.script);
  assert.equal(shot.number,1);
  assert.match(shot.visual,/少女捏着铜板/);
  assert.match(shot.visual,/画幅 9:16/);
  assert.match(shot.dialogue,/我不是凯/);
  assert.match(shot.dialogue,/音效：铜板声/);
});

test('中文表格和故事在提交前无需调用模型', async () => {
  const deny=()=>assert.fail('不应请求模型');
  const story='少女和猫咪在庭院里清点硬币，随后一起走进古镇街道。';
  assert.deepEqual(await prepareStoryboardRequest(story,deny),{script:story,translated:false});
  const table='| 1 | 【全景】少女走进庭院。 | 少女：“你好。” |';
  const result=await prepareStoryboardRequest(table,deny);
  assert.equal(result.translated,false);
  assert.match(result.script,/少女：“你好。”/);
});

test('服务返回代码块可读取，非结构化或损坏的译文必须重试', () => {
  assert.deepEqual(parseTranslationResponse('```json\n{"lines":[{"id":0,"text":"猫咪"}]}\n```'),{lines:[{id:0,text:'猫咪'}]});
  assert.throws(()=>parseTranslationResponse('分析结果：一只猫。'),SyntaxError);
  assert.throws(()=>parseTranslationResponse('{"text":"猫咪"}'),SyntaxError);
});

test('已成功的同一份原稿复用中文结果，刷新后可从保存结果恢复缓存', async () => {
  const original='| Shot 1 | 【特写】猫咪走路。 A cat walks. | 少女：“走吧。” |';
  const chinese='| 1 | 【特写】猫咪走路。 一只猫走路。 | 少女：“走吧。” |';
  rememberChineseStoryboard(original,chinese);
  assert.deepEqual(await prepareStoryboardRequest(original,()=>assert.fail('同稿不应重复请求模型')),
    {script:chinese,translated:true});
  const changed=original.replace('走路','跑步');
  let calls=0;
  await prepareStoryboardRequest(changed,async()=>{calls++;return {lines:[{id:0,text:'一只猫走路。'}]};});
  assert.equal(calls,1);
});

test('英文残留、缺镜和镜号错位的结果不能进入成功缓存', async () => {
  for(const chinese of ['| 1 | 【全景】An English result. | 无 |','| 2 | 【全景】猫咪走路。 | 无 |','无效结果']){
    const original='| 1 | 【全景】猫咪看向门外。 A cat looks. | 无 |';
    rememberChineseStoryboard(original,chinese);
    await assert.rejects(prepareStoryboardRequest(original,()=>{throw new Error('确实仍需要翻译');}),/确实仍需要翻译/);
  }
});
