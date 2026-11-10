import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiConfigStore, validateSettingsRequest } from "./api-config.mjs";

test("配置即时更新、重启后保留，空白密钥保留原值，状态不泄露密钥", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jingxu-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "api-config.json");
  const env = { GEMINI_API_KEY: "environment-secret", GEMINI_MODEL: "gemini-test" };
  const store = await createApiConfigStore(path, env);
  assert.equal(store.get("gemini").apiKey, "environment-secret");
  const status = await store.save({ provider: "openai", apiKey: "sk-local-test-key", defaultModel: "gpt-test" });
  assert.equal(store.get("openai").apiKey, "sk-local-test-key");
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.equal(JSON.stringify(status).includes("sk-local-test-key"), false);
  await store.save({ provider: "openai", apiKey: "", defaultModel: "gpt-updated" });
  const restored = await createApiConfigStore(path, env);
  assert.deepEqual(restored.get("openai"), { apiKey: "sk-local-test-key", defaultModel: "gpt-updated" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.save({ provider: "gemini", removeKey: true });
  assert.equal(store.publicStatus().gemini.configured, false);
  assert.equal(env.GEMINI_API_KEY, "environment-secret");
  assert.equal((await createApiConfigStore(path, env)).get("gemini").apiKey, "");
});

test("多个服务商顺序保存不丢失配置，非法输入不会写入", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jingxu-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "api-config.json");
  const store = await createApiConfigStore(path, {});
  await Promise.all([
    store.save({ provider: "openai", apiKey: "openai-test-key" }),
    store.save({ provider: "deepseek", apiKey: "deepseek-test-key" })
  ]);
  assert.equal(store.publicStatus().openai.configured, true);
  assert.equal(store.publicStatus().deepseek.configured, true);
  const before = await readFile(path, "utf8");
  await assert.rejects(store.save({ provider: "__proto__" }), /不支持/);
  await assert.rejects(store.save({ provider: "openai", apiKey: "key\nheader" }), /API Key/);
  await assert.rejects(store.save({ provider: "openai", defaultModel: "bad/model" }), /模型名称/);
  assert.equal(await readFile(path, "utf8"), before);
});

test("本机同源配置请求通过，跨站写入和 DNS 重绑定请求被拒绝", () => {
  const headers = { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173", "content-type": "application/json" };
  assert.doesNotThrow(() => validateSettingsRequest({ method: "POST", headers }));
  assert.throws(() => validateSettingsRequest({ method: "POST", headers: { ...headers, origin: "https://other.example" } }), /本机平台/);
  assert.throws(() => validateSettingsRequest({ method: "POST", headers: { ...headers, host: "other.example:4173" } }), /本机访问/);
  assert.throws(() => validateSettingsRequest({ method: "POST", headers: { ...headers, "content-type": "text/plain" } }), /JSON/);
});
