import { createServer } from "node:http";
import { setDefaultResultOrder } from "node:dns";

// 直连 Gemini 时避免解析到 IPv6 被 RST
setDefaultResultOrder("ipv4first");

// Gemini 请求走本地代理（直连 Google 时通时断；配置 GEMINI_PROXY 后由代理稳定转发）
// 注意：必须用 undici 自带的 fetch，Node 内置 fetch 不接受外部 undici 的 dispatcher
import { fetch as undiciFetch, ProxyAgent } from "undici";
const geminiProxyDispatcher = process.env.GEMINI_PROXY ? new ProxyAgent(process.env.GEMINI_PROXY) : undefined;
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, join, normalize } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { needsTranslation, translateInput } from "./chinese-input.mjs";
import { createApiConfigStore, validateSettingsRequest } from "./api-config.mjs";
import { buildStoryboardPrompt } from "./storyboard-prompt.mjs";

const root = fileURLToPath(new URL("./public", import.meta.url));
const downloadsDir = fileURLToPath(new URL("./downloads", import.meta.url));
const promptLibraryPath = fileURLToPath(new URL("./data/prompts.json", import.meta.url));
const port = Number(process.env.PORT || 4173);
const apiConfig = await createApiConfigStore(process.env.API_CONFIG_PATH || fileURLToPath(new URL("./data/api-config.json", import.meta.url)));
const maxBodyBytes = 1_000_000;
const maxVideoBytes = 95 * 1024 * 1024;
const maxMultipartBodyBytes = maxVideoBytes + 2 * 1024 * 1024;
const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const cobaltApiUrl = process.env.COBALT_API_URL || "http://127.0.0.1:9000/";
const downloadFiles = new Map();
const downloadJobs = new Map();
const allowedVideoHosts = [
  "youtube.com", "youtu.be", "douyin.com", "iesdouyin.com", "bilibili.com", "b23.tv",
  "x.com", "twitter.com", "instagram.com", "tiktok.com", "facebook.com", "fb.watch",
  "kuaishou.com", "kwai.com", "xiaohongshu.com", "xhslink.com", "xhslink.cn"
];
const supportedVideoMimeTypes = new Set([
  "video/mp4", "video/mpeg", "video/quicktime", "video/x-msvideo", "video/webm",
  "video/x-flv", "video/x-ms-wmv", "video/3gpp"
]);
const cobaltVideoHosts = [
  "youtube.com", "youtu.be", "bilibili.com", "b23.tv", "x.com", "twitter.com",
  "instagram.com", "tiktok.com", "facebook.com", "fb.watch", "vimeo.com",
  "pinterest.com", "reddit.com", "redd.it", "twitch.tv", "snapchat.com"
];
const douyinVideoHosts = ["douyin.com", "iesdouyin.com"];
const mobileDouyinUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

const storyboardSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "纯中文故事标题，不超过20个汉字，不得出现英文字母" },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer", description: "从1开始的连续镜号" },
          visual: { type: "string", description: "以【景别或运镜】开头的纯中文可视化画面描述，不得出现英文字母" },
          dialogue: { type: "string", description: "有台词锁定清单时只写 D1、D2 等编号，多个编号用逗号分隔；没有台词时写无" }
        },
        required: ["number", "visual", "dialogue"]
      }
    }
  },
  required: ["title", "shots"]
};

const funnyStorySchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "短、口语化并保留悬念的标题，不超过20个汉字" },
    oneSentence: { type: "string", description: "人物、反常目标、最大阻碍和情绪方向组成的一句话故事" },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          time: { type: "string", description: "时间段，例如0—3秒" },
          beat: { type: "string", description: "本段功能，例如冷开场、第一次翻转" },
          action: { type: "string", description: "可直接拍摄的场景、动作、表情和可见结果" },
          dialogue: { type: "string", description: "完整短对白，使用角色：台词格式；多句用换行分隔" }
        },
        required: ["time", "beat", "action", "dialogue"]
      }
    },
    highlights: {
      type: "object",
      properties: {
        hook: { type: "string" },
        emotion: { type: "string" },
        comment: { type: "string" }
      },
      required: ["hook", "emotion", "comment"]
    }
  },
  required: ["title", "oneSentence", "segments", "highlights"]
};

const adaptedStorySchema = {
  ...funnyStorySchema,
  properties: {
    ...funnyStorySchema.properties,
    originality: {
      type: "object",
      properties: {
        newScene: { type: "string", description: "与原故事不同的新场景" },
        newGoal: { type: "string", description: "与原故事不同的新人物目标" },
        newConflict: { type: "string", description: "与原故事不同的新冲突来源" },
        newProp: { type: "string", description: "与原故事不同的新关键道具" },
        newFirstTurn: { type: "string", description: "与原故事不同的第一次反转因果" },
        newSecondTurn: { type: "string", description: "与原故事不同的第二次反转因果" }
      },
      required: ["newScene", "newGoal", "newConflict", "newProp", "newFirstTurn", "newSecondTurn"]
    }
  },
  required: [...funnyStorySchema.required, "originality"]
};

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function updateDownloadJob(jobId, patch) {
  const job = downloadJobs.get(jobId);
  if (!job) return;
  const nextPercent = Number.isFinite(patch.percent)
    ? Math.max(job.percent || 0, Math.min(100, Math.round(patch.percent)))
    : job.percent;
  downloadJobs.set(jobId, { ...job, ...patch, percent: nextPercent, updatedAt: Date.now() });
}

