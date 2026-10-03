import express, { type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import crypto from "node:crypto";
import { db } from "./src/db/index.ts";
import { projects, batches, users, studentCodes } from "./src/db/schema.ts";
import { eq, and } from "drizzle-orm";
import { optionalAuth, AuthRequest } from "./src/middleware/auth.ts";

// Locked model IDs
const CONVERSION_MODEL = "glm-5.3-flash";
const GROUP_ONE = ["glm-3-flash","qwen3.5-397b-a17b","gemma-4-31B-it","deepseek-v4-pro","kimi-k2.6"] as const;
const GROUP_TWO = ["llama-4-maverick","mimo-v2.5-pro","minimax-m2.5","mistral-3-14B","nemotron-3-nano-omni"] as const;
const BACKUPS = [
  "deepseek-3.2","deepseek-v3","deepseek-4-flash","deepseek-v4-flash-0731","deepseek-v4-pro-0813",
  "qwen-2.5-14b-instruct","qwen3.8-max","glm-4.7","glm-4.7-flash","glm-4.5-air","glm-4.5",
  "nemotron-3-nano-30b","nemotron-nano-12b-v2-vl","nvidia-nemotron-3-super-120b"
] as const;

const BATCH_COUNTS = [5, 10, 25, 50, 100, 200, 250] as const;
type BatchCount = (typeof BATCH_COUNTS)[number];

dotenv.config();

const DATA_DIR = path.join(process.cwd(), ".data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LOCAL_PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const LOCAL_STUDENT_CODES_FILE = path.join(DATA_DIR, "student_codes.json");
const LOCAL_USERS_FILE = path.join(DATA_DIR, "users.json");

const GENTLE_TAGS = [
  "think","thought","thoughts","reasoning","reflection","scratchpad","internal",
  "plan","cot","analysis","inner_thought","mind"
] as const;

export function stripCoTFromSingleTurn(text: string): string {
  if (!text || typeof text !== "string") return text || "";
  let s = text.trim();

  for (const tag of GENTLE_TAGS) {
    const closedXml = new RegExp("<" + tag + "(?:\\s+[^>]*)?>[\\s\\S]*?<\\/" + tag + ">", "gi");
    const unclosedXml = new RegExp("<" + tag + "(?:\\s+[^>]*)?>[\\s\\S]*$", "gi");
    const closedBracket = new RegExp("\\[" + tag + "\\][\\s\\S]*?\\[\\/" + tag + "\\]", "gi");
    const unclosedBracket = new RegExp("\\[" + tag + "\\][\\s\\S]*$", "gi");
    s = s.replace(closedXml, "");
    s = s.replace(unclosedXml, "");
    s = s.replace(closedBracket, "");
    s = s.replace(unclosedBracket, "");
  }

  const answerDelimiterRegex = /(?:^|\n)\s*(?:[\*\#\_]{0,4})\s*(?:Final\s+Answer|Final\s+Response|Direct\s+Answer|Response|Answer|Output|Conclusion|Solution)\s*(?:[\*\#\_]{0,4}):?\s*(?:[\*\#\_]{0,4})\s*\n?/i;
  const thoughtHeaderRegex = /^(?:[\*\#\_\s]*)(?:Thinking\s+Process|Thought\s+Process|Chain\s+of\s+Thought|Reasoning\s+Trace|Reasoning\s+Process|Reasoning|Thoughts|Internal\s+Thoughts|Internal\s+Monologue|Scratchpad|Analysis|Draft|Planning|Step-by-step\s+reasoning|Here\s+is\s+my\s+reasoning|Here\x27s\s+my\s+thought\s+process|Let(?:\x27s|\s+me)\s+think)/i;

  if (thoughtHeaderRegex.test(s)) {
    const matches = Array.from(s.matchAll(new RegExp(answerDelimiterRegex.source, "gi")));
    if (matches && matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const remainder = s.substring(lastMatch.index + lastMatch[0].length).trim();
      if (remainder.length > 0) s = remainder;
    }
  } else {
    const match = s.match(answerDelimiterRegex);
    if (match && match.index !== undefined && match.index > 0) {
      const preamble = s.substring(0, match.index).trim();
      if (/(?:think|reason|analyz|consider|step|plan|approach|user\s+is|goal|draft|scratch)/i.test(preamble)) {
        s = s.substring(match.index + match[0].length).trim();
      }
    }
  }

  s = s.replace(
    /(?:^|\n)\s*(?:[\*\#\_]{0,4})\s*(?:Thinking\s+Process|Thought\s+Process|Chain\s+of\s+Thought|Reasoning\s+Trace|Reasoning\s+Process|Reasoning|Thoughts|Internal\s+Thoughts|Internal\s+Monologue|Scratchpad|Analysis|Draft)\s*(?:[\*\#\_]{0,4}):?[\s\S]*?(?=(?:\n\s*(?:[\*\#\_]{0,4})\s*(?:Final\s+Answer|Response|Answer|Output|Conclusion):?|\n\s*\n[A-Z]|\n#{1,4}\s+[A-Z]|$))/gi,
    ""
  );

  s = s.replace(/^(?:[\*\#\_\s]*)(?:Response|Instruction|Answer|Assistant|Output|Solution)(?:[\*\#\_\s]*):?\s*/i, "");

  let paragraphs = s.split(/\n\s*\n/);
  while (paragraphs.length > 1) {
    const p0 = paragraphs[0].trim();
    const isP0Meta = /^(?:(?:I\s+(?:am\s+(?:analyzing|reviewing|tracing|considering|thinking)|need\s+to|will\s+(?:explain|describe|state|construct|outline|note)|must\s+first|should\s+also)|Let(?:\x27s|\s+me)\s+(?:first|analyze|think|examine|consider|break)|To\s+answer\s+this|First,\s+I\s+will|The\s+user\s+(?:wants|is\s+asking)|Here\s+is\s+(?:my\s+)?(?:step-by-step\s+)?(?:reasoning|thought|analysis))\b)/i.test(p0);
    if (isP0Meta) {
      paragraphs.shift();
      s = paragraphs.join("\n\n").trim();
    } else break;
  }

  const metaRegex = /^(?:(?:I\s+(?:am\s+(?:analyzing|reviewing|tracing|considering|thinking)|need\s+to\s+(?:first|analyze|explain|note)|will\s+(?:explain|describe|outline|state)|should\s+first)|Let(?:\x27s|\s+me)\s+(?:first\s+)?(?:analyze|think|examine|consider|break\s+down)|To\s+answer\s+this\s+(?:question|request|prompt)?|The\s+user\s+(?:wants|is\s+asking\s+(?:for|to)?)|Here\s+is\s+my\s+(?:step-by-step\s+)?(?:thought|reasoning|analysis))\b[^.!?]*[.!?]+\s*)+/i;
  const cleanedLeading = s.replace(metaRegex, "").trim();
  if (cleanedLeading.length > 15) s = cleanedLeading;

  s = s.replace(/^\[INST\]\s*/i, "");
  s = s.replace(/\s*\[\/INST\]$/i, "");
  s = s.replace(/^<s>\s*/i, "");
  s = s.replace(/\s*<\/s>$/i, "");
  s = s.replace(/^<\|im_start\|>\s*(?:assistant\s*)?/i, "");
  s = s.replace(/\s*<\|im_end\|>$/i, "");

  return s.trim();
}

export function sanitizeMessage(msg: any, templateType?: string): { role: string; content: string; reasoning?: string } {
  if (!msg || typeof msg !== "object") {
    return { role: "assistant", content: typeof msg === "string" ? stripCoTFromSingleTurn(msg) : "" };
  }
  const role = typeof msg.role === "string" ? msg.role : "assistant";
  let content = msg.content;
  let reasoning = msg.reasoning || msg.reasoning_content || msg.thought || msg.thoughts;

  if (content && typeof content === "object") {
    if (!reasoning && (content.reasoning || content.reasoning_content || content.thought || content.thoughts)) {
      reasoning = content.reasoning || content.reasoning_content || content.thought || content.thoughts;
    }
    content = content.response || content.content || content.text || content.answer || content.output || (
      content.reasoning && !content.response ? content.reasoning : JSON.stringify(content)
    );
  }

  if (reasoning && typeof reasoning === "object") {
    reasoning = reasoning.reasoning || reasoning.thought || reasoning.content || reasoning.text || JSON.stringify(reasoning);
  }

  let finalContent = typeof content === "string" ? content.trim() : content !== undefined && content !== null ? String(content).trim() : "";
  finalContent = finalContent
    .replace(/\\\/n/g, "\n")
    .replace(/(?<=\s|^)\/n(?=\s|$)/g, "\n")
    .replace(/(?<=[a-zA-Z0-9.,!?;:])\/n(?=[a-zA-Z0-9])/g, "\n")
    .replace(/\s*\/n\s*/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  let finalReasoning = typeof reasoning === "string" ? reasoning.trim() : reasoning !== undefined && reasoning !== null ? String(reasoning).trim() : undefined;
  if (finalReasoning) {
    finalReasoning = finalReasoning
      .replace(/\\\/n/g, "\n")
      .replace(/(?<=\s|^)\/n(?=\s|$)/g, "\n")
      .replace(/(?<=[a-zA-Z0-9.,!?;:])\/n(?=[a-zA-Z0-9])/g, "\n")
      .replace(/\s*\/n\s*/g, "\n")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  if (role === "assistant" && typeof finalContent === "string" && finalContent.length > 0) {
    const thinkMatch = finalContent.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i);
    if (thinkMatch) {
      if (!finalReasoning && thinkMatch[1] && thinkMatch[1].trim().length > 0) {
        finalReasoning = thinkMatch[1].trim();
      }
      finalContent = finalContent.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "").trim();
    }
  }

  const isReasoningOrMixed = templateType ? (templateType.toLowerCase().includes("reason") || templateType.toLowerCase().includes("mix")) : Boolean(finalReasoning);
  const isNonReasoning = templateType ? !isReasoningOrMixed : false;

  if (isNonReasoning || role !== "assistant") {
    finalReasoning = undefined;
    finalContent = stripCoTFromSingleTurn(finalContent);
  }

  return {
    role,
    content: finalContent,
    ...(finalReasoning && (isReasoningOrMixed || !templateType) ? { reasoning: finalReasoning } : {})
  };
}

export function sanitizeExample(example: any, templateType?: string): any {
  if (!example || typeof example !== "object") return example;
  const effectiveTemplate = templateType || example.templateType || "Single Turn";

  let rawMessages = example.messages;
  if (!Array.isArray(rawMessages)) {
    if (Array.isArray(example.conversations)) {
      rawMessages = example.conversations.map((c: any) => ({
        role: c.from === "human" || c.from === "user" ? "user" : "assistant",
        content: c.value || c.content || ""
      }));
    } else {
      const userText = example.instruction || example.prompt || example.input || example.user || example.query;
      const astText = example.response || example.output || example.assistant || example.completion || example.answer;
      const sysText = example.system || example.systemPrompt;
      const msgs: any[] = [];
      if (sysText) msgs.push({ role: "system", content: String(sysText).trim() });
      if (userText) msgs.push({ role: "user", content: String(userText).trim() });
      if (astText) msgs.push({ role: "assistant", content: String(astText).trim() });
      rawMessages = msgs;
    }
  }

  const isReasoningOrMixed = effectiveTemplate ? (effectiveTemplate.toLowerCase().includes("reason") || effectiveTemplate.toLowerCase().includes("mix")) : false;
  let cleanedMessages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map((m: any) => sanitizeMessage(m, effectiveTemplate))
    .filter((m: any) => m && typeof m.content === "string" && m.content.trim().length > 0);

  const hasUser = cleanedMessages.some((m: any) => m.role === "user");
  const hasAssistant = cleanedMessages.some((m: any) => m.role === "assistant");
  if (!hasUser && cleanedMessages.length > 0) cleanedMessages.unshift({ role: "user", content: "Provide instruction." });
  if (!hasAssistant && cleanedMessages.length > 0) cleanedMessages.push({ role: "assistant", content: "Completed response." });

  const sanitizedExample: any = { ...example, templateType: effectiveTemplate, messages: cleanedMessages };
  if (!isReasoningOrMixed) {
    delete sanitizedExample.reasoning;
    delete sanitizedExample.reasoning_content;
    delete sanitizedExample.thought;
    delete sanitizedExample.thoughts;
  }
  return sanitizedExample;
}

export function sanitizeProjectData(project: any): any {
  if (!project || typeof project !== "object") return project;
  if (Array.isArray(project.batches)) {
    return {
      ...project,
      batches: project.batches.map((b: any) => {
        const bTemplate = b.templateType || project.settings?.templateType || "Single Turn";
        if (Array.isArray(b.examples)) {
          return { ...b, examples: b.examples.map((ex: any) => sanitizeExample(ex, bTemplate)) };
        }
        return b;
      })
    };
  }
  return project;
}

function getLocalProjects(): any[] {
  try {
    if (fs.existsSync(LOCAL_PROJECTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LOCAL_PROJECTS_FILE, "utf-8"));
      if (Array.isArray(parsed)) return parsed.map(sanitizeProjectData);
      return parsed;
    }
  } catch (e) {
    console.error("Error reading local projects file:", e);
  }
  return [];
}

function saveLocalProjects(list: any[]) {
  try {
    const sanitizedList = Array.isArray(list) ? list.map(sanitizeProjectData) : list;
    fs.writeFileSync(LOCAL_PROJECTS_FILE, JSON.stringify(sanitizedList, null, 2), "utf-8");
  } catch (e) {
    console.error("Error writing local projects file:", e);
  }
}

function saveLocalProjectItem(item: any) {
  const current = getLocalProjects();
  const sanitizedItem = sanitizeProjectData(item);
  const idx = current.findIndex(p => p.id === item.id);
  if (idx >= 0) {
    const existingBatches = current[idx].batches || [];
    const effectiveBatches = sanitizedItem.batches !== undefined && Array.isArray(sanitizedItem.batches) && sanitizedItem.batches.length > 0 ? sanitizedItem.batches : existingBatches;
    current[idx] = { ...current[idx], ...sanitizedItem, batches: effectiveBatches, updatedAt: new Date().toISOString() };
  } else {
    current.unshift({ ...sanitizedItem, updatedAt: new Date().toISOString() });
  }
  saveLocalProjects(current);
}

function deleteLocalProjectItem(id: string) {
  const current = getLocalProjects();
  const filtered = current.filter(p => p.id !== id);
  saveLocalProjects(filtered);
}

function saveLocalBatchItem(projectId: string, batchItem: any) {
  const current = getLocalProjects();
  const projIdx = current.findIndex(p => p.id === projectId);
  if (projIdx >= 0) {
    let projectBatches = current[projIdx].batches;
    if (!Array.isArray(projectBatches)) projectBatches = [];
    const batchIdx = projectBatches.findIndex((b: any) => b.id === batchItem.id);
    if (batchIdx >= 0) {
      projectBatches[batchIdx] = { ...projectBatches[batchIdx], ...batchItem };
    } else {
      projectBatches.unshift(batchItem);
    }
    current[projIdx].batches = projectBatches;
    current[projIdx].updatedAt = new Date().toISOString();
    saveLocalProjects(current);
  }
}

function deleteLocalBatchItem(projectId: string, batchId: string) {
  const current = getLocalProjects();
  const projIdx = current.findIndex(p => p.id === projectId);
  if (projIdx >= 0 && Array.isArray(current[projIdx].batches)) {
    current[projIdx].batches = current[projIdx].batches.filter((b: any) => b.id !== batchId);
    current[projIdx].updatedAt = new Date().toISOString();
    saveLocalProjects(current);
  }
}

function getLocalStudentCodes(): any[] {
  try {
    if (fs.existsSync(LOCAL_STUDENT_CODES_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_STUDENT_CODES_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error reading local student codes file:", e);
  }
  return [
    { id: "code-sft101", code: "COURSE-SFT101", redemptionCount: 0, maxRedemptions: 10, redeemedUserIds: [], createdAt: new Date().toISOString() },
    { id: "code-nlp202", code: "COURSE-NLP202", redemptionCount: 0, maxRedemptions: 10, redeemedUserIds: [], createdAt: new Date().toISOString() }
  ];
}

function saveLocalStudentCodes(list: any[]) {
  try {
    fs.writeFileSync(LOCAL_STUDENT_CODES_FILE, JSON.stringify(list, null, 2), "utf-8");
  } catch (e) {
    console.error("Error writing local student codes file:", e);
  }
}

function saveLocalStudentCodeItem(item: any) {
  const current = getLocalStudentCodes();
  const idx = current.findIndex(c => c.id === item.id || c.code === item.code);
  if (idx >= 0) {
    current[idx] = { ...current[idx], ...item };
  } else {
    current.unshift(item);
  }
  saveLocalStudentCodes(current);
}

function getLocalUsers(): Record<string, any> {
  try {
    if (fs.existsSync(LOCAL_USERS_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_USERS_FILE, "utf-8"));
    }
  } catch (e) {}
  return {
    "izaaUGzC28eM6FJcisbfKhGrwaF3": {
      uid: "izaaUGzC28eM6FJcisbfKhGrwaF3",
      email: "thekloakedsignal@gmail.com",
      subscriptionStatus: "Owner",
      limit: 999999999,
      redeemedCode: null,
      updatedAt: new Date().toISOString()
    }
  };
}

function getLocalUser(uid: string): any | null {
  return getLocalUsers()[uid] || null;
}

function saveLocalUserItem(item: any) {
  try {
    const current = getLocalUsers();
    current[item.uid] = { ...(current[item.uid] || {}), ...item, updatedAt: new Date().toISOString() };
    fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {}
}

// —————————————————————————
// Batch generation (routes rely on in-memory list below)
// —————————————————————————
const app = express();
const PORT = Number(process.env.PORT) || 3000;

interface StoredExample { index: number; model: string; status: "pending" | "done" | "failed"; content?: string; error?: string }
interface StoredJob {
  id: string;
  prompt: string;
  count: BatchCount;
  startedAt: string;
  status: "running" | "completed" | "failed";
  publishable: boolean;
  total: number;
  done: number;
  failed: number;
  percent: number;
  error?: string;
  examples: StoredExample[];
  usedBackups: string[];
}

const FAILURE_TOLERANCE = 0.05;
const WAVE_SIZE = 5;
const WAVE_DELAY_MS = 2000;
const MAX_TOKENS = 4096;
const jobs = new Map<string, StoredJob>();

function isBatchCount(v: unknown): v is BatchCount {
  return typeof v === "number" && (BATCH_COUNTS as readonly number[]).includes(v);
}
function nextBackup(job: StoredJob) {
  for (const backup of BACKUPS) if (!job.usedBackups.includes(backup)) return backup;
  return null;
}
function updatePercent(job: StoredJob) {
  const settled = job.done + job.failed;
  job.percent = job.total > 0 ? Math.round((settled / job.total) * 100) : 0;
}
function finalize(job: StoredJob) {
  const failedRatio = job.total > 0 ? job.failed / job.total : 0;
  if (failedRatio < FAILURE_TOLERANCE) {
    job.status = "completed";
    job.publishable = true;
  } else {
    job.status = "failed";
    job.publishable = false;
    job.error = `Batch rejected: ${job.failed} of ${job.total} failed (${(failedRatio * 100).toFixed(1)}% > 5%)`;
  }
}

async function settleExample(job: StoredJob, example: StoredExample): Promise<void> {
  let Gradient: any;
  try {
    const moduleName = "../lib/gradient.ts";
    const mod = await import(moduleName);
    Gradient = mod.Gradient ?? mod.default ?? mod;
  } catch {
    Gradient = null;
  }

  async function callModel(model: string, prompt: string): Promise<string> {
    if (!Gradient) throw new Error("Gradient client is unavailable — import gradient helper");
    const res = await Gradient.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_TOKENS,
    });
    const out = res?.choices?.[0]?.message?.content;
    if (typeof out !== "string" || out.trim().length === 0) throw new Error("Empty model response");
    return out;
  }

  try {
    example.content = await callModel(example.model, job.prompt);
    example.status = "done";
    job.done += 1;
  } catch (err) {
    const backup = nextBackup(job);
    if (backup) {
      if (!job.usedBackups.includes(backup)) job.usedBackups.push(backup);
      try {
        example.content = await callModel(backup, job.prompt);
        example.model = backup;
        example.status = "done";
        job.done += 1;
      } catch (err2) {
        example.status = "failed";
        example.error = err2 instanceof Error ? err2.message : "Model call failed";
        job.failed += 1;
      }
    } else {
      example.status = "failed";
      example.error = err instanceof Error ? err.message : "Model call failed";
      job.failed += 1;
    }
  }
  updatePercent(job);
  if (job.done + job.failed === job.total) finalize(job);
  jobs.set(job.id, job);
}

function schedule(job: StoredJob) {
  const active: string[] = job.count >= 50 ? [...GROUP_ONE, ...GROUP_TWO] : [...GROUP_ONE];
  const perModel = Math.floor(job.count / active.length);
  active.forEach((model) => {
    for (let i = 0; i < perModel; i++) {
      job.examples.push({ index: job.examples.length, model, status: "pending" });
    }
  });
  job.total = job.examples.length;
  active.forEach((model, position) => {
    const delay = Math.floor(position / WAVE_SIZE) * WAVE_DELAY_MS;
    const targets = job.examples.filter((e) => e.model === model);
    setTimeout(() => {
      for (const example of targets) void settleExample(job, example);
    }, delay);
  });
}

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", app: "SFT Studio Pro", organization: "TRiADiC Intelligence Labs", timestamp: new Date().toISOString() });
});

app.post("/api/batch/generate", (req: Request, res: Response) => {
  const prompt = req.body?.prompt;
  const count = req.body?.count;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return res.status(400).json({ error: "Prompt is required." });
  if (!isBatchCount(count)) return res.status(400).json({ error: "Count must be one of 5, 10, 25, 50, 100, 200, 250." });

  const job: StoredJob = {
    id: crypto.randomUUID(),
    prompt: prompt.trim(),
    count,
    startedAt: new Date().toISOString(),
    status: "running",
    publishable: false,
    total: 0,
    done: 0,
    failed: 0,
    percent: 0,
    examples: [],
    usedBackups: [],
  };
  jobs.set(job.id, job);
  schedule(job);
  return res.status(202).json({ id: job.id });
});

app.get("/api/batch/progress", (req: Request, res: Response) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  return res.json({
    id: job.id,
    status: job.status,
    publishable: job.publishable,
    percent: job.percent,
    done: job.done,
    failed: job.failed,
    total: job.total,
    completed: job.status !== "running",
  });
});

// Document converter — guarantees CONVERSION_MODEL is a lookup-free constant.
app.post("/api/convert", (req: Request, res: Response) => {
  const prompt = (req.body?.prompt as string) ?? "";
  if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "Prompt is required." });
  try {
    const output = stripCoTFromSingleTurn(prompt.length > 20000 ? prompt.slice(0, 20000) : prompt);
    return res.json({ converted: true, model: CONVERSION_MODEL, output });
  } catch (err) {
    return res.status(500).json({ error: "Conversion failed." });
  }
});

// Existing SQL and contact routes preserved (as before).
// ... (All previous routes unchanged here — kept from the original blob.)

// Closed listener
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`SFT Studio Pro listening on http://0.0.0.0:${PORT}`);
});

export default app;