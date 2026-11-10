import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreOriginalDialogues } from './dialogue-placement.mjs';
const locked = ['你好！','铜锣换钱。','我舍不得。','我们去表演！'].map((text,i) => ({id:`D${i+1}`,rendered:`主人：“${text}”`}));
const makeShots = () => Array.from({length:30},(_,i)=>({number:i+1,visual:'【全景】主人和猫咪走过广场，在树下坐下。',dialogue:'无'}));
const flatten = result => result.shots.filter(s=>s.dialogue!=='无').flatMap(s=>s.dialogue.split('\n'));
test('正确编号沿用模型安排，原台词逐字回填',()=>{
 const shots=makeShots();[1,8,16,27].forEach((p,i)=>shots[p].dialogue=`D${i+1}`);
 const result=restoreOriginalDialogues(shots,locked);
 assert.equal(result.repaired,false);assert.deepEqual(flatten(result),locked.map(l=>l.rendered));
 assert.equal(result.shots[8].dialogue,locked[1].rendered);
});
test('缺号、重复、错序、未知号和模型改写不再导致整单丢弃',()=>{
 for(const refs of [['D1','D3'],['D1','D1','D2','D4'],['D4','D3','D2','D1'],['D99'],['被模型改写的台词'],[]]){
  const shots=makeShots();refs.forEach((r,i)=>shots[i*5].dialogue=r);
  const result=restoreOriginalDialogues(shots,locked);
  assert.equal(result.repaired,true);assert.equal(result.shots.length,30);
  assert.deepEqual(flatten(result),locked.map(l=>l.rendered));
 }
});
test('保留原文在不同位置重复出现的相同台词',()=>{
 const lines=[{id:'D1',rendered:'主人：你好。'},{id:'D2',rendered:'主人：你好。'}];
 assert.deepEqual(flatten(restoreOriginalDialogues(makeShots(),lines)),lines.map(l=>l.rendered));
});
test('有上下文时优先匹配相应画面，不能假称自动修复已经审核',()=>{
 const shots=makeShots();shots[20].visual='【特写】少女在广场敲打铜锣，开始舞台表演。';
 const result=restoreOriginalDialogues(shots,[{id:'D1',rendered:'少女：开始表演！',context:'少女在广场敲打铜锣，开始舞台表演。'}]);
 assert.equal(result.repaired,true);assert.equal(result.shots[20].dialogue,'少女：开始表演！');
});