function startDownloadJob(body) {
  const jobId = randomUUID();
  downloadJobs.set(jobId, {
    status: "running",
    phase: "正在检查链接",
    detail: "准备下载任务…",
    percent: 2,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const report = (progress) => updateDownloadJob(jobId, progress);
  downloadVideo(body, report)
    .then((result) => {
      updateDownloadJob(jobId, {
        status: "complete",
        phase: "下载完成",
        detail: "视频已准备好保存到电脑",
        percent: 100,
        result
      });
    })
    .catch((error) => {
      updateDownloadJob(jobId, {
        status: "failed",
        phase: "下载失败",
        detail: error.message,
        error: error.message
      });
    });
  setTimeout(() => downloadJobs.delete(jobId), 60 * 60 * 1000).unref();
  return jobId;
}

async function readPromptLibrary() {
  try {
    const data = JSON.parse(await readFile(promptLibraryPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("提示词库读取失败，请检查本地数据文件。");
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("脚本超过 1 MB，请缩短后再试。");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求内容不是有效的 JSON。");
  }
}

async function readMultipartForm(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data;")) throw new Error("视频提交格式不正确，请刷新页面后重试。");
  const declaredSize = Number(request.headers["content-length"] || 0);
  if (declaredSize > maxMultipartBodyBytes) throw new Error("视频超过 95 MB，请先压缩后再上传。");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxMultipartBodyBytes) throw new Error("视频超过 95 MB，请先压缩后再上传。");
    chunks.push(chunk);
  }
  const formData = await new Response(Buffer.concat(chunks), {
    headers: { "content-type": contentType }
  }).formData();
  const videoFile = formData.get("video");
  let video = null;
  if (videoFile && typeof videoFile.arrayBuffer === "function" && videoFile.size > 0) {
    if (videoFile.size > maxVideoBytes) throw new Error("视频超过 95 MB，请先压缩后再上传。");
    if (!supportedVideoMimeTypes.has(videoFile.type)) throw new Error("不支持这个视频格式，请使用 MP4、MOV、AVI 或 WebM。");
    video = {
      name: basename(videoFile.name || "参考视频"),
      mimeType: videoFile.type,
      buffer: Buffer.from(await videoFile.arrayBuffer())
    };
  }
  return {
    input: String(formData.get("input") || ""),
    promptId: String(formData.get("promptId") || ""),
    provider: String(formData.get("provider") || ""),
    model: String(formData.get("model") || ""),
    video
  };
}

function extractShots(script) {
  const rows = [];
  const pattern = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/gm;
  let match;
  while ((match = pattern.exec(script)) !== null) {
    rows.push({ number: Number(match[1]), visual: match[2], dialogue: match[3] });
  }
  return rows;
}

function cleanMarkdown(text) {
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function containsDisallowedEnglish(text, allowCoco = false) {
  const checked = allowCoco ? String(text || "").replace(/\bcoco\b/gi, "") : String(text || "");
  return /[A-Za-z]/.test(checked);
}

const nonSpeakerLabels = /^(?:音频|音效|音乐|画面|镜头|运镜|景别|场景|动作|表情|构图|道具|材质|风格|色彩|光照|物理动力学|physics|style|lighting|bokeh|subsurface|facial|camera|render|texture|时间|节奏|核心|主题|说明|提示词|输出|输入|对白|台词|seedance)/i;

function normalizeDialogueSpeaker(value) {
  return String(value || "")
    .replace(/[\[\]【】#*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:说道|说|问道|问|喊道|喊|回答|答道|嘀咕)$/u, "")
    .trim();
}

function extractLockedDialogues(script) {
  const dialogues = [];
  const addDialogue = (speakerValue, textValue, openingQuote = "", closingQuote = "") => {
    const speaker = normalizeDialogueSpeaker(speakerValue);
    const text = String(textValue || "").trim();
    if (!speaker || /^第[一二三四五六七八九十百\d]+[幕章节场]/u.test(speaker) || nonSpeakerLabels.test(speaker) || containsDisallowedEnglish(speaker, true) || !text) return;
    dialogues.push({
      id: `D${dialogues.length + 1}`,
      rendered: `${speaker}：${openingQuote}${text}${closingQuote}`
    });
  };

  // 复刻分镜常把说话人写在“台词（角色）”标签里，语气说明位于引号前。
  // 同一行可能连续放两句台词，必须逐句、按原顺序锁定。
  const labelledLinePattern = /台词（([^）\n]+)）\s*[：:]\s*\*?\s*([^\n]*)/gmu;
  let match;
  while ((match = labelledLinePattern.exec(script)) !== null) {
    const speaker = match[1].trim();
    const quotePattern = /([“"「『])([^”"」』\n]{1,500})([”"」』])/gu;
    let quoteMatch;
    while ((quoteMatch = quotePattern.exec(match[2])) !== null) {
      addDialogue(speaker, quoteMatch[2], quoteMatch[1], quoteMatch[3]);
    }
  }

  const quotedPattern = /(?:^|[\n|。！？；;：:】\]])\s*(?:[-*]\s*)?([A-Za-z\u3400-\u9fff][A-Za-z0-9\u3400-\u9fff·（）()_\- ]{0,30})\s*[：:]\s*([“"「『])([^”"」』\n]{1,500})([”"」』])/gmu;
  while ((match = quotedPattern.exec(script)) !== null) {
    addDialogue(match[1], match[3], match[2], match[4]);
  }

  const linePattern = /^\s*(?:[-*]\s*)?([A-Za-z\u3400-\u9fff][A-Za-z0-9\u3400-\u9fff·（）()_\- ]{0,30})\s*[：:]\s*([^\n]{1,500})$/gmu;
  while ((match = linePattern.exec(script)) !== null) {
    if (/[“"「『”」』]/u.test(match[2])) continue;
    addDialogue(match[1], match[2]);
  }
  return dialogues;
}

function sanitizeSourceLine(value, allowCoco = false) {
  const protectedCoco = "\uE000";
  let text = cleanMarkdown(String(value || ""))
    .replace(/Coco/gi, protectedCoco)
    .replace(/Subsurface Scattering/gi, "次表面散射")
    .replace(/Facial Performance/gi, "面部表演")
    .replace(/Dolly Zoom/gi, "推拉变焦")
    .replace(/Slow[- ]motion/gi, "慢动作")
    .replace(/Medium Shot/gi, "中景")
    .replace(/Close[- ]up/gi, "特写")
    .replace(/Pixar[- ]style/gi, "皮克斯风格")
    .replace(/J[- ]cut/gi, "声音先入")
    .replace(/3D/gi, "三维")
    .replace(/[A-Za-z][A-Za-z0-9'’._/-]*/g, "")
    .replaceAll(protectedCoco, allowCoco ? "Coco" : "")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/\s+([，。；：！？、])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function formatStructuredSourceStoryboard(script, totalShots) {
  const headingPattern = /^#{1,6}\s*镜头\s*(\d+)\s*[：:]\s*([^\n]*)$/gmu;
  const headings = [...script.matchAll(headingPattern)];
  if (headings.length < 2 || headings.length < totalShots) return null;
  const allowCoco = /coco|蓝白长毛/i.test(script);
  const sourceShots = headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? script.length;
    const section = script.slice(start, end);
    const visualParts = [];
    for (const rawLine of section.split("\n")) {
      const line = rawLine.replace(/^\s*(?:[-*]>?|>)\s*/, "").replace(/^\*+\s*/, "").trim();
      if (!line || /^画面\s*Prompt\s*[：:]/iu.test(line) || /^音频轨\s*[：:]/u.test(line) || /^台词（/u.test(line)) continue;
      if (/^>/u.test(rawLine.trim())) continue;
      const cleaned = sanitizeSourceLine(line, allowCoco);
      if (cleaned && /[\u3400-\u9fff]/u.test(cleaned)) visualParts.push(cleaned);
    }
    return {
      sourceNumber: Number(heading[1]),
      sourceTitle: sanitizeSourceLine(heading[2], allowCoco),
      visual: visualParts.join(" "),
      dialogues: extractLockedDialogues(section).map((item) => item.rendered)
    };
  });

  const shots = [];
  for (let index = 0; index < totalShots; index += 1) {
    const start = Math.floor((index * sourceShots.length) / totalShots);
    const end = Math.floor(((index + 1) * sourceShots.length) / totalShots);
    const group = sourceShots.slice(start, end);
    const range = group.length === 1
      ? `原镜头${group[0].sourceNumber}`
      : `原镜头${group[0].sourceNumber}至${group.at(-1).sourceNumber}`;
    const visual = group.map((shot) => {
      const title = shot.sourceTitle ? `（${shot.sourceTitle}）` : "";
      return `原镜头${shot.sourceNumber}${title}：${shot.visual}`;
    }).join(" ");
    shots.push({
      number: index + 1,
      visual: `【${range}，按原顺序】${visual}`,
      dialogue: group.flatMap((shot) => shot.dialogues).join("\n") || "无"
    });
  }
  return {
    title: "原分镜无损整理",
    shots,
    dialogueLockCount: sourceShots.reduce((total, shot) => total + shot.dialogues.length, 0),
    chineseOnly: true,
    losslessFormat: true
  };
}

function formatTaskPrompt(group) {
  const first = group[0].number;
  const last = group.at(-1).number;
  const body = group
    .map((shot) => `${cleanMarkdown(shot.visual)} 配音台词：${cleanMarkdown(shot.dialogue)}`)
    .join(" ");
  return `【分镜${first}-${last}：${body}】`;
}

function formatStoryboardMarkdown(shots) {
  const escapeCell = (value) => cleanMarkdown(value).replace(/\|/g, "｜");
  const rows = shots.map((shot) => `| **${shot.number}** | ${escapeCell(shot.visual)} | ${escapeCell(shot.dialogue)} |`);
  return ["| 镜号 | 画面提示词 | 配音台词 |", "|---|---|---|", ...rows].join("\n");
}

function createTimingPlan(durationSeconds, existingShotCount = 0, taskCountOverride = 0) {
  const automaticTaskCount = Math.max(1, Math.ceil(durationSeconds / 10));
  const requestedTaskCount = taskCountOverride || automaticTaskCount;
  const totalShots = existingShotCount || Math.max(requestedTaskCount, Math.round(durationSeconds / 2));
  const taskCount = Math.min(totalShots, requestedTaskCount);
  const shotsPerTask = Math.max(1, Math.ceil(totalShots / taskCount));
  return {
    durationSeconds,
    totalShots,
    shotsPerTask,
    taskCount,
    averageShotSeconds: Number((durationSeconds / totalShots).toFixed(1)),
    averageTaskSeconds: Number((durationSeconds / taskCount).toFixed(1))
  };
}

function validateDuration(value) {
  const durationSeconds = Number(value);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 180) {
    throw new Error("视频秒数需要是 5—180 之间的整数。");
  }
  return durationSeconds;
}

function validateTaskCount(value) {
  if (value === undefined || value === null || value === "") return 0;
  const taskCount = Number(value);
  if (!Number.isInteger(taskCount) || taskCount < 1 || taskCount > 30) {
    throw new Error("任务数需要是 1—30 之间的整数，或留空自动计算。");
  }
  return taskCount;
}

function validateModelSelection(body) {
  const provider = typeof body.provider === "string" ? body.provider : "gemini";
  if (!["gemini", "openai", "deepseek"].includes(provider)) throw new Error("不支持这个模型服务商。");
  const fallbackModel = { gemini: apiConfig.get("gemini").defaultModel, openai: apiConfig.get("openai").defaultModel, deepseek: apiConfig.get("deepseek").defaultModel }[provider];
  const selectedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : fallbackModel;
  if (!/^[a-zA-Z0-9._:-]{2,120}$/.test(selectedModel)) throw new Error("模型名称格式不正确。");
  if (provider === "gemini" && !apiConfig.get("gemini").apiKey) throw new Error("尚未配置 GEMINI_API_KEY，请切换到已配置的服务商或先填写密钥。");
  if (provider === "openai" && !apiConfig.get("openai").apiKey) throw new Error("尚未配置 OPENAI_API_KEY，请点击“配置 API”填写密钥。");
  if (provider === "deepseek" && !apiConfig.get("deepseek").apiKey) throw new Error("尚未配置 DEEPSEEK_API_KEY，请点击“配置 API”填写密钥。");
  return { provider, model: selectedModel };
}

function extractVideoUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = text.match(/https?:\/\/[^\s]+/i);
  if (!match) throw new Error("请粘贴包含 http 或 https 的公开视频链接。");
  const cleaned = match[0].replace(/[）)\]】>，,。.!！?？;；'\"]+$/g, "");
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    throw new Error("没有识别到有效的视频链接。");
  }
  if (url.username || url.password) throw new Error("链接中不能包含账号或密码。");
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const allowed = allowedVideoHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  if (!allowed) throw new Error("暂时支持抖音、B站、YouTube、X、Instagram、TikTok、Facebook、快手和小红书的公开视频链接。");
  return url.href;
}

function runDownloader(args, report = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let progressBuffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("下载等待超过 10 分钟，已停止本次任务。"));
    }, 10 * 60 * 1000);

    const captureProgress = (chunk) => {
      progressBuffer = `${progressBuffer}${chunk}`.slice(-8_000);
      const matches = [...progressBuffer.matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)];
      const latest = matches.at(-1);
      if (latest) {
        const sourcePercent = Number(latest[1]);
        report({
          phase: "正在下载视频",
          detail: `已获取 ${Math.round(sourcePercent)}%`,
          percent: 10 + sourcePercent * 0.82
        });
        progressBuffer = progressBuffer.slice(-500);
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-40_000);
      captureProgress(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-40_000);
      captureProgress(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("本地视频下载工具无法启动。"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const log = `${stdout}\n${stderr}`;
      if (/requested format (?:is )?not available|no video formats found/i.test(log)) {
        return reject(new Error("该视频没有符合所选清晰度的可用格式，请选择“最高可用”重试。"));
      }
      if (/failed to parse json[\s\S]*fresh cookies/i.test(log)) {
        return reject(new Error("浏览器登录状态正常，但抖音当前阻止了下载器读取视频数据。请先在浏览器打开该视频，再使用浏览器辅助下载。"));
      }
      if (/login|cookies|sign in|authentication|账号|登录/i.test(log)) {
        return reject(new Error("该视频需要登录或账号权限；后台已尝试读取 Chrome 登录状态，但未获得可用权限。"));
      }
      if (/private|not available|unavailable|removed|copyright|私密|不可用/i.test(log)) {
        return reject(new Error("该视频可能已删除、设为私密、受地区或版权限制，无法下载。"));
      }
      if (/unsupported url|no suitable extractor/i.test(log)) {
        return reject(new Error("暂时无法解析这个链接，可能是平台页面结构已经变化。"));
      }
      if (/larger than max-filesize|maximum file size/i.test(log)) {
        return reject(new Error("视频文件超过 1 GB，已停止下载。"));
      }
      reject(new Error("视频下载失败。请确认链接能公开播放后再试。"));
    });
  });
}

function hostMatches(hostname, hosts) {
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, "");
  return hosts.some((host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`));
}

function safeMediaFilename(value, fallback = "video.mp4") {
  const original = typeof value === "string" ? basename(value) : fallback;
  const cleaned = original.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 160);
  return cleaned || fallback;
}

function formatProgressBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

async function saveRemoteMedia(mediaUrl, filePath, onProgress = () => {}) {
  const target = new URL(mediaUrl);
  const isLocalCobalt = target.protocol === "http:" && target.hostname === "127.0.0.1" && target.port === "9000";
  if (target.protocol !== "https:" && !isLocalCobalt) throw new Error("备用引擎返回了不安全的下载地址。");

  const response = await fetch(target, {
    headers: isLocalCobalt ? {} : { referer: "https://www.douyin.com/", "user-agent": mobileDouyinUserAgent },
    signal: AbortSignal.timeout(10 * 60 * 1000)
  });
  if (!response.ok || !response.body) throw new Error(`备用引擎下载失败（${response.status}）。`);
  const declaredSize = Number(response.headers.get("content-length") || response.headers.get("estimated-content-length") || 0);
  if (declaredSize > 1024 * 1024 * 1024) throw new Error("视频文件超过 1 GB，已停止下载。");

  let received = 0;
  let lastReportedPercent = -1;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > 1024 * 1024 * 1024) return callback(new Error("视频文件超过 1 GB，已停止下载。"));
      const percent = declaredSize ? Math.min(100, received / declaredSize * 100) : 0;
      const rounded = Math.floor(percent);
      if (rounded !== lastReportedPercent) {
        lastReportedPercent = rounded;
        onProgress({ received, total: declaredSize, percent });
      }
      callback(null, chunk);
    }
  });
  const partPath = `${filePath}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(partPath, { flags: "wx" }));
    await rename(partPath, filePath);
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  }
}

function findAwemeItem(routerData, awemeId) {
  const queue = [routerData];
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < 100_000) {
    const value = queue.shift();
    visited += 1;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const itemId = value.aweme_id ?? value.awemeId;
    if (String(itemId ?? "") === awemeId && value.video?.play_addr) return value;
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return null;
}

async function downloadViaDouyinChrome(url, quality, prefix, report = () => {}) {
  report({ phase: "正在用浏览器解析", detail: "识别抖音视频地址…", percent: 18 });
  const redirectResponse = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": mobileDouyinUserAgent, accept: "text/html" },
    signal: AbortSignal.timeout(30_000)
  });
  const longUrl = redirectResponse.url || url;
  const idMatch = longUrl.match(/\/(?:video|note|slides)\/(\d+)/) || longUrl.match(/[?&](?:aweme_id|modal_id|item_ids)=(\d+)/);
  if (!idMatch) throw new Error("无法从抖音链接中识别视频编号。");
  const awemeId = idMatch[1];

  const puppeteer = await import("puppeteer-core");
  const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: chromePath,
    timeout: 30_000,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-extensions"]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(mobileDouyinUserAgent);
    let item = null;

    // 先访问 note 再访问 video，可让真实 Chrome 完成抖音 WAF 挑战并保留会话。
    // 该策略参考 MIT 开源项目 xlongDev/shiying 的浏览器兜底思路。
    for (const kind of ["note", "video"]) {
      report({ phase: "正在用浏览器解析", detail: "读取视频页面…", percent: kind === "note" ? 22 : 28 });
      await page.goto(`https://www.iesdouyin.com/share/${kind}/${awemeId}/`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const rawRouterData = await page.evaluate(() => {
        const pageWindow = window;
        if (pageWindow._ROUTER_DATA) return JSON.stringify(pageWindow._ROUTER_DATA);
        for (const script of document.scripts) {
          const text = script.textContent || "";
          const marker = text.indexOf("_ROUTER_DATA");
          if (marker < 0) continue;
          const equals = text.indexOf("=", marker);
          const start = text.indexOf("{", equals);
          if (start < 0) continue;
          let depth = 0;
          for (let index = start; index < text.length; index += 1) {
            if (text[index] === "{") depth += 1;
            if (text[index] === "}" && --depth === 0) return text.slice(start, index + 1);
          }
        }
        return null;
      });
      if (!rawRouterData) continue;
      try {
        item = findAwemeItem(JSON.parse(rawRouterData), awemeId);
      } catch {
        item = null;
      }
      if (item) break;
    }

    const playAddress = item?.video?.play_addr || {};
    const sourceUrl = Array.isArray(playAddress.url_list) ? playAddress.url_list.find((entry) => typeof entry === "string") : "";
    if (!sourceUrl) throw new Error("真实浏览器已打开抖音，但没有读取到目标视频地址。");
    let mediaUrl = sourceUrl.replace("/playwm/", "/play/").replace("playwm", "play");
    if (quality !== "best") mediaUrl = mediaUrl.replace(/([?&]ratio=)[^&]+/i, `$1${quality}p`);
    const title = safeMediaFilename(`${String(item.desc || "抖音视频").replace(/#[^#\s]+/g, "").trim()}-${awemeId}.mp4`);
    const outputName = `${prefix}${title}`;
    await saveRemoteMedia(mediaUrl, join(downloadsDir, outputName), ({ received, total, percent }) => {
      report({
        phase: "正在下载视频",
        detail: total ? `${formatProgressBytes(received)} / ${formatProgressBytes(total)}` : `已获取 ${formatProgressBytes(received)}`,
        percent: 35 + percent * 0.57
      });
    });
    return outputName;
  } finally {
    await browser.close();
  }
}

