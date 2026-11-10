import test from "node:test";
import assert from "node:assert/strict";
import { buildStoryboardPrompt } from "./storyboard-prompt.mjs";

const input = {
  script: "少女和会说话的橘猫积蓄不足，橘猫将铜锣卖给废品回收员，换得冰糖葫芦和理发钱。",
  durationSeconds: 60, totalShots: 30, taskCount: 2, averageShotSeconds: 2, globalRequirements: ""
};

test("分镜整理忠实于当前输入，不注入固定猫咪角色或其他故事设定", () => {
  const prompt = buildStoryboardPrompt(input);
  assert.ok(prompt.includes(input.script));
  assert.doesNotMatch(prompt, /布丁|Coco|金渐层|蓝白长毛|9:16/);
  assert.match(prompt, /角色与外貌仅从当前原文提取/);
  assert.match(prompt, /不得把角色统一替换/);
});

test("保留用户明确指定的角色、画幅和锁定台词", () => {
  const custom = { ...input, script: "主人与布丁在客厅聊天，Coco坐在旁边。", globalRequirements: "横屏16:9，沿用原始角色。" };
  const dialogue = { id: "D1", rendered: "布丁：“铜锣卖掉了。”" };
  const prompt = buildStoryboardPrompt(custom, "", [dialogue]);
  assert.ok(prompt.includes(custom.script));
  assert.ok(prompt.includes(custom.globalRequirements));
  assert.ok(prompt.includes(`D1 = ${dialogue.rendered}`));
  assert.match(prompt, /不能填写、改写、翻译、缩短、扩写任何台词文字/);
  assert.doesNotMatch(prompt, /布丁固定为|固定主角/);
});
