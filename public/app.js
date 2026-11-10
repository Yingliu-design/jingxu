import { initApiSettings } from "./api-settings.js";

const elements = {
  toolTabs: [...document.querySelectorAll(".tool-tab")],
  storyWorkspace: document.querySelector("#story-workspace"),
  textWorkspace: document.querySelector("#text-workspace"),
  downloadWorkspace: document.querySelector("#download-workspace"),
  form: document.querySelector("#generator-form"),
  script: document.querySelector("#script"),
  durationSeconds: document.querySelector("#duration-seconds"),
  durationPresets: [...document.querySelectorAll(".duration-preset")],
  requirements: document.querySelector("#requirements"),
  shotCount: document.querySelector("#shot-count"),
  shotEstimate: document.querySelector("#shot-estimate"),
  groupEstimate: document.querySelector("#group-estimate"),
  taskCount: document.querySelector("#task-count"),
  modelProvider: document.querySelector("#model-provider"),
  textModel: document.querySelector("#text-model"),
  modelNote: document.querySelector("#model-note"),
  preview: document.querySelector("#preview-button"),
  generate: document.querySelector("#generate-button"),
  actionNote: document.querySelector("#action-note"),
  connection: document.querySelector("#connection"),
  error: document.querySelector("#form-error"),
  storyStatus: document.querySelector("#story-status"),
  empty: document.querySelector("#empty-state"),
  loading: document.querySelector("#loading-state"),
  summary: document.querySelector("#result-summary"),
  storyboardResult: document.querySelector("#storyboard-result"),
  storyboardOutput: document.querySelector("#storyboard-output"),
  copyStoryboard: document.querySelector("#copy-storyboard"),
  taskList: document.querySelector("#task-list"),
  taskTemplate: document.querySelector("#task-template"),
  resultActions: document.querySelector("#result-actions"),
  copyAll: document.querySelector("#copy-all"),
  download: document.querySelector("#download-json"),
  videoDownloadForm: document.querySelector("#video-download-form"),
  videoUrl: document.querySelector("#video-url"),
  videoQuality: document.querySelector("#video-quality"),
  videoDownloadButton: document.querySelector("#video-download-button"),
  videoDownloadError: document.querySelector("#video-download-error"),
  videoDownloadProgress: document.querySelector("#video-download-progress"),
  videoDownloadPhase: document.querySelector("#video-download-phase"),
  videoDownloadPercent: document.querySelector("#video-download-percent"),
  videoDownloadProgressbar: document.querySelector("#video-download-progressbar"),
  videoDownloadProgressFill: document.querySelector("#video-download-progress-fill"),
  videoDownloadDetail: document.querySelector("#video-download-detail"),
  videoDownloadStatus: document.querySelector("#video-download-status"),
  videoDownloadName: document.querySelector("#video-download-name"),
  videoDownloadMeta: document.querySelector("#video-download-meta"),
  videoDownloadLink: document.querySelector("#video-download-link"),
  textGenerationForm: document.querySelector("#text-generation-form"),
  textPromptSelect: document.querySelector("#text-prompt-select"),
  textPromptPreview: document.querySelector("#text-prompt-preview"),
  textProvider: document.querySelector("#text-provider"),
  textGenerationModel: document.querySelector("#text-generation-model"),
  textVideo: document.querySelector("#text-video"),
  textVideoMeta: document.querySelector("#text-video-meta"),
  textVideoName: document.querySelector("#text-video-name"),
  removeTextVideo: document.querySelector("#remove-text-video"),
  textSource: document.querySelector("#text-source"),
  textGenerationError: document.querySelector("#text-generation-error"),
  textGenerateButton: document.querySelector("#text-generate-button"),
  textRandomStory: document.querySelector("#text-random-story"),
  textOutputEmpty: document.querySelector("#text-output-empty"),
  textOutputLoading: document.querySelector("#text-output-loading"),
  textGenerationPhase: document.querySelector("#text-generation-phase"),
  textGenerationPercent: document.querySelector("#text-generation-percent"),
  textGenerationProgressbar: document.querySelector("#text-generation-progressbar"),
  textGenerationProgressFill: document.querySelector("#text-generation-progress-fill"),
  textGenerationProgressDetail: document.querySelector("#text-generation-progress-detail"),
  textOutputMeta: document.querySelector("#text-output-meta"),
  textOutput: document.querySelector("#text-output"),
  textOutputActions: document.querySelector("#text-output-actions"),
  textResultTabs: document.querySelector("#text-result-tabs"),
  textResultTabButtons: [...document.querySelectorAll(".text-result-tab")],
  textVersionTabs: document.querySelector("#text-version-tabs"),
  textVersionTabButtons: [...document.querySelectorAll(".text-version-tab")],
  textTaskPanel: document.querySelector("#text-task-panel"),
  textTaskSummary: document.querySelector("#text-task-summary"),
  textTaskStoryboardOutput: document.querySelector("#text-task-storyboard-output"),
  textTaskList: document.querySelector("#text-task-list"),
  copyTextTasks: document.querySelector("#copy-text-tasks"),
  copyTextStoryboard: document.querySelector("#copy-text-storyboard"),
  castOptions: [...document.querySelectorAll(".cast-option")],
  remixTextOutput: document.querySelector("#remix-text-output"),
  copyTextOutput: document.querySelector("#copy-text-output"),
  toast: document.querySelector("#toast")
};

let currentTasks = [];
let currentStoryboard = "";
let currentTitle = "";
let toastTimer;
let textGenerationProgressTimer;
let textGenerationStartedAt = 0;
let providerStatus = {};
let modelRequestId = 0;
let promptLibrary = [];
let promptsLoaded = false;
let textModelRequestId = 0;
let currentTextTasks = [];
let currentTextStoryboard = "";
let currentTextCastMode = null;
let currentOriginalOutput = "";
let currentOriginalMeta = "";
let currentReplicaOutput = "";
let currentReplicaMeta = "";
let currentRemixOutput = "";
let currentRemixMeta = "";
let currentStoryVersion = "original";
let workspaceSaveTimer;
let restoredStoryModelApplied = false;
let restoredTextModelApplied = false;

const workspaceStorageKey = "storyboard-studio.workspace.v1";
const workspaceDbName = "storyboard-studio";
const workspaceDbStore = "workspace";

function openWorkspaceDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(workspaceDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(workspaceDbStore)) db.createObjectStore(workspaceDbStore);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readWorkspaceDbState() {
  try {
    const db = await openWorkspaceDb();
    const state = await new Promise((resolve, reject) => {
      const transaction = db.transaction(workspaceDbStore, "readonly");
      const request = transaction.objectStore(workspaceDbStore).get("current");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return state?.version === 1 ? state : null;
  } catch {
    return null;
  }
}

async function writeWorkspaceDbState(state) {
  try {
    const db = await openWorkspaceDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(workspaceDbStore, "readwrite");
      transaction.objectStore(workspaceDbStore).put(state, "current");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // IndexedDB 不可用时仍保留 localStorage 的同步保存。
  }
}

async function readWorkspaceState() {
  let localState = null;
  try {
    const raw = localStorage.getItem(workspaceStorageKey);
    const state = raw ? JSON.parse(raw) : null;
    localState = state?.version === 1 ? state : null;
  } catch {
    localState = null;
  }
  const dbState = await readWorkspaceDbState();
  if (!localState) return dbState;
  if (!dbState) return localState;
  return Number(dbState.savedAt || 0) > Number(localState.savedAt || 0) ? dbState : localState;
}

const restoredWorkspaceState = await readWorkspaceState();

const providerNames = { gemini: "Gemini", openai: "OpenAI", deepseek: "DeepSeek" };
const providerKeyNames = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY" };
const defaultTextPromptId = "00000000-0000-4000-8000-000000000007";

function detectFixedCastMode(source) {
  const hasLegacyRoles = /女主人|男主人|男子|男人|男性|男士|男主角|男主(?!人)|男友|男生|男方|女子|女性|女士|女主角|女主(?!人)/.test(source);
  if (hasLegacyRoles || !/布丁/.test(source) || !/主人/.test(source)) return null;
  if (/coco|蓝白长毛/i.test(source)) return "trio";
  if (/布丁/.test(source) && /主人/.test(source)) return "duo";
  return null;
}

function updateCastSelection(castMode) {
  currentTextCastMode = castMode;
  elements.castOptions.forEach((button) => {
    const selected = button.dataset.castMode === castMode;
    button.setAttribute("aria-pressed", String(selected));
    button.classList.toggle("primary", selected);
    button.classList.toggle("secondary", !selected);
  });
}

function extractShotCount(text) {
  return [...text.matchAll(/^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/gm)].length;
}

function readTaskCountOverride() {
  const raw = elements.taskCount.value.trim();
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 30 ? value : 0;
}

function createTimingPlan(durationSeconds, existingShotCount = 0, taskCountOverride = 0) {
  const automaticTaskCount = Math.max(1, Math.ceil(durationSeconds / 10));
  const requestedTaskCount = taskCountOverride || automaticTaskCount;
  const totalShots = existingShotCount || Math.max(requestedTaskCount, Math.round(durationSeconds / 2));
  const taskCount = Math.min(totalShots, requestedTaskCount);
  const shotsPerTask = Math.max(1, Math.ceil(totalShots / taskCount));
  return {
    totalShots,
    shotsPerTask,
    taskCount,
    automaticTaskCount
  };
}

function updateEstimate() {
  const count = extractShotCount(elements.script.value);
  const duration = Number(elements.durationSeconds.value);
  const taskCountOverride = readTaskCountOverride();
  const plan = createTimingPlan(duration || 0, count, taskCountOverride);
  elements.shotCount.textContent = count ? `已识别 ${count} 镜，将按 ${duration || "—"} 秒分组` : `按 ${duration || "—"} 秒自动规划`;
  elements.shotEstimate.textContent = duration ? String(plan.totalShots) : "—";
  elements.groupEstimate.textContent = duration ? String(plan.shotsPerTask) : "—";

  elements.durationPresets.forEach((button) => {
    const selected = Number(button.dataset.seconds) === duration;
    button.setAttribute("aria-pressed", String(selected));
  });
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2200);
}

function syncCurrentStoryVersion() {
  if (currentStoryVersion === "remix") {
    currentRemixOutput = elements.textOutput.value;
    currentRemixMeta = elements.textOutputMeta.textContent;
  } else if (currentStoryVersion === "replica") {
    currentReplicaOutput = elements.textOutput.value;
    currentReplicaMeta = elements.textOutputMeta.textContent;
  } else {
    currentOriginalOutput = elements.textOutput.value;
    currentOriginalMeta = elements.textOutputMeta.textContent;
  }
}

function updateStoryVersionTabs() {
  const resultView = elements.textResultTabButtons.find((button) => button.getAttribute("aria-selected") === "true")?.dataset.resultView || "replica";
  const versionCount = [currentOriginalOutput, currentReplicaOutput, currentRemixOutput].filter((value) => value.trim()).length;
  elements.textVersionTabs.hidden = resultView !== "replica" || versionCount < 2;
  elements.textVersionTabButtons.forEach((button) => {
    const output = button.dataset.storyVersion === "original"
      ? currentOriginalOutput
      : button.dataset.storyVersion === "remix" ? currentRemixOutput : currentReplicaOutput;
    button.hidden = !output.trim();
  });
}

function selectStoryVersion(version, { sync = true } = {}) {
  if (sync) syncCurrentStoryVersion();
  const available = {
    original: currentOriginalOutput.trim(),
    replica: currentReplicaOutput.trim(),
    remix: currentRemixOutput.trim()
  };
  currentStoryVersion = available[version] ? version : available.replica ? "replica" : available.remix ? "remix" : "original";
  const isRemix = currentStoryVersion === "remix";
  const isReplica = currentStoryVersion === "replica";
  elements.textOutput.value = isRemix ? currentRemixOutput : isReplica ? currentReplicaOutput : currentOriginalOutput;
  elements.textOutputMeta.textContent = (isRemix ? currentRemixMeta : isReplica ? currentReplicaMeta : currentOriginalMeta) || "上次生成结果";
  const hasOutput = Boolean(elements.textOutput.value.trim());
  elements.textOutput.hidden = !hasOutput;
  elements.textOutputMeta.hidden = !hasOutput;
  elements.textOutputEmpty.hidden = hasOutput;
  elements.textOutputActions.hidden = !hasOutput;
  elements.copyTextOutput.hidden = !hasOutput;
  elements.textVersionTabButtons.forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.storyVersion === currentStoryVersion));
  });
  updateCastSelection(detectFixedCastMode(elements.textOutput.value));
  updateStoryVersionTabs();
}