async function downloadViaCobalt(url, quality, prefix, report = () => {}) {
  report({ phase: "正在切换备用引擎", detail: "解析视频资源…", percent: 18 });
  const response = await fetch(cobaltApiUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      url,
      videoQuality: quality === "best" ? "max" : quality,
      downloadMode: "auto",
      filenameStyle: "basic",
      localProcessing: "disabled"
    }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`免费备用引擎暂时不可用（${response.status}）。`);
  const result = await response.json();
  let mediaUrl;
  let filename;

  if (result.status === "tunnel" || result.status === "redirect") {
    mediaUrl = result.url;
    filename = safeMediaFilename(result.filename);
  } else if (result.status === "picker") {
    const item = Array.isArray(result.picker)
      ? result.picker.find((entry) => entry?.type === "video" || entry?.type === "gif")
      : null;
    if (!item?.url) throw new Error("该链接包含多项内容，但没有找到可下载的视频。");
    mediaUrl = item.url;
    filename = `video-${Date.now()}.${item.type === "gif" ? "gif" : "mp4"}`;
  } else if (result.status === "error") {
    throw new Error(`免费备用引擎无法解析该链接（${result.error?.code || "未知原因"}）。`);
  } else {
    throw new Error("免费备用引擎返回了暂不支持的媒体格式。");
  }

  const outputName = `${prefix}${filename}`;
  await saveRemoteMedia(mediaUrl, join(downloadsDir, outputName), ({ received, total, percent }) => {
    report({
      phase: "正在下载视频",
      detail: total ? `${formatProgressBytes(received)} / ${formatProgressBytes(total)}` : `已获取 ${formatProgressBytes(received)}`,
      percent: 25 + percent * 0.67
    });
  });
  return outputName;
}

