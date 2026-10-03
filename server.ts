import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { db } from "./src/db/index.ts";
import { projects, batches, users, studentCodes } from "./src/db/schema.ts";
import { eq, and } from "drizzle-orm";
import { optionalAuth, AuthRequest } from "./src/middleware/auth.ts";

export const Type = {
  OBJECT: "object",
  ARRAY: "array",
  STRING: "string",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  NUMBER: "number"
} as const;

dotenv.config();

// Local file storage helpers (zero-quota persistence alongside Postgres)
const DATA_DIR = path.join(process.cwd(), ".data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LOCAL_PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const LOCAL_STUDENT_CODES_FILE = path.join(DATA_DIR, "student_codes.json");
const LOCAL_USERS_FILE = path.join(DATA_DIR, "users.json");

// Robust cleaner to ensure Single Turn and non-reasoning responses NEVER contain CoT / thinking traces / internal monologue
export function stripCoTFromSingleTurn(text: string): string {
  if (!text || typeof text !== "string") return text || "";
  let s = text.trim();

  // 1. Remove XML/HTML/Bracketed thinking tags (closed and unclosed)
  const tags = [
    "think", "thought", "thoughts", "reasoning", "reflection",
    "scratchpad", "internal", "plan", "cot", "analysis",
    "inner_thought", "mind"
  ];
  for (const tag of tags) {
    const closedXml = new RegExp("<" + tag + "(?:\\s+[^>]*)?>[\\s\\S]*?<\\/" + tag + ">", "gi");
    const unclosedXml = new RegExp("<" + tag + "(?:\\s+[^>]*)?>[\\s\\S]*$", "gi");
    const closedBracket = new RegExp("\\[" + tag + "\\][\\s\\S]*?\\[\\/" + tag + "\\]", "gi");
    const unclosedBracket = new RegExp("\\[" + tag + "\\][\\s\\S]*$", "gi");
    s = s.replace(closedXml, "");
    s = s.replace(unclosedXml, "");
    s = s.replace(closedBracket, "");
    s = s.replace(unclosedBracket, "");
  }

  // 2. Multi-paragraph or single-block Thought Process followed by Response/Answer delimiter
  const answerDelimiterRegex = /(?:^|\n)\s*(?:[\*\#\_]{0,4})\s*(?:Final\s+Answer|Final\s+Response|Direct\s+Answer|Response|Answer|Output|Conclusion|Solution)\s*(?:[\*\#\_]{0,4}):?\s*(?:[\*\#\_]{0,4})\s*\n?/i;
  const thoughtHeaderRegex = /^(?:[\*\#\_\s]*)(?:Thinking\s+Process|Thought\s+Process|Chain\s+of\s+Thought|Reasoning\s+Trace|Reasoning\s+Process|Reasoning|Thoughts|Internal\s+Thoughts|Internal\s+Monologue|Scratchpad|Analysis|Draft|Planning|Step-by-step\s+reasoning|Here\s+is\s+my\s+reasoning|Here\x27s\s+my\s+thought\s+process|Let(?:\x27s|\s+me)\s+think)/i;

  if (thoughtHeaderRegex.test(s)) {
    const matches = Array.from(s.matchAll(new RegExp(answerDelimiterRegex.source, "gi")));
    if (matches && matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const remainder = s.substring(lastMatch.index + lastMatch[0].length).trim();
      if (remainder.length > 0) {
        s = remainder;
      }
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

  // 3. Standalone thinking process headers without answer delimiters
  s = s.replace(
    /(?:^|\n)\s*(?:[\*\#\_]{0,4})\s*(?:Thinking\s+Process|Thought\s+Process|Chain\s+of\s+Thought|Reasoning\s+Trace|Reasoning\s+Process|Reasoning|Thoughts|Internal\s+Thoughts|Internal\s+Monologue|Scratchpad|Analysis|Draft)\s*(?:[\*\#\_]{0,4}):?[\s\S]*?(?=(?:\n\s*(?:[\*\#\_]{0,4})\s*(?:Final\s+Answer|Response|Answer|Output|Conclusion):?|\n\s*\n[A-Z]|\n#{1,4}\s+[A-Z]|$))/gi,
    ""
  );

  // 4. Strip leftover response / answer / instruction prefix markers
  s = s.replace(/^(?:[\*\#\_\s]*)(?:Response|Instruction|Answer|Assistant|Output|Solution)(?:[\*\#\_\s]*):?\s*/i, "");

  // 5. Paragraph-level meta-monologue cleaner
  let paragraphs = s.split(/\n\s*\n/);
  while (paragraphs.length > 1) {
    const p0 = paragraphs[0].trim();
    const isP0Meta = /^(?:(?:I\s+(?:am\s+(?:analyzing|reviewing|tracing|considering|thinking)|need\s+to|will\s+(?:explain|describe|state|construct|outline|note)|must\s+first|should\s+also)|Let(?:\x27s|\s+me)\s+(?:first|analyze|think|examine|consider|break)|To\s+answer\s+this|First,\s+I\s+will|The\s+user\s+(?:wants|is\s+asking)|Here\s+is\s+(?:my\s+)?(?:step-by-step\s+)?(?:reasoning|thought|analysis))\b)/i.test(p0);
    if (isP0Meta) {
      paragraphs.shift();
      s = paragraphs.join("\n\n").trim();
    } else {
      break;
    }
  }

  // 6. Sentence-level meta-monologue cleaner for first sentences
  const metaRegex = /^(?:(?:I\s+(?:am\s+(?:analyzing|reviewing|tracing|considering|thinking)|need\s+to\s+(?:first|analyze|explain|note)|will\s+(?:explain|describe|outline|state)|should\s+first)|Let(?:\x27s|\s+me)\s+(?:first\s+)?(?:analyze|think|examine|consider|break\s+down)|To\s+answer\s+this\s+(?:question|request|prompt)?|The\s+user\s+(?:wants|is\s+asking\s+(?:for|to)?)|Here\s+is\s+my\s+(?:step-by-step\s+)?(?:thought|reasoning|analysis))\b[^.!?]*[.!?]+\s*)+/i;
  const cleanedLeading = s.replace(metaRegex, "").trim();
  if (cleanedLeading.length > 15) {
    s = cleanedLeading;
  }

  // 7. Strip instruction wrapping tokens if accidentally retained
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

  // Handle case where content is an object with { reasoning, response } or { content, reasoning }
  if (content && typeof content === "object") {
    if (!reasoning && (content.reasoning || content.reasoning_content || content.thought || content.thoughts)) {
      reasoning = content.reasoning || content.reasoning_content || content.thought || content.thoughts;
    }
    content = content.response || content.content || content.text || content.answer || content.output || (
      content.reasoning && !content.response ? content.reasoning : JSON.stringify(content)
    );
  }

  // Handle case where reasoning is an object
  if (reasoning && typeof reasoning === "object") {
    reasoning = reasoning.reasoning || reasoning.thought || reasoning.content || reasoning.text || JSON.stringify(reasoning);
  }

  let finalContent = typeof content === "string" ? content.trim() : (content !== undefined && content !== null ? String(content).trim() : "");
  // Sanitize any accidental literal "/n" string artifacts into clean newlines
  finalContent = finalContent
    .replace(/\\\/n/g, "\n")
    .replace(/(?<=\s|^)\/n(?=\s|$)/g, "\n")
    .replace(/(?<=[a-zA-Z0-9.,!?;:])\/n(?=[a-zA-Z0-9])/g, "\n")
    .replace(/\s*\/n\s*/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  let finalReasoning = typeof reasoning === "string" ? reasoning.trim() : (reasoning !== undefined && reasoning !== null ? String(reasoning).trim() : undefined);
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

  // Extract <think> or <thinking> tags from content if present
  if (role === "assistant" && typeof finalContent === "string" && finalContent.length > 0) {
    const thinkMatch = finalContent.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i);
    if (thinkMatch) {
      if (!finalReasoning && thinkMatch[1] && thinkMatch[1].trim().length > 0) {
        finalReasoning = thinkMatch[1].trim();
      }
      finalContent = finalContent.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "").trim();
    }
  }

  // Check if non-reasoning template (Reasoning traces are ONLY allowed for "Reasoning" and "Mixed" templates)
  const isReasoningOrMixed = templateType
    ? (templateType.toLowerCase().includes("reason") || templateType.toLowerCase().includes("mix"))
    : Boolean(finalReasoning);
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

  // 1. Convert alternate SFT formats (conversations, instruction/output, prompt/response) into messages
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

  // 2. Sanitize and clean message turns
  const isReasoningOrMixed = effectiveTemplate
    ? (effectiveTemplate.toLowerCase().includes("reason") || effectiveTemplate.toLowerCase().includes("mix"))
    : false;

  let cleanedMessages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map((m: any) => sanitizeMessage(m, effectiveTemplate))
    .filter((m: any) => m && typeof m.content === "string" && m.content.trim().length > 0);

  // If conversation has no user message or no assistant message, repair it
  const hasUser = cleanedMessages.some((m: any) => m.role === "user");
  const hasAssistant = cleanedMessages.some((m: any) => m.role === "assistant");

  if (!hasUser && cleanedMessages.length > 0) {
    cleanedMessages.unshift({ role: "user", content: "Provide instruction." });
  }
  if (!hasAssistant && cleanedMessages.length > 0) {
    cleanedMessages.push({ role: "assistant", content: "Completed response." });
  }

  const sanitizedExample: any = {
    ...example,
    templateType: effectiveTemplate,
    messages: cleanedMessages
  };

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
          return {
            ...b,
            examples: b.examples.map((ex: any) => sanitizeExample(ex, bTemplate))
          };
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
      if (Array.isArray(parsed)) {
        return parsed.map(sanitizeProjectData);
      }
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
    const effectiveBatches = sanitizedItem.batches !== undefined && Array.isArray(sanitizedItem.batches) && sanitizedItem.batches.length > 0
      ? sanitizedItem.batches
      : existingBatches;
    current[idx] = {
      ...current[idx],
      ...sanitizedItem,
      batches: effectiveBatches,
      updatedAt: new Date().toISOString()
    };
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
  } catch (e) {
    // Ignore error
  }
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
  const usersMap = getLocalUsers();
  return usersMap[uid] || null;
}

function saveLocalUserItem(item: any) {
  try {
    const current = getLocalUsers();
    current[item.uid] = {
      ...(current[item.uid] || {}),
      ...item,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {
    // Ignore error
  }
}

// Initialize the Express app
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Set up middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Health Check Endpoint
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", app: "SFT Studio Pro", organization: "TRiADiC Intelligence Labs", timestamp: new Date().toISOString() });
});

// Local / SQL Database API Endpoints
app.get("/api/sql/projects", optionalAuth, async (req: AuthRequest, res) => {
  const userId = req.user?.uid || req.deviceId || (req.query.userId as string) || "default";

  const allLocal = getLocalProjects();

  try {
    const userProjects = await db.select().from(projects);
    if (userProjects && userProjects.length > 0) {
      const merged = userProjects.map(sp => {
        const lp = allLocal.find(p => p.id === sp.id);
        const spBatches = Array.isArray(sp.batches) ? sp.batches : [];
        const lpBatches = (lp && Array.isArray(lp.batches)) ? lp.batches : [];
        return {
          ...sp,
          settings: sp.settings || lp?.settings || {},
          batches: lpBatches.length >= spBatches.length ? lpBatches : spBatches
        };
      });
      allLocal.forEach(lp => {
        if (!merged.some(m => m.id === lp.id)) {
          merged.push(lp);
        }
      });
      const filtered = merged.filter(p => p.userId === userId || p.userId === "default" || !p.userId || userId === "default");
      return res.json({ success: true, projects: filtered.length > 0 ? filtered : merged });
    }
  } catch (error: any) {
    console.warn("SQL db list projects fallback to local storage:", error?.message);
  }

  const userProjects = allLocal.filter(p => p.userId === userId || p.userId === "default" || !p.userId || userId === "default");
  return res.json({ success: true, projects: userProjects.length > 0 ? userProjects : allLocal });
});

app.post("/api/sql/projects", optionalAuth, async (req: AuthRequest, res) => {
  const { id, name, settings, batches: batchList } = req.body;
  const userId = req.user?.uid || req.deviceId || req.body.userId || "default";

  if (!id || !name) {
    return res.status(400).json({ success: false, error: "Missing required project id or name." });
  }

  const currentLocal = getLocalProjects();
  const existingProj = currentLocal.find(p => p.id === id);
  const effectiveBatches = batchList !== undefined ? batchList : (existingProj?.batches || []);

  saveLocalProjectItem({
    id,
    userId,
    name,
    settings: settings || {},
    batches: effectiveBatches
  });

  try {
    await db.insert(projects)
      .values({
        id,
        userId,
        name,
        settings: settings || {},
        batches: effectiveBatches,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          name,
          settings: settings || {},
          batches: effectiveBatches,
          updatedAt: new Date()
        }
      });
  } catch (error: any) {
    console.warn("SQL db save project saved to local store fallback:", error?.message);
  }

  return res.json({ success: true, id });
});

// Incremental single-batch save/update route
app.post("/api/sql/projects/:id/batches", optionalAuth, async (req: AuthRequest, res) => {
  const projectId = req.params.id;
  const { batch } = req.body;
  if (!projectId || !batch || !batch.id) {
    return res.status(400).json({ success: false, error: "Missing projectId or batch payload." });
  }

  saveLocalBatchItem(projectId, batch);

  try {
    await db.insert(batches)
      .values({
        id: batch.id,
        projectId,
        name: batch.name || "SFT Batch",
        timestamp: batch.timestamp || new Date().toISOString(),
        templateType: batch.templateType || "Single Turn",
        data: batch,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: batches.id,
        set: {
          name: batch.name || "SFT Batch",
          timestamp: batch.timestamp || new Date().toISOString(),
          templateType: batch.templateType || "Single Turn",
          data: batch,
          updatedAt: new Date()
        }
      });
  } catch (error: any) {
    console.warn("SQL db save single batch notice:", error?.message);
  }

  return res.json({ success: true, batchId: batch.id });
});

// Incremental single-batch delete route
app.delete("/api/sql/projects/:id/batches/:batchId", optionalAuth, async (req: AuthRequest, res) => {
  const { id: projectId, batchId } = req.params;
  if (!projectId || !batchId) {
    return res.status(400).json({ success: false, error: "Missing projectId or batchId." });
  }

  deleteLocalBatchItem(projectId, batchId);

  try {
    await db.delete(batches).where(and(eq(batches.id, batchId), eq(batches.projectId, projectId)));
  } catch (error: any) {
    console.warn("SQL db delete batch notice:", error?.message);
  }

  return res.json({ success: true });
});

app.get("/api/sql/projects/:id", optionalAuth, async (req: AuthRequest, res) => {
  const projId = req.params.id;
  const allLocal = getLocalProjects();
  const foundLocal = allLocal.find(p => p.id === projId);

  try {
    const projRows = await db.select().from(projects).where(eq(projects.id, projId));
    if (projRows.length > 0) {
      const sqlProj = projRows[0];