function saveWorkspaceState() {
  syncCurrentStoryVersion();
  const selectedTextView = elements.textResultTabButtons.find((button) => button.getAttribute("aria-selected") === "true")?.dataset.resultView || "replica";
  const state = {
    version: 1,
    savedAt: Date.now(),
    story: {
      script: elements.script.value,
      durationSeconds: elements.durationSeconds.value,
      requirements: elements.requirements.value,
      taskCount: elements.taskCount.value,
      provider: elements.modelProvider.value,
      model: elements.textModel.value,
      status: elements.storyStatus.hidden ? "" : elements.storyStatus.textContent,
      result: currentStoryboard ? {
        title: currentTitle,
        storyboard: currentStoryboard,
        tasks: currentTasks,
        summary: elements.summary.textContent
      } : null
    },
    text: {
      promptId: elements.textPromptSelect.value,
      provider: elements.textProvider.value,
      model: elements.textGenerationModel.value,
      source: elements.textSource.value,
      output: elements.textOutput.value,
      outputMeta: elements.textOutputMeta.textContent,
      originalOutput: currentOriginalOutput,
      originalMeta: currentOriginalMeta,
      replicaOutput: currentReplicaOutput,
      replicaMeta: currentReplicaMeta,
      remixOutput: currentRemixOutput,
      remixMeta: currentRemixMeta,
      storyVersion: currentStoryVersion,
      castMode: currentTextCastMode,
      selectedView: selectedTextView,
      taskResult: currentTextStoryboard ? {
        storyboard: currentTextStoryboard,
        tasks: currentTextTasks,
        summary: elements.textTaskSummary.textContent
      } : null
    }
  };

  try {
    localStorage.setItem(workspaceStorageKey, JSON.stringify(state));
  } catch {
    // 内容过大或 localStorage 不可用时，继续使用 IndexedDB 保存。
  }
  void writeWorkspaceDbState(state);
}

function queueWorkspaceSave() {
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(saveWorkspaceState, 180);
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function updateVideoDownloadProgress(job) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(job.percent) || 0)));
  elements.videoDownloadProgress.hidden = false;
  elements.videoDownloadPhase.textContent = job.phase || "正在下载视频";
  elements.videoDownloadPercent.textContent = `${percent}%`;
  elements.videoDownloadDetail.textContent = job.detail || "请保持此页面打开。";
  elements.videoDownloadProgressbar.setAttribute("aria-valuenow", String(percent));
  elements.videoDownloadProgressFill.style.transform = `scaleX(${percent / 100})`;
  elements.videoDownloadButton.textContent = job.status === "complete" ? "下载完成" : `下载中 ${percent}%`;
}