async function downloadVideo(body, report = () => {}) {
  report({ phase: "正在解析链接", detail: "检查平台与清晰度…", percent: 5 });
  const url = extractVideoUrl(body.url);
  const hostname = new URL(url).hostname.toLowerCase();
  const browserCookieArgs = /(^|\.)douyin\.com$/.test(hostname) || /(^|\.)iesdouyin\.com$/.test(hostname)
    ? ["--cookies-from-browser", "chrome"]
    : [];
  const quality = ["720", "1080", "best"].includes(body.quality) ? body.quality : "1080";
  // res 按短边计算清晰度，720×1560 的竖屏视频也属于 720P。
  // 优先所选清晰度；源站只提供更高画质时仍保留可下载的格式。
  const formatSortArgs = quality === "best" ? [] : ["--format-sort", `res:${quality}`];
  const jobId = randomUUID();
  const prefix = `${jobId}-`;
  await mkdir(downloadsDir, { recursive: true });
  try {
    report({ phase: "正在连接视频源", detail: "获取视频信息…", percent: 8 });
    await runDownloader([
      "--no-config",
      "--no-playlist",
      "--newline",
      "--max-filesize", "1G",
      "--socket-timeout", "20",
      "--retries", "2",
      "--fragment-retries", "2",
      ...browserCookieArgs,
      "--ffmpeg-location", ffmpegPath,
      "--format", "bv*+ba/b",
      ...formatSortArgs,
      "--merge-output-format", "mp4",
      "--remux-video", "mp4",
      "--output", join(downloadsDir, `${prefix}%(title).50s-%(id)s.%(ext)s`),
      url
    ], report);
    report({ phase: "正在整理文件", detail: "检查视频与声音…", percent: 94 });
  } catch (primaryError) {
    if (hostMatches(hostname, douyinVideoHosts)) {
      try {
        await downloadViaDouyinChrome(url, quality, prefix, report);
        primaryError = null;
      } catch (fallbackError) {
        throw new Error(`${primaryError.message} 真实浏览器兜底也未能完成：${fallbackError.message}`);
      }
    } else if (!hostMatches(hostname, cobaltVideoHosts)) {
      throw primaryError;
    } else {
      try {
        await downloadViaCobalt(url, quality, prefix, report);
        primaryError = null;
      } catch (fallbackError) {
        throw new Error(`${primaryError.message} 免费备用引擎也未能完成：${fallbackError.message}`);
      }
    }
  }

  const files = (await readdir(downloadsDir)).filter((name) => name.startsWith(prefix) && !name.endsWith(".part"));
  if (!files.length) throw new Error("下载已结束，但没有找到可保存的视频文件。");
  const filename = files[0];
  const filePath = join(downloadsDir, filename);
  const fileStat = await stat(filePath);
  report({ phase: "正在准备保存", detail: formatProgressBytes(fileStat.size), percent: 97 });
  const token = randomUUID();
  const displayFilename = filename.slice(prefix.length);
  downloadFiles.set(token, { filePath, filename: displayFilename });
  return {
    filename: displayFilename,
    size: fileStat.size,
    downloadUrl: `/api/video-file/${token}`
  };
}

async function serveVideoFile(response, token) {
  const item = downloadFiles.get(token);
  if (!item) return sendJson(response, 404, { error: "下载文件不存在或本地服务已经重启。" });
  const fileStat = await stat(item.filePath);
  const safeName = basename(item.filename);
  response.writeHead(200, {
    "content-type": mimeTypes[extname(item.filePath)] || "application/octet-stream",
    "content-length": fileStat.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "cache-control": "private, no-store"
  });
  createReadStream(item.filePath).pipe(response);
}

async function openDownloadsFolder(response) {
  const folderPath = join(homedir(), "Downloads");
  await mkdir(folderPath, { recursive: true });
  const child = spawn("/usr/bin/open", [folderPath], { detached: true, stdio: "ignore" });
  child.unref();
  return sendJson(response, 200, { opened: true });
}

