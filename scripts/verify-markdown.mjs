// Verify already-Chinese tables without model calls. Bilingual API regression
// coverage (including translation and failures) lives in api-generation.test.mjs.
// Usage: node --experimental-vm-modules scripts/verify-markdown.mjs < original.txt
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {extractMarkdownShots} from '../markdown-shots.mjs';
import {needsTranslation} from '../chinese-input.mjs';
const original = await new Promise(resolve=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));});
const shots=extractMarkdownShots(original);
assert.ok(shots.length>0,'原稿未被识别为表格');
assert.ok(shots.every(shot=>!needsTranslation(shot.visual+' '+shot.dialogue)), '此工具仅验证纯中文原稿；中英表格请运行 npm test 中的全中文接口测试。');
const serverUrl=new URL('../server.mjs',import.meta.url);
const require=createRequire(serverUrl);
let handler, aiCalls=0;
const denyNetwork=()=>{aiCalls++;throw new Error('验收禁止调用模型和网络');};
const context=vm.createContext({process,console:{log(){},error(){}},Buffer,URL,AbortSignal,TextDecoder,fetch:denyNetwork,setTimeout,clearTimeout});
const module=new vm.SourceTextModule(await readFile(serverUrl,'utf8'),{context,initializeImportMeta(meta){meta.url=serverUrl.href;}});
await module.link(async spec=>{
 const ns=await import(spec.startsWith('.')?new URL(spec,serverUrl).href:spec==='undici'?require.resolve(spec):spec);
 const exports={...ns};
 if(spec==='node:http') exports.createServer=fn=>{handler=fn;return {listen(){}};};
 if(spec==='undici') exports.fetch=denyNetwork;
 return new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
});
await module.evaluate();
const normalized=s=>s.replace(/\*\*/g,'').replace(/\s+/g,' ').trim().replace(/\|/g,'｜');
const results=[];
for(const path of ['/api/generate','/api/preview']){
 const start=Date.now();
 const request=Readable.from([Buffer.from(JSON.stringify({script:original,durationSeconds:60,taskCount:2,provider:'unconfigured',model:'not-a-model'}))]);
 request.url=path;request.method='POST';request.headers={host:'127.0.0.1:4173','content-type':'application/json'};
 let status,payload;
 await handler(request,{writeHead(code){status=code;},end(body){payload=JSON.parse(body);}});
 assert.equal(status,200,payload?.error);
 assert.equal(payload.meta.shotCount,shots.length);
 assert.equal(payload.tasks.length,2);
 const output=payload.storyboardMarkdown;
 const outputShots=extractMarkdownShots(output);
 assert.equal(outputShots.length,shots.length);
 assert.equal(payload.tasks.map(t=>t.shotRange).join(','),'1-15,16-30');
 let cursor=-1;
 for(const [i,shot] of shots.entries()){
  const visual=normalized(shot.visual), dialogue=normalized(shot.dialogue);
  assert.equal(outputShots[i].visual,visual,`镜头${shot.number}画面错位`);
  assert.equal(outputShots[i].dialogue,dialogue,`镜头${shot.number}台词错位`);
  const task=payload.tasks[i<15?0:1];
  assert.ok(task.prompt.includes(visual),`镜头${shot.number}任务缺少画面或提示词`);
  assert.ok(task.prompt.includes(dialogue),`镜头${shot.number}任务缺少台词或音效`);
  const index=output.indexOf(visual,cursor+1);assert.ok(index>cursor,`镜头${shot.number}画面丢失或顺序错误`);cursor=index;
  assert.ok(output.includes(dialogue),`镜头${shot.number}音频内容不完整`);
 }
 assert.equal(payload.meta.provider,null);
 results.push({path,status,shots:shots.length,tasks:payload.tasks.length,allVisualsAndPromptsPreserved:true,allAudioPreserved:true,originalOrder:true,elapsedMs:Date.now()-start});
}
assert.equal(aiCalls,0);
console.log(JSON.stringify({inputBytes:Buffer.byteLength(original),sha256:createHash('sha256').update(original).digest('hex'),aiCalls,results},null,2));
