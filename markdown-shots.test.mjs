import test from 'node:test';
import assert from 'node:assert/strict';
import {extractMarkdownShots} from './markdown-shots.mjs';

test('Shot 镜号和五列表格按列名识别，时间不是画面，英文提示词和声音不丢失',()=>{
 const text='| 镜号 | 时间 | 视听画面描述 (Visual & Action) | AI Prompt | 台词 / 声效 / 音乐 (Audio Cue) |\n| :--- | :--- | :--- | :--- | :--- |\n| **Shot 1** | 00:00-00:03 | **【俯视】**<br>少女与橘猫查看铜板。 | *POV from barrel --ar 9:16* | **台词**<br>橘猫：“有钱吗？”<br>少女：“不够了。”<br>**SFX**：钱币碰撞。 |';
 const [shot]=extractMarkdownShots(text);
 assert.equal(shot.number,1);assert.match(shot.visual,/【俯视】\n少女/);assert.match(shot.visual,/POV from barrel --ar 9:16/);
 assert.doesNotMatch(shot.visual,/00:00/);assert.match(shot.dialogue,/橘猫：“有钱吗？”\n少女：“不够了。”/);assert.match(shot.dialogue,/SFX：钱币碰撞/);
});
test('纯数字三列表格保持兼容，中文镜头编号也识别',()=>{
 const shots=extractMarkdownShots('| 镜号 | 画面提示词 | 配音台词 |\n|---|---|---|\n| **1** | 【全景】少女走进院子。 | 少女：你好。 |\n| 镜头 2 | 【近景】猫咪抬头。 | 无 |');
 assert.deepEqual(shots.map(s=>s.number),[1,2]);assert.equal(shots[0].dialogue,'少女：你好。');
});
test('前面的英文镜头盘点不会被误识别为分镜表格',()=>{
 assert.equal(extractMarkdownShots('* **Shot 1**：少女走路。\n* **Shot 2**：猫咪抬头。').length,0);
});
test('转义竖线保留在单元格中',()=>{
 assert.equal(extractMarkdownShots('| 1 | 【全景】A \\| B | 无 |')[0].visual,'【全景】A ｜ B');
});