function validateInput(body) {
  const script = typeof body.script === "string" ? body.script.trim() : "";
  const durationSeconds = validateDuration(body.durationSeconds);
  const taskCountOverride = validateTaskCount(body.taskCount);
  const globalRequirements = typeof body.globalRequirements === "string" ? body.globalRequirements.trim() : "";
  if (script.length < 20) throw new Error("脚本内容太短，请粘贴完整脚本。");
  const shots = extractShots(script);
  if (shots.length && taskCountOverride > shots.length) {
    throw new Error(`任务数不能超过已识别的 ${shots.length} 个镜头。`);
  }
  const timingPlan = createTimingPlan(durationSeconds, shots.length, taskCountOverride);
  return { script, globalRequirements, shots, ...timingPlan };
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildFunnyStoryPrompt(durationSeconds, castMode) {
  const theme = randomItem(["工资和存款", "减肥与偷吃", "生日惊喜", "相亲误会", "房租危机", "网购退款", "主人被欺负", "搬家风波", "宠物体检", "丢失的外卖"]);
  const prop = randomItem(["会响的存钱罐", "藏在猫砂里的账单", "被咬破的快递盒", "贴满便签的饭碗", "一只锁住的小木箱", "沾着猫毛的红包", "突然出现的收据", "装满硬币的袜子"]);
  const catAction = randomItem(["像掌柜一样收费", "拖着行李准备离家", "偷偷和陌生人交易", "把主人的东西挂牌出售", "一本正经地召开家庭会议", "用爪印签了一份荒唐协议", "守着门口不让主人出门", "当众揭穿一个谎言"]);
  const seed = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const castRule = castMode === "trio"
    ? `本集固定为三角色：成年主人、金渐层布丁、蓝白长毛Coco。布丁是绝对主角，负责主要行动、关键选择、两次反转和最终解决；Coco只是配角，只能用少量动作或短对白制造误会、提供证据或衬托布丁，不能成为标题中心、幕后主谋、主要受害者或最终解决者。`
    : `本集固定为双角色：成年主人和金渐层布丁。Coco不得出现、不得被提及，也不得用另一只猫替代。`;

  return `你正在执行“臭猫”原创短剧创作规则。生成一篇可供用户先审稿、之后再转换为分镜的完整中文搞笑故事，目标时长约 ${durationSeconds} 秒。

本次随机创作种子：${seed}
随机母题：${theme}
关键道具：${prop}
猫的反常动作：${catAction}

固定创作规则：
1. ${castRule}
2. 角色外形与性格固定：主人是成年人，外貌沿用参考内容，不预设性别；布丁是一只圆脸、绿眼睛、金黄色渐层短毛、胸口和嘴周浅奶油色、微胖短腿的真实比例金渐层猫，聪明、嘴贱、贪吃、贪财但护主；Coco如出现，必须是蓝灰色与白色相间的长毛猫，毛量蓬松、尾巴粗大，性格活泼贪吃。猫可以说话和做轻度拟人动作，但保持真实猫咪身体结构。
3. 除必要的房东、快递员、相亲对象等一次性功能人物外，不得新增常驻人物或其他猫；外部人物不能夺走布丁的主线。
4. 采用“强事件主线40% + 密集喜剧35% + 情绪价值25%”。前3秒同时出现反常画面和未回答的问题，每5—8秒必须新增信息、笑点或风险。
5. 结构必须完整：冷开场 → 明确冲突 → 错误解释 → 证据升级 → 第一次翻转（负责笑）→ 情绪转折 → 第二次翻转（负责护主或情绪）→ 最后动作或台词回扣补刀。
6. 至少两次反转，后一次必须由前文的道具或动作触发，不能突然靠旁白揭晓。情绪至少经历期待、冲突、误判和释放。
7. 台词必须短、口语化、可说；笑点来自人物歪逻辑、身份反差、地位倒置或回旋镖，不堆网络热梗。
8. 关键动作必须能被镜头清楚拍出。最后一句前仍保留一个未知信息，最后一句同时完成笑点或情绪释放。
9. 故事必须原创，不使用任何参考账号专属角色名，不复制现成标题、成套台词、标志性包袱或同一因果链。
10. 按 ${durationSeconds} 秒控制对白和动作总量；用清晰时间段输出完整故事，不写分镜号，也不要输出创作分析。
11. 输出前自行检查钩子、人物欲望、阻碍、变化、双反转、情绪释放、可拍性和角色主次；任何核心项不成立就先重写。

只返回指定结构的数据。`;
}

function resolveCastMode(source, requestedMode) {
  if (["duo", "trio"].includes(requestedMode)) return requestedMode;
  if (/coco|蓝白长毛/i.test(source)) return "trio";
  if (/布丁/.test(source)) return "duo";
  return Math.random() < 0.5 ? "duo" : "trio";
}

function fixedCastLabel(castMode) {
  return castMode === "trio" ? "主人、金渐层布丁、蓝白长毛 Coco（配角）" : "主人、金渐层布丁";
}

function fixedCastTextMatches(text, castMode) {
  const hasFixedLeads = /主人/.test(text) && /布丁/.test(text);
  const hasLegacyRoles = /女主人|男主人|男子|男人|男性|男士|男主角|男主(?!人)|男友|男生|男方|女子|女性|女士|女主角|女主(?!人)/.test(text);
  const hasCoco = /coco|蓝白长毛/i.test(text);
  if (!hasFixedLeads || hasLegacyRoles) return false;
  return castMode === "trio" ? hasCoco : !hasCoco;
}

function buildAdaptedStoryPrompt(source, durationSeconds, castMode) {
  const castRule = castMode === "trio"
    ? "固定角色为成年主人、金渐层布丁和蓝白长毛 Coco。布丁承担主要行动、关键选择、高潮和最终解决；Coco只能用少量动作或短对白制造误会、提供证据或衬托布丁，绝不能成为主角、幕后主谋或最终解决者。"
    : "固定角色只有成年主人和金渐层布丁。Coco和其他猫不得出现或被提及；布丁承担主要行动、关键选择、高潮和最终解决。";
  return `把参考内容二创成一篇可直接拍摄、约 ${durationSeconds} 秒的原创中文搞笑短剧故事，之后还要继续生成分镜。

硬性规则：
1. ${castRule}
2. 必须逐节点保留参考内容的叙事骨架：核心事件节点数量、先后顺序、人物之间的动作—回应关系、升级轮数、反转位置和结尾回扣功能都不能改变；不得新增、合并、删除或调换核心节点。
3. 主人是成年人，外貌沿用参考内容，不预设性别；布丁是圆脸绿眼、金黄色渐层短毛、胸口和嘴周浅奶油色、微胖短腿的真实比例金渐层，聪明、嘴贱、贪吃、贪财但护主；Coco如出现，必须是蓝灰与白色相间、毛量蓬松、尾巴粗大的长毛猫。
4. 猫可以说话和做轻度拟人动作，但始终保持真实猫咪身体结构。外部功能人物可以少量出现，但不能夺走布丁主线。
5. 开场钩子、冲突建立、每次加码、最高点、情绪反转和结尾补刀，要分别与参考内容中的对应节点一一映射。如果参考内容是“提出小成果 → 对方抬高标准 → 成果升级 → 再抬高标准 → 荒诞最大成果 → 感情大于成果 → 回应”，新故事必须保留同样轮数和关系。
6. 只更换故事表层：主题领域、具体场景、目标名目、道具、动作表现、笑料意象和全部台词。不能照抄原句、长句或只做近义替换；新元素之间必须形成合理的新因果链。
7. 反转的功能和出现位置必须保留，但触发反转的具体物件、证据、误会或行动必须换新。角色的情绪变化速度也要与参考内容一致。
8. 台词短、口语化、可表演；动作必须可视化。按 ${durationSeconds} 秒控制内容量，不写分镜号，不输出分析。
9. 生成前在内部制作“原节点 → 新节点”逐项映射并自检，但不要输出映射表。若用一句话概括后发现新故事的事件顺序或升级关系与参考内容不同，必须重写；若只是换角色名、道具名或近义词，也必须重写。

参考内容：
${source}

只返回指定结构的数据。`;
}

function inferAdaptedStoryDuration(source) {
  let maximumSeconds = 0;
  for (const match of source.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    maximumSeconds = Math.max(maximumSeconds, Number(match[1]) * 60 + Number(match[2]));
  }
  for (const match of source.matchAll(/(?:^|\D)(\d{1,3})(?:\s*[—–-]\s*\d{1,3})?\s*秒/g)) {
    const values = match[0].match(/\d{1,3}/g)?.map(Number) || [];
    maximumSeconds = Math.max(maximumSeconds, ...values);
  }
  return Math.min(180, Math.max(5, maximumSeconds || 60));
}

function creativeFingerprint(text) {
  return text
    .toLowerCase()
    .replace(/[男女]?主人|布丁|coco|金渐层|蓝白长毛/g, "")
    .replace(/故事脚本|一句话故事|本集角色|爆点|冷开场|冲突|翻转|反转|回扣/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function creativeSimilarity(source, candidate) {
  const buildNgrams = (value) => {
    const grams = new Set();
    for (let index = 0; index <= value.length - 6; index += 1) grams.add(value.slice(index, index + 6));
    return grams;
  };
  const sourceGrams = buildNgrams(creativeFingerprint(source));
  const candidateGrams = buildNgrams(creativeFingerprint(candidate));
  if (!sourceGrams.size || !candidateGrams.size) return 0;
  let overlap = 0;
  candidateGrams.forEach((gram) => {
    if (sourceGrams.has(gram)) overlap += 1;
  });
  return overlap / candidateGrams.size;
}

function adaptedStoryIsOriginal(source, data, story) {
  const originality = data?.originality;
  const replacements = originality && typeof originality === "object"
    ? [originality.newScene, originality.newGoal, originality.newConflict, originality.newProp, originality.newFirstTurn, originality.newSecondTurn]
      .map((value) => cleanMarkdown(String(value || "")))
      .filter((value) => value.length >= 2)
    : [];
  if (replacements.length !== 6 || new Set(replacements).size < 5) return false;
  const candidate = formatFunnyStory(story);
  if (creativeSimilarity(source, candidate) > 0.48) return false;
  const copiedLongLine = source
    .split(/\r?\n/)
    .map((line) => creativeFingerprint(line))
    .filter((line) => line.length >= 24)
    .some((line) => creativeFingerprint(candidate).includes(line));
  return !copiedLongLine;
}

async function generateAdaptedStory(source, durationSeconds, castMode, selection) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryNote = attempt === 0
      ? ""
      : "\n\n上一版的表层元素或文字仍然太接近。保持参考内容的节点数量、顺序、升级轮数和反转位置完全不变，只重新更换主题、场景、道具、动作表现、笑料意象和全部台词；不得把它改成另一条故事结构。";
    const data = await requestModelJson(selection, `${buildAdaptedStoryPrompt(source, durationSeconds, castMode)}${retryNote}`, adaptedStorySchema, "adapted_story");
    const story = normalizeFunnyStory(data, castMode);
    if (story && adaptedStoryIsOriginal(source, data, story)) return story;
  }
  throw new Error("二创结果与原故事仍然太相似，请再点击一次“二创故事”。");
}

async function rewriteFixedCast(body) {
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (source.length < 20) throw new Error("生成结果太短，无法更换固定角色。");
  if (source.length > 100_000) throw new Error("生成结果不能超过 10 万个字符。");
  const currentMode = resolveCastMode(source);
  const requestedMode = typeof body.castMode === "string" ? body.castMode : "";
  if (requestedMode && !["duo", "trio"].includes(requestedMode)) {
    throw new Error("固定角色只能选择双角色或三角色。");
  }
  const castMode = requestedMode || (currentMode === "trio" ? "duo" : "trio");
  const selection = validateModelSelection(body);
  if (fixedCastTextMatches(source, castMode)) {
    return { text: source, castMode, cast: fixedCastLabel(castMode), ...selection };
  }
  const castRule = castMode === "trio"
    ? "全文固定角色只有成年主人、金渐层布丁和蓝白长毛 Coco。布丁是猫咪主角；Coco只能作为少量辅助动作、误会、证据或短对白的配角，不能改变主线、抢走布丁的关键行动或成为最终解决者。"
    : "全文固定角色只有成年主人和金渐层布丁。彻底移除 Coco、其他猫和其他人类角色；原本由男子完成的动作、对白和剧情功能必须合理改写给布丁或主人。";
  const basePrompt = `你是短视频角色适配编辑。${castRule}

执行规则：
1. 必须逐段改写全文，不是只改人物说明或标题。原文中的核心“女子、女生、女主、女主角、女主人、男主人”统一称为“主人”，主人不预设性别；核心“男子、男人、男生、男主、男友”等全部改写为真实猫咪结构的“布丁”。
2. 男子原本需要人类身体完成的动作不能生硬替换名称，必须改成猫咪可以完成的自然动作。例如驾驶改为布丁坐在副驾指挥，拥抱改为布丁跳进主人怀里。
3. 原文所有章节都要同步改写，包括故事梗概、事件链、镜头盘点、改编蓝图、动作、对白、字幕和人物称呼。输出中不得残留“男子、男人、男性、男士、男主、男友、男生、男方、女子、女性、女士、女主、女主人、男主人”等旧核心角色词。
4. 保留原文标题层级、时间戳、镜头顺序、事件因果、笑点位置和输出格式；只改写人物身份、称呼、对白归属和保证剧情合理所必需的动作。
5. 布丁始终是猫咪主角。不得输出解释、改写说明或省略号，必须返回改写后的完整全文。`;
  let candidate = source;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const systemPrompt = attempt === 0
      ? basePrompt
      : `${basePrompt}\n\n上一版改写仍残留旧人物称呼或缺少指定角色。请逐行检查并彻底修正，不能原样返回。`;
    candidate = selection.provider === "openai"
      ? await requestOpenAIText(systemPrompt, candidate, selection.model)
      : selection.provider === "deepseek"
        ? await requestDeepSeekText(systemPrompt, candidate, selection.model)
        : await requestGeminiText(systemPrompt, candidate, selection.model);
    if (fixedCastTextMatches(candidate, castMode)) {
      return { text: candidate, castMode, cast: fixedCastLabel(castMode), ...selection };
    }
  }
  throw new Error(`角色改写不完整，结果中仍有旧人物称呼。请再点击“${fixedCastLabel(castMode)}”。`);
}