async function waitForVideoDownload(jobId) {
  for (;;) {
    const response = await fetch(`/api/video-download-status/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "无法读取下载进度。");
    updateVideoDownloadProgress(job);
    if (job.status === "complete") return job.result;
    if (job.status === "failed") throw new Error(job.error || "视频下载失败，请稍后重试。");
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
}

function switchTool(view) {
  const selectedView = ["home", "story", "text", "download"].includes(view) ? view : "home";
  document.querySelector("#home-workspace").hidden = selectedView !== "home";
  document.body.classList.toggle("is-home", selectedView === "home");
  elements.storyWorkspace.hidden = selectedView !== "story";
  elements.textWorkspace.hidden = selectedView !== "text";
  elements.downloadWorkspace.hidden = selectedView !== "download";
  elements.toolTabs.forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.view === selectedView));
  });
  const hash = selectedView === "text"
    ? "#shot-recreation"
    : selectedView === "story" ? "#storyboard-tasks" : selectedView === "download" ? "#video-download" : "#home";
  history.replaceState(null, "", hash);
  if (selectedView === "text" && !promptsLoaded) loadPrompts();
  if (selectedView === "text" && !elements.textGenerationModel.value) loadTextModels();
}

async function requestVideoDownload(event) {
  event.preventDefault();
  elements.videoDownloadError.hidden = true;
  elements.videoDownloadStatus.hidden = true;
  elements.videoDownloadProgress.hidden = false;
  updateVideoDownloadProgress({ status: "running", phase: "正在检查链接", detail: "正在识别视频平台…", percent: 2 });
  elements.videoDownloadButton.disabled = true;
  try {
    const url = elements.videoUrl.value;
    const quality = elements.videoQuality.value;
    let data;
    try {
      data = await startVideoDownload(url, quality);
    } catch (error) {
      const isXiaohongshu = /https?:\/\/(?:[a-z0-9-]+\.)*xiaohongshu\.com(?:[/?#]|$)/i.test(url);
      const missingFormat = /清晰度|格式|该视频可能已删除/.test(error.message);
      // 兼容仍在运行的旧下载服务：其高度筛选会排除竖屏视频。
      if (!isXiaohongshu || quality === "best" || !missingFormat) throw error;
      updateVideoDownloadProgress({ status: "running", phase: "正在重试可用画质", detail: "重新选择源站提供的视频格式…", percent: 2 });
      data = await startVideoDownload(url, "best");
    }
    elements.videoDownloadName.textContent = data.filename;
    elements.videoDownloadMeta.textContent = `${formatFileSize(data.size)} · 已保存到下载文件夹`;
    elements.videoDownloadStatus.hidden = false;
    const saveLink = document.createElement("a");
    saveLink.href = data.downloadUrl;
    saveLink.download = data.filename;
    saveLink.click();
    showToast("视频已下载完成");
  } catch (error) {
    elements.videoDownloadProgress.hidden = true;
    elements.videoDownloadError.textContent = error.message;
    elements.videoDownloadError.hidden = false;
  } finally {
    elements.videoDownloadButton.disabled = false;
    elements.videoDownloadButton.textContent = "开始下载";
  }
}

async function startVideoDownload(url, quality) {
  const response = await fetch("/api/video-download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, quality })
  });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || "视频下载失败，请稍后重试。");
  return waitForVideoDownload(job.jobId);
}

async function openVideoDownloadsFolder() {
  elements.videoDownloadLink.disabled = true;
  try {
    const response = await fetch("/api/open-downloads-folder", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法打开下载文件夹。");
    showToast("已打开下载文件夹");
  } catch (error) {
    elements.videoDownloadError.textContent = error.message;
    elements.videoDownloadError.hidden = false;
  } finally {
    elements.videoDownloadLink.disabled = false;
  }
}

function setLoading(loading, isPreview = false) {
  elements.generate.disabled = loading;
  elements.preview.disabled = loading;
  elements.empty.hidden = true;
  elements.loading.hidden = !loading;
  elements.taskList.hidden = loading;
  elements.storyboardResult.hidden = loading || !currentStoryboard;
  elements.resultActions.hidden = loading || !currentTasks.length;
  elements.summary.hidden = loading || !currentTasks.length;
  if (loading) {
    elements.loading.querySelector("p").textContent = isPreview
      ? "正在按镜号检查任务范围。"
      : "正在逐镜核对画面与台词，通常需要几十秒。";
  }
}

function setStoryLoading(loading) {
  elements.textRandomStory.disabled = loading;
  elements.generate.disabled = loading;
  elements.preview.disabled = loading;
  elements.textRandomStory.textContent = loading ? "正在创作…" : "随机搞笑故事";
}

function taskAsText(task) {
  return task.prompt;
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    showToast("复制失败，请手动选择文本。");
  }
}

async function loadPrompts() {
  try {
    const response = await fetch("/api/prompts");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "提示词读取失败。");
    promptLibrary = data.prompts || [];
    promptsLoaded = true;
    elements.textPromptSelect.replaceChildren(new Option("不使用预设提示词（系统默认分析）", ""));
    promptLibrary.forEach((item) => elements.textPromptSelect.append(new Option(`[${item.category}] ${item.title}`, item.id)));
    const savedPromptId = restoredWorkspaceState?.text?.promptId;
    if (savedPromptId && promptLibrary.some((item) => item.id === savedPromptId)) {
      elements.textPromptSelect.value = savedPromptId;
    } else if (promptLibrary.some((item) => item.id === defaultTextPromptId)) {
      elements.textPromptSelect.value = defaultTextPromptId;
    }
    updateTextPromptPreview();
  } catch (error) {
    elements.textGenerationError.textContent = error.message;
    elements.textGenerationError.hidden = false;
  }
}

function renderTaskItems(container, tasks) {
  container.replaceChildren();
  tasks.forEach((task, index) => {
    const fragment = elements.taskTemplate.content.cloneNode(true);
    const article = fragment.querySelector(".task-item");
    article.style.setProperty("--i", Math.min(index, 8));
    fragment.querySelector(".task-index").textContent = String(task.id).padStart(2, "0");
    fragment.querySelector(".task-title").textContent = `分镜 ${task.shotRange}`;
    fragment.querySelector(".task-prompt").value = task.prompt;
    fragment.querySelector(".copy-task").addEventListener("click", () => copyText(taskAsText(task), `任务 ${task.id} 已复制`));
    container.append(fragment);
  });
}

function renderTasks(tasks, meta) {
  currentTasks = tasks;
  renderTaskItems(elements.taskList, tasks);
  const providerName = providerNames[meta.provider] || meta.provider;
  const mode = meta.mode === "story"
    ? `内容已生成分镜 · ${providerName} · ${meta.model}`
    : meta.mode === "preview" ? "本地无损整理" : "已有分镜已整理";
  const timing = meta.timingPlan;
  elements.summary.textContent = `${mode}｜${timing.durationSeconds} 秒｜${meta.shotCount} 镜｜每组 ${timing.shotsPerTask} 镜｜${meta.taskCount} 个任务`;
  elements.summary.hidden = false;
  elements.resultActions.hidden = false;
  elements.taskList.hidden = false;
}

function renderResult(data) {
  currentStoryboard = data.storyboardMarkdown;
  currentTitle = data.title;
  elements.storyboardOutput.value = currentStoryboard;
  elements.storyboardResult.hidden = false;
  renderTasks(data.tasks, data.meta);
  if (data.meta.mode === "story") {
    const dialogueNote = data.meta.dialogueLockCount
      ? `；已逐字锁定 ${data.meta.dialogueLockCount} 句原台词`
      : "";
    const languageNote = data.meta.chineseOnly ? "；分镜与任务已校验为全中文" : "";
    const formatNote = data.meta.losslessFormat ? "；已按原分镜顺序无损换格式" : "";
    elements.storyStatus.textContent = `复刻内容已转成 ${data.meta.shotCount} 镜和 ${data.meta.taskCount} 个任务${dialogueNote}${languageNote}${formatNote}；修改内容后可以重新生成。`;
    elements.storyStatus.hidden = false;
  }
  saveWorkspaceState();
}

async function requestTasks(path) {
  elements.error.hidden = true;
  const rawTaskCount = elements.taskCount.value.trim();
  const taskCount = rawTaskCount ? Number(rawTaskCount) : 0;
  if (rawTaskCount && (!Number.isInteger(taskCount) || taskCount < 1 || taskCount > 30)) {
    elements.error.textContent = "任务数需要是 1—30 之间的整数，或留空自动计算。";
    elements.error.hidden = false;
    elements.taskCount.focus();
    return false;
  }
  const existingShotCount = extractShotCount(elements.script.value);
  if (existingShotCount && taskCount > existingShotCount) {
    elements.error.textContent = `任务数不能超过已识别的 ${existingShotCount} 个镜头。`;
    elements.error.hidden = false;
    elements.taskCount.focus();
    return false;
  }
  const isPreview = path === "/api/preview";
  setLoading(true, isPreview);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: elements.script.value,
        durationSeconds: Number(elements.durationSeconds.value),
        taskCount: taskCount || undefined,
        globalRequirements: elements.requirements.value,
        provider: elements.modelProvider.value,
        model: elements.textModel.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成失败，请稍后重试。");
    renderResult(data);
    return true;
  } catch (error) {
    elements.error.textContent = error.message;
    elements.error.hidden = false;
    elements.empty.hidden = currentTasks.length > 0;
    return false;
  } finally {
    setLoading(false);
  }
}

async function requestRandomStory() {
  elements.error.hidden = true;
  elements.storyStatus.hidden = true;
  setStoryLoading(true);
  try {
    const response = await fetch("/api/random-story", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        durationSeconds: Number(elements.durationSeconds.value),
        provider: elements.modelProvider.value,
        model: elements.textModel.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "故事生成失败，请再试一次。");
    elements.script.value = data.story;
    const providerName = providerNames[data.provider] || data.provider;
    elements.storyStatus.textContent = `《${data.title}》已生成｜${providerName} · ${data.model}｜本集角色：${data.cast}。你可以直接修改，满意后点击“转成分镜与任务”。`;
    elements.storyStatus.hidden = false;
    updateEstimate();
    saveWorkspaceState();
    elements.script.focus();
    showToast("臭猫故事已生成");
  } catch (error) {
    elements.error.textContent = error.message;
    elements.error.hidden = false;
  } finally {
    setStoryLoading(false);
  }
}

async function requestRandomStoryFromReplica() {
  switchTool("story");
  await requestRandomStory();
}

function updateTextGenerationProgress(value, phase) {
  const progress = Math.max(0, Math.min(100, Math.round(value)));
  const elapsedSeconds = Math.max(0, Math.floor((performance.now() - textGenerationStartedAt) / 1000));
  elements.textGenerationPhase.textContent = phase;
  elements.textGenerationPercent.textContent = progress === 100 ? "100%" : `预计 ${progress}%`;
  elements.textGenerationProgressbar.setAttribute("aria-valuenow", String(progress));
  elements.textGenerationProgressFill.style.transform = `scaleX(${progress / 100})`;
  elements.textGenerationProgressDetail.textContent = progress === 100
    ? `生成完成，共等待 ${elapsedSeconds} 秒。`
    : `已等待 ${elapsedSeconds} 秒，完成后会自动显示结果。`;
}

function startTextGenerationProgress(hasVideo) {
  clearInterval(textGenerationProgressTimer);
  textGenerationStartedAt = performance.now();
  updateTextGenerationProgress(4, hasVideo ? "正在上传并分析视频" : "正在提交生成任务");
  textGenerationProgressTimer = setInterval(() => {
    const elapsedSeconds = (performance.now() - textGenerationStartedAt) / 1000;
    const estimatedProgress = Math.min(94, 4 + 90 * (1 - Math.exp(-elapsedSeconds / 38)));
    const phase = hasVideo
      ? (elapsedSeconds < 8 ? "正在上传并分析视频" : elapsedSeconds < 35 ? "正在识别画面与声音" : "正在整理生成结果")
      : (elapsedSeconds < 5 ? "正在提交生成任务" : elapsedSeconds < 28 ? "正在生成分镜内容" : "正在整理生成结果");
    updateTextGenerationProgress(estimatedProgress, phase);
  }, 500);
}

async function finishTextGenerationProgress(succeeded) {
  clearInterval(textGenerationProgressTimer);
  textGenerationProgressTimer = undefined;
  if (succeeded) {
    updateTextGenerationProgress(100, "生成完成");
    await new Promise((resolve) => setTimeout(resolve, 320));
  }
  elements.textOutputLoading.hidden = true;
}

async function requestTextGeneration(event) {
  event.preventDefault();
  const video = elements.textVideo.files?.[0];
  if (!elements.textSource.value.trim() && !video) {
    elements.textGenerationError.textContent = "请填写补充文本，或者选择一个视频。";
    elements.textGenerationError.hidden = false;
    return;
  }
  if (video && elements.textProvider.value !== "gemini") {
    elements.textGenerationError.textContent = "视频理解需要使用 Gemini，请重新选择视频后再试。";
    elements.textGenerationError.hidden = false;
    return;
  }
  elements.textGenerationError.hidden = true;
  elements.textGenerateButton.disabled = true;
  elements.textGenerateButton.textContent = video ? "正在上传并分析…" : "正在生成…";
  elements.textOutputEmpty.hidden = true;
  elements.textOutput.hidden = true;
  elements.textOutputMeta.hidden = true;
  elements.textOutputActions.hidden = true;
  elements.copyTextOutput.hidden = true;
  resetTextTaskResult();
  elements.textOutputLoading.hidden = false;
  startTextGenerationProgress(Boolean(video));
  let succeeded = false;
  try {
    const formData = new FormData();
    formData.append("input", elements.textSource.value);
    formData.append("promptId", elements.textPromptSelect.value);
    formData.append("provider", elements.textProvider.value);
    formData.append("model", elements.textGenerationModel.value);
    if (video) formData.append("video", video, video.name);
    const response = await fetch("/api/text-generate", {
      method: "POST",
      body: formData
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "文本生成失败，请稍后重试。");
    const videoMeta = data.videoName ? `｜视频：${data.videoName}` : "";
    currentOriginalOutput = data.text;
    currentOriginalMeta = `${data.promptTitle}｜${providerNames[data.provider] || data.provider} · ${data.model}${videoMeta}`;
    currentReplicaOutput = "";
    currentReplicaMeta = "";
    currentRemixOutput = "";
    currentRemixMeta = "";
    selectStoryVersion("original", { sync: false });
    saveWorkspaceState();
    showToast("文本已生成");
    succeeded = true;
  } catch (error) {
    elements.textGenerationError.textContent = error.message;
    elements.textGenerationError.hidden = false;
    elements.textOutputEmpty.hidden = false;
  } finally {
    await finishTextGenerationProgress(succeeded);
    elements.textGenerateButton.disabled = false;
    elements.textGenerateButton.textContent = "开始生成";
  }
}

function setTextOutputActionLoading(active) {
  elements.castOptions.forEach((button) => {
    button.disabled = active;
  });
  elements.remixTextOutput.disabled = active;
  elements.copyTextOutput.disabled = active;
}

function switchTextResult(view) {
  const selectedView = view === "tasks" && currentTextTasks.length ? "tasks" : "replica";
  elements.textOutput.hidden = selectedView !== "replica";
  elements.textOutputMeta.hidden = selectedView !== "replica";
  elements.textTaskPanel.hidden = selectedView !== "tasks";
  elements.copyTextOutput.hidden = selectedView !== "replica";
  elements.textResultTabButtons.forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.resultView === selectedView));
  });
  updateStoryVersionTabs();
}

function resetTextTaskResult() {
  currentTextTasks = [];
  currentTextStoryboard = "";
  elements.textTaskList.replaceChildren();
  elements.textTaskPanel.hidden = true;
  elements.textResultTabs.hidden = true;
}

function renderTextTaskResult(data) {
  currentTextTasks = data.tasks;
  currentTextStoryboard = data.storyboardMarkdown;
  elements.textTaskStoryboardOutput.value = currentTextStoryboard;
  renderTaskItems(elements.textTaskList, data.tasks);
  const timing = data.meta.timingPlan;
  const providerName = providerNames[data.meta.provider] || data.meta.provider;
  elements.textTaskSummary.textContent = `复刻结果已生成分镜 · ${providerName} · ${data.meta.model}｜${timing.durationSeconds} 秒｜${data.meta.shotCount} 镜｜每组 ${timing.shotsPerTask} 镜｜${data.meta.taskCount} 个任务`;
  elements.textResultTabs.hidden = false;
  switchTextResult("tasks");
  saveWorkspaceState();
}

async function requestFixedCastChange(castMode) {
  const source = currentOriginalOutput.trim() || currentReplicaOutput.trim() || elements.textOutput.value.trim();
  if (!source) return;
  if (castMode === detectFixedCastMode(source)) {
    showToast("当前已经是这个角色组合");
    return;
  }
  elements.textGenerationError.hidden = true;
  setTextOutputActionLoading(true);
  try {
    const response = await fetch("/api/rewrite-cast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        castMode,
        provider: elements.textProvider.value,
        model: elements.textGenerationModel.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "固定角色更换失败，请稍后重试。");
    currentReplicaOutput = data.text;
    currentReplicaMeta = `${data.cast}｜${providerNames[data.provider] || data.provider} · ${data.model}`;
    selectStoryVersion("replica", { sync: false });
    elements.textOutput.scrollTop = 0;
    resetTextTaskResult();
    switchTextResult("replica");
    saveWorkspaceState();
    showToast(`已改成${data.cast}`);
  } catch (error) {
    elements.textGenerationError.textContent = error.message;
    elements.textGenerationError.hidden = false;
  } finally {
    setTextOutputActionLoading(false);
  }
}

async function requestStoryRemix() {
  const source = currentReplicaOutput.trim() || currentOriginalOutput.trim() || elements.textOutput.value.trim();
  if (!source) return;
  const castMode = detectFixedCastMode(source);
  if (!castMode) {
    elements.textGenerationError.textContent = "请先选择“主人 + 布丁”或“主人 + 布丁 + Coco（配角）”。";
    elements.textGenerationError.hidden = false;
    return;
  }
  elements.textGenerationError.hidden = true;
  setTextOutputActionLoading(true);
  elements.remixTextOutput.textContent = "正在二创…";
  try {
    const response = await fetch("/api/adapt-story", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        castMode,
        provider: elements.textProvider.value,
        model: elements.textGenerationModel.value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "故事二创失败，请稍后重试。");
    const providerName = providerNames[data.provider] || data.provider;
    currentRemixOutput = data.story;
    currentRemixMeta = `二创故事｜${data.cast}｜${providerName} · ${data.model}｜约 ${data.durationSeconds} 秒`;
    selectStoryVersion("remix", { sync: false });
    elements.textOutput.scrollTop = 0;
    resetTextTaskResult();
    switchTextResult("replica");
    saveWorkspaceState();
    showToast("二创已生成，换角色结果仍然保留");
  } catch (error) {
    elements.textGenerationError.textContent = error.message;
    elements.textGenerationError.hidden = false;
  } finally {
    setTextOutputActionLoading(false);
    elements.remixTextOutput.textContent = "二创故事";
  }
}

async function updateTextVideo() {
  const video = elements.textVideo.files?.[0];
  elements.textGenerationError.hidden = true;
  if (!video) {
    elements.textVideoMeta.hidden = true;
    elements.textVideoName.textContent = "";
    return;
  }
  if (video.size > 95 * 1024 * 1024) {
    elements.textVideo.value = "";
    elements.textVideoMeta.hidden = true;
    elements.textGenerationError.textContent = "视频超过 95 MB，请先压缩或选择较小的视频。";
    elements.textGenerationError.hidden = false;
    return;
  }
  elements.textVideoName.textContent = `${video.name} · ${formatBytes(video.size)}`;
  elements.textVideoMeta.hidden = false;
  if (elements.textProvider.value !== "gemini") {
    elements.textProvider.value = "gemini";
    await loadTextModels();
    showToast("已自动切换到 Gemini 视频理解");
  }
}

function removeTextVideo() {
  elements.textVideo.value = "";
  elements.textVideoMeta.hidden = true;
  elements.textVideoName.textContent = "";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function updateTextPromptPreview() {
  const item = promptLibrary.find((prompt) => prompt.id === elements.textPromptSelect.value);
  elements.textPromptPreview.textContent = item?.content || "未选择预设提示词时，系统会按时间顺序分析视频或文本，提取人物、场景、镜头、动作、台词和节奏。";
}

async function loadStatus() {
  try {
    let status;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        if (!response.ok) throw new Error(`状态接口返回 ${response.status}`);
        status = await response.json();
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        elements.connection.querySelector("span:last-child").textContent = "正在重新连接";
        await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
      }
    }
    providerStatus = status.providers || {};
    const openaiOption = elements.modelProvider.querySelector('option[value="openai"]');
    const geminiOption = elements.modelProvider.querySelector('option[value="gemini"]');
    const deepseekOption = elements.modelProvider.querySelector('option[value="deepseek"]');
    const textOpenaiOption = elements.textProvider.querySelector('option[value="openai"]');
    const textGeminiOption = elements.textProvider.querySelector('option[value="gemini"]');
    const textDeepseekOption = elements.textProvider.querySelector('option[value="deepseek"]');
    openaiOption.textContent = providerStatus.openai?.configured ? "OpenAI GPT" : "OpenAI GPT（未配置）";
    geminiOption.textContent = providerStatus.gemini?.configured ? "Google Gemini" : "Google Gemini（未配置）";
    deepseekOption.textContent = providerStatus.deepseek?.configured ? "DeepSeek" : "DeepSeek（未配置）";
    textOpenaiOption.textContent = openaiOption.textContent;
    textGeminiOption.textContent = geminiOption.textContent;
    textDeepseekOption.textContent = deepseekOption.textContent;
    await loadModels();
  } catch {
    elements.connection.querySelector("span:last-child").textContent = "服务连接失败";
    elements.modelNote.textContent = "无法读取模型状态，请确认本地服务正在运行。";
  }
}

function updateConnection() {
  const provider = elements.modelProvider.value;
  const status = providerStatus[provider];
  const providerName = providerNames[provider] || provider;
  const configured = Boolean(status?.configured);
  elements.connection.classList.toggle("ready", configured);
  elements.connection.querySelector("span:last-child").textContent = configured
    ? `${providerName} · ${elements.textModel.value}`
    : `${providerName} 未配置`;
  elements.actionNote.textContent = configured
    ? "粘贴复刻内容，选择视频秒数后生成逐镜脚本和任务提示词。"
    : `尚未配置 ${providerName}；可切换服务商，本地整理已有分镜仍可使用。`;
}

async function loadModels() {
  const provider = elements.modelProvider.value;
  const requestId = ++modelRequestId;
  elements.textModel.disabled = true;
  elements.textModel.replaceChildren(new Option("正在读取可用模型…", ""));
  elements.modelNote.textContent = "正在读取当前账号可用的文本模型。";
  try {
    const response = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
    const data = await response.json();
    if (requestId !== modelRequestId) return;
    if (!response.ok) throw new Error(data.error || "模型列表读取失败。");
    providerStatus[provider] = { configured: data.configured, defaultModel: data.defaultModel };
    elements.textModel.replaceChildren();
    if (!data.configured) {
      const keyName = providerKeyNames[provider] || "API_KEY";
      elements.textModel.append(new Option("尚未配置", data.defaultModel || ""));
      elements.modelNote.textContent = `点击“配置 API”填写 ${keyName}，保存后立即生效。`;
    } else {
      const models = data.models?.length ? data.models : [data.defaultModel].filter(Boolean);
      models.forEach((model) => elements.textModel.append(new Option(model, model)));
      const restoredModel = restoredWorkspaceState?.story?.provider === provider && !restoredStoryModelApplied
        ? restoredWorkspaceState.story.model
        : "";
      const savedModel = provider === "gemini" && restoredModel === "gemini-3.6-flash"
        ? data.defaultModel
        : restoredModel;
      elements.textModel.value = models.includes(savedModel)
        ? savedModel
        : models.includes(data.defaultModel) ? data.defaultModel : models[0] || "";
      restoredStoryModelApplied = true;
      elements.textModel.disabled = models.length === 0;
      elements.modelNote.textContent = models.length
        ? `已读取 ${models.length} 个可用文本模型；故事与分镜共用当前选择。`
        : "当前账号没有返回可用的文本模型。";
    }
  } catch (error) {
    if (requestId !== modelRequestId) return;
    elements.textModel.replaceChildren(new Option("模型列表读取失败", ""));
    elements.modelNote.textContent = error.message;
  } finally {
    if (requestId === modelRequestId) {
      const configured = Boolean(providerStatus[provider]?.configured);
      elements.textModel.disabled = !configured || !elements.textModel.value;
      updateConnection();
    }
  }
}

async function loadTextModels() {
  const provider = elements.textProvider.value;
  const requestId = ++textModelRequestId;
  elements.textGenerationModel.disabled = true;
  elements.textGenerationModel.replaceChildren(new Option("正在读取可用模型…", ""));
  try {
    const response = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
    const data = await response.json();
    if (requestId !== textModelRequestId) return;
    if (!response.ok) throw new Error(data.error || "模型列表读取失败。");
    elements.textGenerationModel.replaceChildren();
    if (!data.configured) {
      elements.textGenerationModel.append(new Option("尚未配置", data.defaultModel || ""));
      elements.textGenerationModel.disabled = true;
      return;
    }
    const models = data.models?.length ? data.models : [data.defaultModel].filter(Boolean);
    models.forEach((model) => elements.textGenerationModel.append(new Option(model, model)));
    const restoredModel = restoredWorkspaceState?.text?.provider === provider && !restoredTextModelApplied
      ? restoredWorkspaceState.text.model
      : "";
    const savedModel = provider === "gemini" && restoredModel === "gemini-3.6-flash"
      ? data.defaultModel
      : restoredModel;
    elements.textGenerationModel.value = models.includes(savedModel)
      ? savedModel
      : models.includes(data.defaultModel) ? data.defaultModel : models[0] || "";
    restoredTextModelApplied = true;
    elements.textGenerationModel.disabled = models.length === 0;
  } catch (error) {
    if (requestId !== textModelRequestId) return;
    elements.textGenerationModel.replaceChildren(new Option("模型列表读取失败", ""));
    elements.textGenerationError.textContent = error.message;
    elements.textGenerationError.hidden = false;
  }
}

function restoreWorkspaceState() {
  if (!restoredWorkspaceState) return;
  const story = restoredWorkspaceState.story || {};
  const text = restoredWorkspaceState.text || {};

  elements.script.value = story.script || "";
  elements.durationSeconds.value = story.durationSeconds || "60";
  elements.requirements.value = story.requirements || "";
  elements.taskCount.value = story.taskCount || "";
  if (story.provider && elements.modelProvider.querySelector(`option[value="${story.provider}"]`)) {
    elements.modelProvider.value = story.provider;
  }
  if (story.status) {
    elements.storyStatus.textContent = story.status;
    elements.storyStatus.hidden = false;
  }
  if (story.result?.storyboard && Array.isArray(story.result.tasks)) {
    currentTitle = story.result.title || "";
    currentStoryboard = story.result.storyboard;
    currentTasks = story.result.tasks;
    elements.storyboardOutput.value = currentStoryboard;
    renderTaskItems(elements.taskList, currentTasks);
    elements.summary.textContent = story.result.summary || "上次生成的分镜与任务";
    elements.empty.hidden = true;
    elements.loading.hidden = true;
    elements.storyboardResult.hidden = false;
    elements.summary.hidden = false;
    elements.resultActions.hidden = false;
    elements.taskList.hidden = false;
  }

  if (text.provider && elements.textProvider.querySelector(`option[value="${text.provider}"]`)) {
    elements.textProvider.value = text.provider;
  }
  elements.textSource.value = text.source || "";
  const hasVersionedOriginal = typeof text.originalOutput === "string";
  currentOriginalOutput = text.originalOutput || text.output || text.replicaOutput || "";
  currentOriginalMeta = text.originalMeta || text.outputMeta || text.replicaMeta || "";
  currentReplicaOutput = hasVersionedOriginal ? (text.replicaOutput || "") : "";
  currentReplicaMeta = hasVersionedOriginal ? (text.replicaMeta || "") : "";
  currentRemixOutput = text.remixOutput || "";
  currentRemixMeta = text.remixMeta || "";
  currentStoryVersion = ["original", "replica", "remix"].includes(text.storyVersion) ? text.storyVersion : "original";
  if (currentOriginalOutput || currentReplicaOutput || currentRemixOutput) {
    elements.textOutputLoading.hidden = true;
    selectStoryVersion(currentStoryVersion, { sync: false });
  }
  if (text.taskResult?.storyboard && Array.isArray(text.taskResult.tasks)) {
    currentTextStoryboard = text.taskResult.storyboard;
    currentTextTasks = text.taskResult.tasks;
    elements.textTaskStoryboardOutput.value = currentTextStoryboard;
    renderTaskItems(elements.textTaskList, currentTextTasks);
    elements.textTaskSummary.textContent = text.taskResult.summary || "上次生成的分镜与任务";
    elements.textResultTabs.hidden = false;
  }
  if (currentOriginalOutput || currentReplicaOutput || currentRemixOutput) {
    switchTextResult(text.selectedView === "tasks" ? "tasks" : "replica");
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  requestTasks("/api/generate");
});
elements.preview.addEventListener("click", () => requestTasks("/api/preview"));
elements.modelProvider.addEventListener("change", () => {
  loadModels();
  queueWorkspaceSave();
});
elements.textModel.addEventListener("change", () => {
  updateConnection();
  queueWorkspaceSave();
});
elements.script.addEventListener("input", () => {
  updateEstimate();
  queueWorkspaceSave();
});
elements.durationSeconds.addEventListener("input", () => {
  updateEstimate();
  queueWorkspaceSave();
});
elements.taskCount.addEventListener("input", () => {
  updateEstimate();
  queueWorkspaceSave();
});
elements.requirements.addEventListener("input", queueWorkspaceSave);
elements.durationPresets.forEach((button) => {
  button.addEventListener("click", () => {
    elements.durationSeconds.value = button.dataset.seconds;
    updateEstimate();
    queueWorkspaceSave();
  });
});
elements.copyStoryboard.addEventListener("click", () => copyText(currentStoryboard, "完整分镜已复制"));
elements.copyAll.addEventListener("click", () => copyText(currentTasks.map(taskAsText).join("\n\n"), "全部任务已复制"));
elements.download.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ title: currentTitle, storyboardMarkdown: currentStoryboard, tasks: currentTasks }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `分镜任务-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});
elements.videoDownloadForm.addEventListener("submit", requestVideoDownload);
elements.videoDownloadLink.addEventListener("click", openVideoDownloadsFolder);
elements.textGenerationForm.addEventListener("submit", requestTextGeneration);
elements.textRandomStory.addEventListener("click", requestRandomStoryFromReplica);
elements.textPromptSelect.addEventListener("change", () => {
  updateTextPromptPreview();
  queueWorkspaceSave();
});
elements.textProvider.addEventListener("change", () => {
  loadTextModels();
  queueWorkspaceSave();
});
elements.textGenerationModel.addEventListener("change", queueWorkspaceSave);
elements.textSource.addEventListener("input", queueWorkspaceSave);
elements.textOutput.addEventListener("input", () => {
  updateCastSelection(detectFixedCastMode(elements.textOutput.value));
  queueWorkspaceSave();
});
elements.textVideo.addEventListener("change", updateTextVideo);
elements.removeTextVideo.addEventListener("click", removeTextVideo);
elements.copyTextOutput.addEventListener("click", () => copyText(elements.textOutput.value, "生成结果已复制"));
elements.remixTextOutput.addEventListener("click", requestStoryRemix);
elements.castOptions.forEach((button) => {
  button.addEventListener("click", () => requestFixedCastChange(button.dataset.castMode));
});
elements.textResultTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    switchTextResult(button.dataset.resultView);
    queueWorkspaceSave();
  });
});
elements.textVersionTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectStoryVersion(button.dataset.storyVersion);
    saveWorkspaceState();
  });
});
elements.copyTextStoryboard.addEventListener("click", () => copyText(currentTextStoryboard, "完整分镜已复制"));
elements.copyTextTasks.addEventListener("click", () => copyText(currentTextTasks.map(taskAsText).join("\n\n"), "全部任务已复制"));
elements.toolTabs.forEach((button) => {
  button.addEventListener("click", () => {
    switchTool(button.dataset.view);
    window.scrollTo({ top: 0 });
  });
});
document.querySelectorAll("[data-open-view]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    switchTool(link.dataset.openView);
    window.scrollTo({ top: 0 });
  });
});
const demoShots = [
  { image: "/assets/story-morning.jpg", number: "01", type: "全景 · 故事开场", caption: "平凡的日常，也藏着故事的开场。", position: "center 50%", alt: "暖粉色卧室中的猫咪短剧开场示例画面" },
  { image: "/assets/story-home.jpg", number: "02", type: "中景 · 缓缓推进", caption: "回到家，就回到了柔软的世界。", position: "60% 58%", alt: "主人在家中陪伴两只猫咪的短剧示例画面" },
  { image: "/assets/story-home.jpg", number: "03", type: "特写 · 猫咪视角", caption: "幸福，不过是被认真陪伴的小事。", position: "95% 65%", alt: "两只猫咪得到主人陪伴的特写示例画面" }
];
document.querySelectorAll("[data-demo-shot]").forEach((button) => {
  button.addEventListener("click", () => {
    const shot = demoShots[Number(button.dataset.demoShot)];
    const image = document.querySelector("#home-demo-image");
    image.src = shot.image;
    image.alt = shot.alt;
    image.style.objectPosition = shot.position;
    image.style.transform = button.dataset.demoShot === "2" ? "scale(1.45)" : "none";
    image.style.transformOrigin = "85% 65%";
    document.querySelector("#home-demo-number").textContent = shot.number;
    document.querySelector("#home-demo-type").textContent = shot.type;
    document.querySelector("#home-demo-caption").textContent = shot.caption;
    document.querySelectorAll("[data-demo-shot]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  });
});
window.addEventListener("pagehide", saveWorkspaceState);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveWorkspaceState();
});
initApiSettings({
  getProvider: (view) => (view === "text" || (!view && !elements.textWorkspace.hidden)) ? elements.textProvider.value : elements.modelProvider.value,
  onSaved: async () => {
    await Promise.allSettled([loadStatus(), loadTextModels()]);
    queueWorkspaceSave();
  }
});
restoreWorkspaceState();
updateEstimate();
loadStatus();
function viewFromHash() {
  if (["#text-generation", "#shot-recreation"].includes(location.hash)) return "text";
  if (["#storyboard-tasks", "#shot-recreation-tasks"].includes(location.hash)) return "story";
  if (location.hash === "#video-download") return "download";
  return "home";
}
window.addEventListener("hashchange", () => {
  // Section links stay on the introduction page; tool links select their workspace.
  if (location.hash !== "#home-workflow") switchTool(viewFromHash());
});
switchTool(viewFromHash());
