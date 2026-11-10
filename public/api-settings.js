export function initApiSettings({ getProvider, onSaved }) {
  const dialog = document.querySelector("#api-settings-dialog");
  const form = document.querySelector("#api-settings-form");
  const fields = document.querySelector("#api-settings-fields");
  const provider = document.querySelector("#api-settings-provider");
  const key = document.querySelector("#api-settings-key");
  const model = document.querySelector("#api-settings-model");
  const keyState = document.querySelector("#api-key-state");
  const removeKey = document.querySelector("#api-remove-key");
  const removeLabel = document.querySelector("#api-remove-key-label");
  const toggle = document.querySelector("#api-key-toggle");
  const message = document.querySelector("#api-settings-message");
  const save = document.querySelector("#api-settings-save");
  const test = document.querySelector("#api-settings-test");
  let statuses = {};
  let busy = false;

  function notify(text, error = false) {
    message.textContent = text;
    message.dataset.error = String(error);
    message.hidden = !text;
  }
  function clearKey() {
    key.value = "";
    key.type = "password";
    toggle.textContent = "显示";
    toggle.setAttribute("aria-label", "显示 API Key");
    toggle.setAttribute("aria-pressed", "false");
    removeKey.checked = false;
    key.disabled = false;
  }
  function showProvider() {
    clearKey();
    const status = statuses[provider.value] || {};
    model.value = status.defaultModel || "";
    keyState.textContent = status.configured ? "已配置" : "未配置";
    key.placeholder = status.configured ? "已配置，留空保留" : "填写 API Key";
    removeLabel.hidden = !status.configured;
    notify("");
  }
  async function request(path, body) {
    const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    let data;
    try { data = await response.json(); } catch { throw new Error("API 设置接口未就绪，请重启本机服务后重试。"); }
    if (!response.ok) throw new Error(data.error || "操作失败，请重试。");
    return data;
  }
  function body() { return { provider: provider.value, apiKey: key.value, defaultModel: model.value, removeKey: removeKey.checked }; }
  function setBusy(value) {
    busy = value;
    fields.disabled = value;
    document.querySelector("#api-settings-close").disabled = value;
  }
  document.querySelectorAll("[data-api-settings]").forEach((button) => button.addEventListener("click", async () => {
    if (dialog.open) return;
    provider.value = getProvider(button.dataset.apiSettings);
    dialog.showModal();
    clearKey();
    setBusy(true);
    notify("正在读取配置…");
    try {
      statuses = (await request("/api/settings")).providers;
      showProvider();
      setBusy(false);
      (statuses[provider.value]?.configured ? model : key).focus();
    } catch (error) {
      notify(error.message, true);
      fields.disabled = true;
      busy = false;
      document.querySelector("#api-settings-close").disabled = false;
    }
  }));
  provider.addEventListener("change", showProvider);
  toggle.addEventListener("click", () => {
    const visible = key.type === "password";
    key.type = visible ? "text" : "password";
    toggle.textContent = visible ? "隐藏" : "显示";
    toggle.setAttribute("aria-label", visible ? "隐藏 API Key" : "显示 API Key");
    toggle.setAttribute("aria-pressed", String(visible));
  });
  removeKey.addEventListener("change", () => { key.value = ""; key.disabled = removeKey.checked; notify(""); });
  document.querySelector("#api-settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { clearKey(); notify(""); });
  test.addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    const draft = body();
    if (draft.removeKey) return notify("请取消“移除密钥”后检查连接。", true);
    setBusy(true);
    test.textContent = "正在连接…";
    notify("");
    try {
      const result = await request("/api/settings/test", draft);
      notify(`连接成功，读取到 ${result.modelCount} 个文本模型。`);
    } catch (error) { notify(error.message, true); }
    finally { setBusy(false); test.textContent = "检查连接"; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const draft = body();
    if (!draft.removeKey && !draft.apiKey.trim() && !statuses[draft.provider]?.configured) return notify("请先填写 API Key。", true);
    setBusy(true);
    save.textContent = "正在保存…";
    notify("");
    try {
      statuses = (await request("/api/settings", draft)).providers;
      showProvider();
      notify(draft.removeKey ? "密钥已移除。" : "配置已保存，立即生效。");
      // Refresh the workspace independently so a provider's network delay never traps the dialog.
      Promise.resolve(onSaved(draft.provider)).catch(() => {});
    } catch (error) { notify(error.message, true); }
    finally { setBusy(false); save.textContent = "保存配置"; }
  });
}