function normalizeFunnyStory(data, castMode) {
  if (!data || !Array.isArray(data.segments) || data.segments.length < 4) return null;
  const segments = data.segments.map((segment) => ({
    time: cleanMarkdown(String(segment.time || "")),
    beat: cleanMarkdown(String(segment.beat || "")),
    action: cleanMarkdown(String(segment.action || "")),
    dialogue: String(segment.dialogue || "无").replace(/\r/g, "").trim()
  }));
  if (segments.some((segment) => !segment.time || !segment.beat || segment.action.length < 12)) return null;
  const fullText = segments.map((segment) => `${segment.action}\n${segment.dialogue}`).join("\n");
  if (!fullText.includes("布丁") || !/(主人|女主)/.test(fullText)) return null;
  if (castMode === "duo" && /coco/i.test(fullText)) return null;
  if (castMode === "trio" && !/coco/i.test(fullText)) return null;
  return {
    title: cleanMarkdown(String(data.title || "未命名故事")),
    oneSentence: cleanMarkdown(String(data.oneSentence || "")),
    segments,
    castMode,
    highlights: {
      hook: cleanMarkdown(String(data.highlights?.hook || "")),
      emotion: cleanMarkdown(String(data.highlights?.emotion || "")),
      comment: cleanMarkdown(String(data.highlights?.comment || ""))
    }
  };
}

function formatFunnyStory(story) {
  const cast = story.castMode === "trio"
    ? "主人、金渐层布丁（主角）、蓝白长毛 Coco（配角）"
    : "主人、金渐层布丁（主角）";
  const segments = story.segments.flatMap((segment) => [
    `### ${segment.time}｜${segment.beat}`,
    segment.action,
    `对白：\n${segment.dialogue}`
  ]).join("\n\n");
  return `# ${story.title}\n\n## 本集角色\n\n${cast}\n\n## 一句话故事\n\n${story.oneSentence}\n\n## 故事脚本\n\n${segments}\n\n## 爆点\n\n- 钩子：${story.highlights.hook}\n- 情绪爆点：${story.highlights.emotion}\n- 评论点：${story.highlights.comment}`;
}

function organizeTasks({ shots, taskCount }) {
  if (!shots.length) throw new Error("没有识别到 Markdown 分镜表格。请确认每行以“| 镜号 |”格式填写。");
  const tasks = [];
  const safeTaskCount = Math.min(shots.length, Math.max(1, taskCount));
  let shotIndex = 0;
  for (let taskIndex = 0; taskIndex < safeTaskCount; taskIndex += 1) {
    const remainingShots = shots.length - shotIndex;
    const remainingTasks = safeTaskCount - taskIndex;
    const groupSize = Math.ceil(remainingShots / remainingTasks);
    const group = shots.slice(shotIndex, shotIndex + groupSize);
    shotIndex += groupSize;
    const first = group[0].number;
    const last = group.at(-1).number;
    tasks.push({
      id: tasks.length + 1,
      shotRange: `${first}-${last}`,
      prompt: formatTaskPrompt(group)
    });
  }
  return tasks;
}


function normalizeStoryboard(data, totalShots, lockedDialogues = [], allowCoco = false) {
  if (!data || !Array.isArray(data.shots) || data.shots.length !== totalShots) return null;
  const dialogueById = new Map(lockedDialogues.map((item) => [item.id, item.rendered]));
  const usedDialogueIds = [];
  const shots = [];
  for (const [index, shot] of data.shots.entries()) {
    const visual = cleanMarkdown(String(shot.visual || ""));
    const rawDialogue = cleanMarkdown(String(shot.dialogue || "无"));
    let dialogue = rawDialogue;
    if (lockedDialogues.length) {
      const ids = [...rawDialogue.matchAll(/\bD(\d+)\b/gi)].map((match) => `D${Number(match[1])}`);
      if (!ids.length) {
        if (!/^(?:无|none)$/i.test(rawDialogue)) return null;
        dialogue = "无";
      } else {
        if (ids.some((id) => !dialogueById.has(id))) return null;
        usedDialogueIds.push(...ids);
        dialogue = ids.map((id) => dialogueById.get(id)).join("\n");
      }
    }
    shots.push({ number: index + 1, visual, dialogue });
  }
  const title = cleanMarkdown(String(data.title || "未命名故事"));
  if (containsDisallowedEnglish(title, allowCoco)) return null;
  if (shots.some((shot) => shot.visual.length < 12 || !shot.visual.startsWith("【") || containsDisallowedEnglish(shot.visual, allowCoco) || containsDisallowedEnglish(shot.dialogue, allowCoco))) return null;
  if (lockedDialogues.length) {
    const expectedIds = lockedDialogues.map((item) => item.id);
    if (usedDialogueIds.length !== expectedIds.length || usedDialogueIds.some((id, index) => id !== expectedIds[index])) return null;
  }
  return {
    title,
    shots,
    dialogueLockCount: lockedDialogues.length,
    chineseOnly: true,
    losslessFormat: true
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function geminiRetrySeconds(response, payload) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  const message = String(payload?.error?.message || "");
  const matched = message.match(/retry in\s+([\d.]+)s/i);
  return matched ? Math.ceil(Number(matched[1])) : 10;
}

async function requestGemini(url, options, timeoutMilliseconds = 120_000) {
  let lastRetrySeconds = 10;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result;
    try {
      result = await undiciFetch(url, {
        ...options,
        ...(geminiProxyDispatcher ? { dispatcher: geminiProxyDispatcher } : {}),
        signal: AbortSignal.timeout(timeoutMilliseconds)
      });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error("Gemini 响应超时，请重试。");
      // 偶发瞬时断连（ECONNRESET 等）：首次失败等待 2 秒后重试一次
      if (attempt === 0) {
        await wait(2_000);
        continue;
      }
      throw new Error("无法连接 Gemini 服务，请检查网络后重试。");
    }

    const payload = await result.json().catch(() => ({}));
    if (result.ok) return payload;
    const providerMessage = String(payload?.error?.message || "");
    if (result.status === 429) {
      // 免费层每日配额（每模型每天 20 次）用尽时，等秒数无用，提示换模型
      const quotaId = (payload?.error?.details || []).find((item) => item?.["@type"]?.includes("QuotaFailure"))
        ?.violations?.[0]?.quotaId || "";
      if (quotaId.includes("PerDay")) {
        throw new Error("Gemini 免费额度该模型今日 20 次已用完，请在模型下拉框换一个模型（如 gemini-3.8-flash），或明天再试。");
      }
      lastRetrySeconds = geminiRetrySeconds(result, payload);
      if (attempt === 0 && lastRetrySeconds <= 35) {
        await wait((lastRetrySeconds * 1000) + 300);
        continue;
      }
      throw new Error(`Gemini 免费额度正在限流，请等待约 ${lastRetrySeconds} 秒后再试。`);
    }
    if (result.status >= 500 || /high demand|overloaded|temporarily unavailable/i.test(providerMessage)) {
      if (attempt === 0) {
        await wait(5_000);
        continue;
      }
      throw new Error("Gemini 当前使用人数较多，已自动重试但仍繁忙，请稍后再试。");
    }
    throw new Error(providerMessage || `Gemini 请求失败（${result.status}）`);
  }
  throw new Error(`Gemini 免费额度正在限流，请等待约 ${lastRetrySeconds} 秒后再试。`);
}

async function requestGeminiJson(prompt, responseSchema, selectedModel) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
  const payload = await requestGemini(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiConfig.get("gemini").apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema
      }
    })
  });
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  if (!text) throw new Error("Gemini 没有返回可用内容，请重试。");
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Gemini 返回的数据无法解析，请重试。");
    throw error;
  }
}

function makeStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(makeStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const copy = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, makeStrictSchema(value)]));
  if (copy.type === "object") copy.additionalProperties = false;
  return copy;
}

async function requestOpenAIJson(prompt, responseSchema, selectedModel, schemaName) {
  const result = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiConfig.get("openai").apiKey}`
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema: makeStrictSchema(responseSchema)
        }
      }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await result.json();
  if (!result.ok) {
    if (result.status === 401) throw new Error("OPENAI_API_KEY 无效，请检查密钥后重新启动。");
    if (result.status === 429) throw new Error("OpenAI 额度不足或请求过于频繁，请稍后再试。");
    throw new Error(payload?.error?.message || `OpenAI 请求失败（${result.status}）`);
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI 没有返回可用内容，请重试。");
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("OpenAI 返回的数据无法解析，请重试。");
    throw error;
  }
}

async function requestDeepSeekJson(prompt, responseSchema, selectedModel) {
  const schema = JSON.stringify(makeStrictSchema(responseSchema));
  const result = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiConfig.get("deepseek").apiKey}`
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: "system", content: `你必须只输出合法 JSON，不要使用 Markdown 代码块。输出必须符合这个 JSON Schema：${schema}` },
        { role: "user", content: `${prompt}\n\n请仅输出符合要求的 JSON 对象。` }
      ],
      response_format: { type: "json_object" },
      max_tokens: 64_000
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await result.json();
  if (!result.ok) {
    if (result.status === 401) throw new Error("DEEPSEEK_API_KEY 无效，请检查密钥后重新启动。");
    if (result.status === 402) throw new Error("DeepSeek 账户余额不足，请充值后重试。");
    if (result.status === 429) throw new Error("DeepSeek 请求过于频繁，请稍后再试。");
    throw new Error(payload?.error?.message || `DeepSeek 请求失败（${result.status}）`);
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error("DeepSeek 没有返回可用内容，请重试。");
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("DeepSeek 返回的数据无法解析，请重试。");
    throw error;
  }
}

function requestModelJson(selection, prompt, responseSchema, schemaName) {
  if (selection.provider === "openai") return requestOpenAIJson(prompt, responseSchema, selection.model, schemaName);
  if (selection.provider === "deepseek") return requestDeepSeekJson(prompt, responseSchema, selection.model);
  return requestGeminiJson(prompt, responseSchema, selection.model);
}

async function requestGeminiText(systemPrompt, input, selectedModel, video = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
  const parts = [];
  if (video) {
    parts.push({ inlineData: { mimeType: video.mimeType, data: video.buffer.toString("base64") } });
  }
  parts.push({ text: input || "请严格按照系统提示词，完整分析视频中的画面、声音、对白与文字，并输出原始内容。" });
  const payload = await requestGemini(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiConfig.get("gemini").apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts }]
    })
  });
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new Error("Gemini 没有返回可用内容，请重试。");
  return text;
}

async function requestOpenAIText(systemPrompt, input, selectedModel) {
  const result = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiConfig.get("openai").apiKey}` },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input }
      ]
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await result.json();
  if (!result.ok) {
    if (result.status === 401) throw new Error("OPENAI_API_KEY 无效，请检查密钥后重新启动。");
    if (result.status === 429) throw new Error("OpenAI 额度不足或请求过于频繁，请稍后再试。");
    throw new Error(payload?.error?.message || `OpenAI 请求失败（${result.status}）`);
  }
  const text = payload?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI 没有返回可用内容，请重试。");
  return text;
}

async function requestDeepSeekText(systemPrompt, input, selectedModel) {
  const result = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiConfig.get("deepseek").apiKey}` },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input }
      ]
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await result.json();
  if (!result.ok) {
    if (result.status === 401) throw new Error("DEEPSEEK_API_KEY 无效，请检查密钥后重新启动。");
    if (result.status === 402) throw new Error("DeepSeek 账户余额不足，请充值后重试。");
    if (result.status === 429) throw new Error("DeepSeek 请求过于频繁，请稍后再试。");
    throw new Error(payload?.error?.message || `DeepSeek 请求失败（${result.status}）`);
  }
  const text = payload?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("DeepSeek 没有返回可用内容，请重试。");
  return text;
}

async function generateText(body) {
  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input && !body.video) throw new Error("请填写补充文本，或者选择一个视频。");
  if (input.length > 100_000) throw new Error("原始内容不能超过 10 万个字符。");
  const prompts = await readPromptLibrary();
  const selectedPrompt = prompts.find((item) => item.id === body.promptId);
  if (body.promptId && !selectedPrompt) throw new Error("所选提示词无效，请重新选择。");
  const prompt = selectedPrompt || {
    title: "系统默认视频分析",
    content: "完整分析用户上传的视频或输入文本，按时间顺序还原人物、场景、镜头、动作、表情、台词、音效和节奏。输出可继续用于生成分镜任务的中文复刻稿；忠实于原内容，不额外编造新故事。"
  };
  const selection = validateModelSelection(body);
  if (body.video && selection.provider !== "gemini") throw new Error("视频理解目前需要使用 Gemini，请切换模型服务商后重试。");
  const text = selection.provider === "openai"
    ? await requestOpenAIText(prompt.content, input, selection.model)
    : selection.provider === "deepseek"
      ? await requestDeepSeekText(prompt.content, input, selection.model)
      : await requestGeminiText(prompt.content, input, selection.model, body.video);
  return { text, promptTitle: prompt.title, videoName: body.video?.name || null, ...selection };
}

