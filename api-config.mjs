import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const providers = {
  gemini: { key: "GEMINI_API_KEY", model: "GEMINI_MODEL", fallback: "gemini-3.5-flash" },
  openai: { key: "OPENAI_API_KEY", model: "OPENAI_MODEL", fallback: "gpt-5.4" },
  deepseek: { key: "DEEPSEEK_API_KEY", model: "DEEPSEEK_MODEL", fallback: "deepseek-v4-pro" }
};

export function validateSettingsRequest(request) {
  const host = request.headers.host || "";
  let target;
  try { target = new URL(`http://${host}`); } catch { throw new Error("配置接口仅允许本机访问。"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password) {
    throw new Error("配置接口仅允许本机访问。");
  }
  if (request.headers.origin) {
    let origin;
    try { origin = new URL(request.headers.origin); } catch { throw new Error("请在本机平台页面修改配置。"); }
    if (origin.host !== host || !["http:", "https:"].includes(origin.protocol)) throw new Error("请在本机平台页面修改配置。");
  }
  if (request.method === "POST" && !/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
    throw new Error("配置请求需要使用 JSON 格式。");
  }
}

export async function createApiConfigStore(filePath, env = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(filePath, "utf8"));
    if (!saved || Array.isArray(saved) || typeof saved !== "object") throw new Error("invalid");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("API 配置文件无法读取，请检查 data/api-config.json。");
  }
  let pendingSave = Promise.resolve();

  function get(provider) {
    if (!Object.hasOwn(providers, provider)) throw new Error("不支持这个模型服务商。");
    const definition = providers[provider];
    const custom = saved[provider] || {};
    return {
      apiKey: Object.hasOwn(custom, "apiKey") ? custom.apiKey || "" : env[definition.key] || "",
      defaultModel: custom.defaultModel || env[definition.model] || definition.fallback
    };
  }
  function publicStatus() {
    return Object.fromEntries(Object.keys(providers).map((provider) => {
      const { apiKey, defaultModel } = get(provider);
      return [provider, { configured: Boolean(apiKey), defaultModel }];
    }));
  }
  function draft(body) {
    const provider = body?.provider;
    const current = get(provider);
    if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new Error("API Key 格式不正确。");
    if (body.defaultModel !== undefined && typeof body.defaultModel !== "string") throw new Error("模型名称格式不正确。");
    const enteredKey = body.apiKey?.trim() || "";
    if (enteredKey && (!/^[\x21-\x7e]{8,4096}$/.test(enteredKey))) throw new Error("API Key 不能包含空格、换行或中文，且至少需要 8 个字符。");
    const defaultModel = body.defaultModel?.trim() || current.defaultModel;
    if (!/^[a-zA-Z0-9._:-]{2,120}$/.test(defaultModel)) throw new Error("模型名称格式不正确。");
    if (body.removeKey !== undefined && typeof body.removeKey !== "boolean") throw new Error("移除密钥选项格式不正确。");
    if (body.removeKey && enteredKey) throw new Error("移除密钥时，请先清空新填写的 API Key。");
    return { provider, apiKey: body.removeKey ? "" : enteredKey || current.apiKey, defaultModel };
  }
  function save(body) {
    const operation = pendingSave.then(async () => {
      const value = draft(body);
      const next = { ...saved, [value.provider]: { apiKey: value.apiKey, defaultModel: value.defaultModel } };
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, filePath);
      } catch {
        throw new Error("API 配置未能保存，请检查本机数据目录的写入权限。");
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      saved = next;
      return publicStatus();
    });
    pendingSave = operation.catch(() => {});
    return operation;
  }
  return { get, publicStatus, draft, save };
}
