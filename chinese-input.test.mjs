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

test("翻译英文标题、画面和台词，同时保留中文行和表格", async () => {
  const source = '第二幕：Seedance 2.0 完整视听改编分镜脚本\n中文原文。\n\n| 1 | A cat eats fish. | 布丁："I am hungry." |';
  const expected = '第二幕：即梦视频 2.0 完整视听改编分镜脚本\n中文原文。\n\n| 1 | 一只猫吃鱼。 | 布丁："我饿了。" |';
  assert.equal(await translateInput(source, async () => ({ lines: [
    { id: 3, text: expected.split("\n")[3] }, { id: 0, text: expected.split("\n")[0] }
  ] })), expected);
});

test("遗漏、重复行号、英文残留或表格损坏时重试", async () => {
  for (const lines of [[], [{ id: 1, text: "猫" }], [{ id: 0, text: "| Cat |" }], [{ id: 0, text: "猫" }], [{ id: 0, text: "| 猫 |" }, { id: 0, text: "| 猫 |" }]]) {
    let calls = 0;
    assert.equal(await translateInput("| Cat |", async () => (++calls === 1 ? { lines } : { lines: [{ id: 0, text: "| 猫 |" }] })), "| 猫 |");
    assert.equal(calls, 2);
  }
});

test("不返回破坏原中文的译文", async () => {
  await assert.rejects(translateInput("布丁：Hello", async () => ({ lines: [{ id: 0, text: "女主人：你好" }] })), /自动中文翻译/);
});