async function listModels(provider, draft) {
  const { apiKey, defaultModel } = draft || apiConfig.get(provider);
  if (provider === "deepseek") {
    if (!apiKey) return { provider, configured: false, defaultModel: defaultModel, models: [] };
    const result = await fetch("https://api.deepseek.com/models", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload?.error?.message || "无法读取 DeepSeek 模型列表。");
    const available = new Set((payload.data || []).map((item) => item.id));
    const preferred = ["deepseek-v4-pro", "deepseek-v4-flash"];
    const models = preferred.filter((id) => available.has(id));
    if (available.has(defaultModel) && !models.includes(defaultModel)) models.unshift(defaultModel);
    return { provider, configured: true, defaultModel: available.has(defaultModel) ? defaultModel : models[0], models };
  }

  if (provider === "openai") {
    if (!apiKey) return { provider, configured: false, defaultModel: defaultModel, models: [] };
    const result = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload?.error?.message || "无法读取 OpenAI 模型列表。");
    const preferred = ["gpt-5.6", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"];
    const available = new Set((payload.data || []).map((item) => item.id));
    const preferredModels = preferred.filter((id) => available.has(id));
    const otherModels = [...available]
      .filter((id) => /^gpt-(?:5|4\.1|4o)(?:$|[-.])/.test(id))
      .filter((id) => !/(audio|realtime|search|transcribe|tts|image|codex)/i.test(id))
      .filter((id) => !preferredModels.includes(id))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const models = [...preferredModels, ...otherModels];
    if (available.has(defaultModel) && !models.includes(defaultModel)) models.unshift(defaultModel);
    return { provider, configured: true, defaultModel: available.has(defaultModel) ? defaultModel : models[0], models };
  }

  if (!apiKey) return { provider, configured: false, defaultModel: defaultModel, models: [] };
  const result = await undiciFetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
    headers: { "x-goog-api-key": apiKey },
    ...(geminiProxyDispatcher ? { dispatcher: geminiProxyDispatcher } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await result.json();
  if (!result.ok) throw new Error(payload?.error?.message || "无法读取 Gemini 模型列表。");
  const models = (payload.models || [])
    .filter((item) => item.supportedGenerationMethods?.includes("generateContent"))
    .map((item) => item.name?.replace(/^models\//, ""))
    .filter((id) => id?.startsWith("gemini-") && !/(embedding|image|tts|live|robotics|computer-use)/i.test(id))
    .sort((a, b) => a.localeCompare(b));
  if (!models.includes(defaultModel)) models.unshift(defaultModel);
  return { provider, configured: true, defaultModel: defaultModel, models };
}

async function generateStoryboardWithModel(input, selection) {
  const structuredStoryboard = formatStructuredSourceStoryboard(input.script, input.totalShots);
  if (structuredStoryboard) return structuredStoryboard;
  const lockedDialogues = extractLockedDialogues(input.script);
  const allowCoco = /coco|蓝白长毛/i.test(input.script);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryNote = attempt
      ? `上一次数量、无损格式、台词编号或中文要求不合格。本次必须严格输出 ${input.totalShots} 镜，只合并相邻原镜头，不新增、删除、调换或改写内容；每个 visual 以【镜头说明】开头，所有英文视觉术语翻译成中文，并让所有锁定台词编号按原顺序各出现一次。`
      : "";
    const data = await requestModelJson(selection, buildStoryboardPrompt(input, retryNote, lockedDialogues), storyboardSchema, "storyboard");
    const storyboard = normalizeStoryboard(data, input.totalShots, lockedDialogues, allowCoco);
    if (storyboard) return storyboard;
  }
  if (lockedDialogues.length) {
    throw new Error(`AI 未能在 ${input.totalShots} 镜中完整放回 ${lockedDialogues.length} 句原台词；本次没有输出改写后的台词，请重试。`);
  }
  throw new Error(`AI 未能稳定生成 ${input.totalShots} 镜，请缩短故事或减少总分镜数后重试。`);
}

async function generateFunnyStory(durationSeconds, selection) {
  const castMode = Math.random() < 0.5 ? "duo" : "trio";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const data = await requestModelJson(selection, buildFunnyStoryPrompt(durationSeconds, castMode), funnyStorySchema, "funny_story");
    const story = normalizeFunnyStory(data, castMode);
    if (story) return story;
  }
  throw new Error("AI 没有生成合格的臭猫故事，请再随机一次。");
}

async function serveStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const safePath = normalize(relative);
  if (safePath.startsWith("..") || safePath.includes("/../")) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const file = await readFile(join(root, safePath));
    response.writeHead(200, {
      "content-type": mimeTypes[extname(safePath)] || "application/octet-stream",
      "cache-control": "no-store, max-age=0"
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("页面不存在");
  }
}

const server = createServer(async (request, response) => {
  try {
    if (["/api/settings", "/api/settings/test"].includes(request.url)) {
      validateSettingsRequest(request);
      response.setHeader("cache-control", "no-store");
      if (request.method === "GET" && request.url === "/api/settings") {
        return sendJson(response, 200, { providers: apiConfig.publicStatus() });
      }
      if (request.method === "POST" && request.url === "/api/settings") {
        return sendJson(response, 200, { providers: await apiConfig.save(await readJson(request)) });
      }
      if (request.method === "POST" && request.url === "/api/settings/test") {
        const draft = apiConfig.draft(await readJson(request));
        if (!draft.apiKey) throw new Error("请先填写 API Key。");
        try {
          const result = await listModels(draft.provider, draft);
          return sendJson(response, 200, { connected: true, modelCount: result.models.length });
        } catch (error) {
          const message = error.name === "TimeoutError" ? "连接超时，请检查网络后重试。" : error.message || "连接失败，请检查密钥和网络。";
          throw new Error(message.split(draft.apiKey).join("[已隐藏]"));
        }
      }
      return sendJson(response, 405, { error: "不支持这个配置操作。" });
    }
    if (request.method === "GET" && request.url === "/api/prompts") {
      return sendJson(response, 200, { prompts: await readPromptLibrary() });
    }
    if (request.method === "GET" && request.url === "/api/status") {
      return sendJson(response, 200, {
        configured: Boolean(apiConfig.get("gemini").apiKey || apiConfig.get("openai").apiKey || apiConfig.get("deepseek").apiKey),
        providers: {
          gemini: { configured: Boolean(apiConfig.get("gemini").apiKey), defaultModel: apiConfig.get("gemini").defaultModel },
          openai: { configured: Boolean(apiConfig.get("openai").apiKey), defaultModel: apiConfig.get("openai").defaultModel },
          deepseek: { configured: Boolean(apiConfig.get("deepseek").apiKey), defaultModel: apiConfig.get("deepseek").defaultModel }
        }
      });
    }
    if (request.method === "GET" && request.url.startsWith("/api/models")) {
      const provider = new URL(request.url, `http://${request.headers.host}`).searchParams.get("provider") || "gemini";
      if (!["gemini", "openai", "deepseek"].includes(provider)) throw new Error("不支持这个模型服务商。");
      return sendJson(response, 200, await listModels(provider));
    }
    if (request.method === "GET" && request.url.startsWith("/api/video-file/")) {
      const token = request.url.slice("/api/video-file/".length).split("?")[0];
      return serveVideoFile(response, token);
    }
    if (request.method === "POST" && request.url === "/api/open-downloads-folder") {
      return openDownloadsFolder(response);
    }
    if (request.method === "GET" && request.url.startsWith("/api/video-download-status/")) {
      const jobId = request.url.slice("/api/video-download-status/".length).split("?")[0];
      const job = downloadJobs.get(jobId);
      if (!job) return sendJson(response, 404, { error: "下载任务不存在或已过期。" });
      return sendJson(response, 200, job);
    }
    if (request.method === "POST" && request.url === "/api/video-download") {
      const jobId = startDownloadJob(await readJson(request));
      return sendJson(response, 202, { jobId });
    }
    if (request.method === "POST" && request.url === "/api/text-generate") {
      const isMultipart = request.headers["content-type"]?.startsWith("multipart/form-data;");
      const body = isMultipart ? await readMultipartForm(request) : await readJson(request);
      return sendJson(response, 200, await generateText(body));
    }
    if (request.method === "POST" && request.url === "/api/rewrite-cast") {
      return sendJson(response, 200, await rewriteFixedCast(await readJson(request)));
    }
    if (request.method === "POST" && request.url === "/api/adapt-story") {
      const body = await readJson(request);
      const source = typeof body.source === "string" ? body.source.trim() : "";
      if (source.length < 20) throw new Error("生成结果太短，无法改编故事。");
      if (source.length > 100_000) throw new Error("生成结果不能超过 10 万个字符。");
      const durationSeconds = body.durationSeconds === undefined || body.durationSeconds === ""
        ? inferAdaptedStoryDuration(source)
        : validateDuration(body.durationSeconds);
      const castMode = resolveCastMode(source, body.castMode);
      const selection = validateModelSelection(body);
      const story = await generateAdaptedStory(source, durationSeconds, castMode, selection);
      return sendJson(response, 200, {
        title: story.title,
        story: formatFunnyStory(story),
        castMode,
        cast: fixedCastLabel(castMode),
        durationSeconds,
        ...selection
      });
    }
    if (request.method === "POST" && request.url === "/api/random-story") {
      const body = await readJson(request);
      const durationSeconds = validateDuration(body.durationSeconds);
      const selection = validateModelSelection(body);
      const story = await generateFunnyStory(durationSeconds, selection);
      return sendJson(response, 200, {
        title: story.title,
        story: formatFunnyStory(story),
        cast: story.castMode === "trio" ? "主人、布丁、Coco（配角）" : "主人、布丁",
        provider: selection.provider,
        model: selection.model,
        durationSeconds
      });
    }
    if (request.method === "POST" && (request.url === "/api/generate" || request.url === "/api/preview")) {
      const body = await readJson(request);
      let input = validateInput(body);
      const isPreview = request.url === "/api/preview";
      if (isPreview && !input.shots.length) {
        throw new Error("本地预览只能整理已有分镜表格。输入故事后请点击“生成分镜与任务”。");
      }
      const selection = !input.shots.length || needsTranslation(input.script) ? validateModelSelection(body) : null;
      if (needsTranslation(input.script)) {
        const script = await translateInput(input.script, (prompt, schema, name) => requestModelJson(selection, prompt, schema, name));
        input = validateInput({ ...body, script });
      }
      const generated = input.shots.length
        ? { title: "已有分镜", shots: input.shots }
        : await generateStoryboardWithModel(input, selection);
      const tasks = organizeTasks({ shots: generated.shots, taskCount: input.taskCount });
      return sendJson(response, 200, {
        title: generated.title,
        storyboardMarkdown: formatStoryboardMarkdown(generated.shots),
        tasks,
        meta: {
          mode: input.shots.length ? (isPreview ? "preview" : "existing") : "story",
          shotCount: generated.shots.length,
          taskCount: tasks.length,
          provider: selection?.provider || null,
          model: selection?.model || null,
          dialogueLockCount: generated.dialogueLockCount || 0,
          chineseOnly: Boolean(generated.chineseOnly),
          losslessFormat: Boolean(generated.losslessFormat),
          timingPlan: {
            durationSeconds: input.durationSeconds,
            totalShots: generated.shots.length,
            shotsPerTask: input.shotsPerTask,
            taskCount: tasks.length,
            averageShotSeconds: Number((input.durationSeconds / generated.shots.length).toFixed(1)),
            averageTaskSeconds: Number((input.durationSeconds / tasks.length).toFixed(1))
          }
        }
      });
    }
    await serveStatic(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败，请稍后重试。";
    sendJson(response, 400, { error: message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`分镜任务台已启动：http://127.0.0.1:${port}`);
  console.log(apiConfig.get("gemini").apiKey ? `Gemini 已连接：${apiConfig.get("gemini").defaultModel}` : "Gemini 未配置。");
  console.log(apiConfig.get("openai").apiKey ? `OpenAI 已连接：${apiConfig.get("openai").defaultModel}` : "OpenAI 未配置。");
  console.log(apiConfig.get("deepseek").apiKey ? `DeepSeek 已连接：${apiConfig.get("deepseek").defaultModel}` : "DeepSeek 未配置。");
});
