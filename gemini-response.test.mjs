import test from "node:test";
import assert from "node:assert/strict";
import { mergeGeminiResponse } from "./gemini-response.mjs";

test("流式中文及 JSON 片段完整合并，思考内容不混入脚本", () => {
  const result = mergeGeminiResponse([
    { candidates: [{ index: 0, content: { parts: [{ thought: true, text: "思考" }, { text: '{"台词":"你' }] } }] },
    { candidates: [{ index: 0, content: { parts: [{ text: '好"}' }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 9 } }
  ]);
  assert.deepEqual(JSON.parse(result.candidates[0].content.parts.map(p => p.text).join("")), { 台词: "你好" });
  assert.equal(result.candidates[0].finishReason, "STOP");
  assert.equal(result.usageMetadata.totalTokenCount, 9);
});

test("流式限流或中途错误不能当作成功的部分结果", () => {
  const error = { code: 429, message: "quota", details: [{ reason: "quota" }] };
  assert.deepEqual(mergeGeminiResponse([{ candidates: [{ content: { parts: [{ text: "部分" }] } }] }, { error }]), { error });
  assert.deepEqual(mergeGeminiResponse({ error }), { error });
});

test("候选结果分别合并，非流式响应兼容", () => {
  const payload = { candidates: [{ content: { parts: [{ text: "正常" }] } }] };
  assert.equal(mergeGeminiResponse(payload), payload);
  const result = mergeGeminiResponse([{ candidates: [{ index: 0, content: { parts: [{ text: "甲" }] } }, { index: 1, content: { parts: [{ text: "乙" }] } }] }]);
  assert.equal(result.candidates.length, 2);
});
