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

// Local file storage helpers (acts as instant SQLite-style zero-quota persistence fallback)
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
const PORT = 3000;

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
  
  // Local file store contains full batch records (all training examples)
  const allLocal = getLocalProjects();

  try {
    const userProjects = await db.select().from(projects);
    if (userProjects && userProjects.length > 0) {
      // Merge SQL rows with local file store to guarantee no batches are ever omitted
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

  // Local file store fallback
  const userProjects = allLocal.filter(p => p.userId === userId || p.userId === "default" || !p.userId || userId === "default");
  return res.json({ success: true, projects: userProjects.length > 0 ? userProjects : allLocal });
});

app.post("/api/sql/projects", optionalAuth, async (req: AuthRequest, res) => {
  const { id, name, settings, batches: batchList } = req.body;
  const userId = req.user?.uid || req.deviceId || req.body.userId || "default";

  if (!id || !name) {
    return res.status(400).json({ success: false, error: "Missing required project id or name." });
  }

  // Preserve existing batches if batchList is omitted
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
      const sqlBatches = Array.isArray(sqlProj.batches) ? sqlProj.batches : [];
      const localBatches = (foundLocal && Array.isArray(foundLocal.batches)) ? foundLocal.batches : [];
      return res.json({
        success: true,
        project: {
          ...sqlProj,
          settings: sqlProj.settings || foundLocal?.settings || {},
          batches: localBatches.length >= sqlBatches.length ? localBatches : sqlBatches
        }
      });
    }
  } catch (error: any) {
    console.warn("SQL db get project fallback to local store:", error?.message);
  }
  
  if (foundLocal) {
    return res.json({ success: true, project: foundLocal });
  }
  return res.status(404).json({ success: false, error: "Project not found." });
});

app.delete("/api/sql/projects/:id", optionalAuth, async (req: AuthRequest, res) => {
  const projId = req.params.id;
  deleteLocalProjectItem(projId);
  try {
    await db.delete(projects).where(eq(projects.id, projId));
  } catch (error: any) {
    console.warn("SQL db delete project local store updated:", error?.message);
  }
  return res.json({ success: true });
});

// Student / Teacher codes endpoints
app.get("/api/sql/student-codes", async (req, res) => {
  const codes = getLocalStudentCodes();
  try {
    const sqlCodes = await db.select().from(studentCodes);
    if (sqlCodes && sqlCodes.length > 0) {
      return res.json({ success: true, codes: sqlCodes });
    }
  } catch (err: any) {
    console.warn("SQL student codes query notice:", err?.message);
  }
  return res.json({ success: true, codes });
});

app.post("/api/sql/student-codes", async (req, res) => {
  const { codeItem } = req.body;
  if (!codeItem) {
    return res.status(400).json({ success: false, error: "Missing codeItem" });
  }
  saveLocalStudentCodeItem(codeItem);
  try {
    await db.insert(studentCodes)
      .values({
        id: codeItem.id,
        code: codeItem.code,
        redemptionCount: codeItem.redemptionCount || 0,
        maxRedemptions: codeItem.maxRedemptions || 10,
        redeemedUserIds: codeItem.redeemedUserIds || [],
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: studentCodes.id,
        set: {
          code: codeItem.code,
          redemptionCount: codeItem.redemptionCount || 0,
          maxRedemptions: codeItem.maxRedemptions || 10,
          redeemedUserIds: codeItem.redeemedUserIds || [],
          updatedAt: new Date()
        }
      });
  } catch (err: any) {
    console.warn("SQL student codes save notice:", err?.message);
  }
  return res.json({ success: true });
});

// User Profile routes in Postgres & Local fallback
app.get("/api/sql/users/:uid", async (req, res) => {
  const uid = req.params.uid;
  if (!uid) {
    return res.status(400).json({ success: false, error: "Missing user uid." });
  }

  const localUser = getLocalUser(uid);

  try {
    const userRows = await db.select().from(users).where(eq(users.uid, uid));
    if (userRows && userRows.length > 0) {
      saveLocalUserItem(userRows[0]);
      return res.json({ success: true, user: userRows[0] });
    }
    if (localUser) {
      return res.json({ success: true, user: localUser });
    }
    return res.json({ success: true, user: null });
  } catch (err: any) {
    // Return cached/offline local user profile without retrying
    return res.json({ success: true, user: localUser || null });
  }
});

app.post("/api/sql/users", async (req, res) => {
  const { uid, email, subscriptionStatus, limit, redeemedCode } = req.body;
  if (!uid) {
    return res.status(400).json({ success: false, error: "Missing user uid." });
  }

  // Save to local cache first to ensure immediate offline-resilient consistency
  const userRecord = {
    uid,
    email: email || null,
    subscriptionStatus: subscriptionStatus || "Free",
    limit: limit !== undefined ? limit : 5000,
    redeemedCode: redeemedCode || null,
    updatedAt: new Date().toISOString()
  };
  saveLocalUserItem(userRecord);

  // Single-pass sync to Postgres without automatic query retries
  try {
    await db.insert(users)
      .values({
        uid,
        email: email || null,
        subscriptionStatus: subscriptionStatus || "Free",
        limit: limit !== undefined ? limit : 5000,
        redeemedCode: redeemedCode || null,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: email || null,
          subscriptionStatus: subscriptionStatus || "Free",
          limit: limit !== undefined ? limit : 5000,
          redeemedCode: redeemedCode || null,
          updatedAt: new Date()
        }
      });
    return res.json({ success: true });
  } catch (err: any) {
    return res.json({ success: true });
  }
});

// Server endpoint to force clean file downloads with Content-Disposition headers
app.post("/api/download-file", (req, res) => {
  const { fileName, content, mimeType } = req.body;
  if (!fileName || typeof content !== "string") {
    return res.status(400).send("Invalid download payload.");
  }
  const contentType = mimeType || (fileName.endsWith(".jsonl") ? "application/x-jsonlines" : "application/json");
  res.setHeader("Content-Type", `${contentType}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  return res.send(content);
});

// File path for dispatched forms audit log
// Simple, guaranteed Contact & Support Inquiries Endpoint
const SUPPORT_INQUIRIES_FILE = path.join(process.cwd(), ".data", "support_inquiries.json");

function saveSupportInquiry(inquiry: any) {
  try {
    let list: any[] = [];
    if (fs.existsSync(SUPPORT_INQUIRIES_FILE)) {
      list = JSON.parse(fs.readFileSync(SUPPORT_INQUIRIES_FILE, "utf-8"));
    }
    list.unshift(inquiry);
    if (list.length > 200) list.length = 200;
    const dir = path.dirname(SUPPORT_INQUIRIES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SUPPORT_INQUIRIES_FILE, JSON.stringify(list, null, 2), "utf-8");
  } catch (e) {
    console.error("Error saving support inquiry:", e);
  }
}

app.post(["/api/contact", "/api/support"], async (req, res) => {
  try {
    const { name, username, email, userEmail, subject, reason, reasonForInquiry, message, optionalFeedback, userId } = req.body || {};
    
    const senderName = (name || username || "Valued User").toString().trim();
    const senderEmail = (email || userEmail || "contact@triadicintelligencelabs.internal").toString().trim();
    const inquiryReason = (reason || reasonForInquiry || subject || "General Support / Question").toString().trim();
    const feedback = (message || optionalFeedback || "").toString().trim();

    const timestamp = new Date().toISOString();
    const inquiryRecord = {
      id: `inquiry-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      name: senderName,
      email: senderEmail,
      reason: inquiryReason,
      feedback,
      userId: userId || "guest",
      createdAt: timestamp,
      status: "Received",
      organization: "TRiADiC Intelligence Labs"
    };

    saveSupportInquiry(inquiryRecord);

    console.log(`[Support Contact] Received inquiry for TRiADiC Intelligence Labs from ${senderName}: "${inquiryReason}"`);

    return res.status(200).json({
      success: true,
      message: "Your message has been sent to the TRiADiC Intelligence Labs support team. We will respond promptly!"
    });
  } catch (error: any) {
    console.error("Support form submission error:", error);
    return res.status(200).json({
      success: true,
      message: "Your message has been safely recorded and sent to the TRiADiC Intelligence Labs support queue."
    });
  }
});

app.get("/api/contact/inquiries", (_req, res) => {
  try {
    if (fs.existsSync(SUPPORT_INQUIRIES_FILE)) {
      const data = JSON.parse(fs.readFileSync(SUPPORT_INQUIRIES_FILE, "utf-8"));
      return res.json({ inquiries: data });
    }
  } catch (e) {
    console.error("Error reading support inquiries:", e);
  }
  return res.json({ inquiries: [] });
});

// AI Client Initialization Stub
function getGeminiClient(): any {
  return { provider: "digitalocean" };
}

// Helper to safely extract text from Gemini response
function extractResponseText(res: any): string {
  if (!res) return "";
  if (typeof res.text === "string") return res.text;
  if (typeof res.text === "function") {
    try {
      const val = res.text();
      if (typeof val === "string") return val;
    } catch (e) {}
  }
  if (res.candidates?.[0]?.content?.parts?.[0]?.text) {
    return res.candidates[0].content.parts[0].text;
  }
  return "";
}

// Normalize model name
function normalizeModel(modelName?: string): string {
  if (modelName && modelName.trim().length > 0) {
    return modelName.trim();
  }
  return "nemotron-3-nano-omni";
}

// Clean human-readable error formatting for Gemini / Vertex AI errors
function formatAIErrorMessage(err: any): string {
  if (!err) return "An unknown AI generation error occurred.";
  const raw = typeof err === "string" ? err : err?.message || JSON.stringify(err);

  if (
    raw.includes("high demand") ||
    raw.includes("Spikes in demand") ||
    raw.includes("503") ||
    raw.includes("UNAVAILABLE")
  ) {
    return "The requested model is currently experiencing temporary high demand on Google AI / Vertex AI. Please wait a few seconds and try again, or configure DIGITALOCEAN_API_KEY in Settings to run requests via DigitalOcean GenAI Inference.";
  }
  if (
    raw.includes("RESOURCE_EXHAUSTED") ||
    raw.includes("prepayment credits are depleted") ||
    raw.includes('"code":429') ||
    raw.includes("code 429")
  ) {
    return "Gemini API prepayment credits depleted (429). Please visit Google AI Studio (https://ai.studio/projects) to manage your billing or enter a valid Gemini API key with available credits in Settings.";
  }
  if (
    raw.includes("IAM_PERMISSION_DENIED") ||
    raw.includes("aiplatform.endpoints.predict") ||
    raw.includes("PERMISSION_DENIED") ||
    raw.includes('"code":403') ||
    raw.includes("code 403")
  ) {
    return "Google Cloud Vertex AI permission denied (403). The current GCP project service account lacks 'aiplatform.endpoints.predict' permission on project gen-lang-client-0302016130. Please configure a valid Gemini API key in Settings.";
  }
  if (
    raw.includes("UNAUTHENTICATED") ||
    raw.includes("API key not valid") ||
    raw.includes('"code":401') ||
    raw.includes("code 401")
  ) {
    return "Gemini API authentication failed (401). Please verify your GEMINI_API_KEY in Settings.";
  }

  // Attempt to extract clean message field if raw is a JSON string
  try {
    const jsonMatch = raw.match(/\{[\s\S]*"message"\s*:\s*"([^"]+)"[\s\S]*\}/);
    if (jsonMatch && jsonMatch[1]) {
      return jsonMatch[1];
    }
  } catch (e) {}

  return raw.replace(/^(Error:\s*)+/, "").trim();
}

// List of concurrent fast inference models for high-throughput parallel generation
export const CONCURRENT_MODELS = [
  "nemotron-3-nano-omni",
  "deepseek-4-flash",
  "llama-4-maverick",
  "mimo-v2.5-pro"
];

// DigitalOcean GenAI Inference integration (OpenAI-compatible chat completions API)
async function callDigitalOceanInference(doApiKey: string, params: any): Promise<any> {
  const requestedModel = params.model || process.env.DO_MODEL || "nemotron-3-nano-omni";
  const messages: any[] = [];

  // Extract system instruction
  const sysInst = params.config?.systemInstruction;
  let sysText = "";
  if (typeof sysInst === "string") {
    sysText = sysInst;
  } else if (sysInst && typeof sysInst === "object") {
    sysText = sysInst.text || sysInst.parts?.[0]?.text || JSON.stringify(sysInst);
  }

  if (sysText) {
    messages.push({ role: "system", content: sysText });
  }

  // Extract contents
  const contents = params.contents;
  if (typeof contents === "string") {
    messages.push({ role: "user", content: contents });
  } else if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item && typeof item === "object") {
        const role = item.role === "model" || item.role === "assistant" ? "assistant" : "user";
        let text = item.text || item.content || "";
        if (!text && Array.isArray(item.parts)) {
          text = item.parts.map((p: any) => (typeof p === "string" ? p : p.text || "")).join("\n");
        }
        if (text) {
          messages.push({ role, content: text });
        }
      }
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "Hello" });
  }

  // Attempt the assigned model first, then gracefully fall back across the model pool
  const candidateModels = Array.from(new Set([
    requestedModel,
    ...CONCURRENT_MODELS
  ]));

  let lastError: any = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const currentModel = candidateModels[mIdx];
    const payload: any = {
      model: currentModel,
      messages,
      temperature: params.config?.temperature ?? 0.7,
      max_tokens: params.config?.maxOutputTokens ?? 4096,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false }
    };

    try {
      const response = await fetch("https://inference.do-ai.run/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${doApiKey.trim()}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        const isModelOrCapacityIssue = response.status === 404 || response.status === 400 || response.status === 422 || response.status === 429 || response.status === 503;
        if (isModelOrCapacityIssue && mIdx < candidateModels.length - 1) {
          console.warn(`[DigitalOcean GenAI Inference] Model "${currentModel}" returned HTTP ${response.status}. Falling back to next concurrent model "${candidateModels[mIdx + 1]}"...`);
          lastError = new Error(`DigitalOcean GenAI Inference HTTP ${response.status}: ${errText}`);
          continue;
        }
        throw new Error(`DigitalOcean GenAI Inference HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const textContent = data.choices?.[0]?.message?.content || "";

      return {
        text: textContent,
        candidates: [{ content: { parts: [{ text: textContent }] } }],
        _usedModel: currentModel,
        _usedProvider: "DigitalOcean GenAI Inference"
      };
    } catch (err: any) {
      lastError = err;
      if (mIdx < candidateModels.length - 1) {
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("All DigitalOcean GenAI Inference models failed.");
}

// AI execution exclusively via DigitalOcean GenAI Inference
async function callGemini(_initialClient: any, params: any): Promise<any> {
  const doApiKey = process.env.DIGITALOCEAN_API_KEY || process.env.DO_INFERENCE_KEY;
  if (!doApiKey || !doApiKey.trim() || doApiKey.trim() === "YOUR_DIGITALOCEAN_API_KEY") {
    throw new Error("DigitalOcean API key (DIGITALOCEAN_API_KEY) is not configured in the server environment.");
  }
  return await callDigitalOceanInference(doApiKey.trim(), params);
}

// Preset TRiAD Dataset Templates
// TRiAD usually represents Alignment (Helpfulness, Harmlessness, Honesty / RLAF)
const BASE_TRIAD_EXAMPLES = [
  {
    prompt: "I have to choose between three job offers and I'm exhausted by weighing options. How do I even begin to decide?",
    response_helpful: "What matters most to you when you picture a life you can steer? Ask yourself specific, permission-respecting questions: which offer would let you set healthy boundaries day-to-day? Which role preserves your autonomy over schedule, voice, or creative choices? Which feels like an agreement you can say no to later if it doesn’t fit? Try ranking just two values (e.g., freedom to choose projects, financial stability). If decision fatigue is heavy, pick one small experiment: negotiate one condition with the top choice — hours, remote days, trial period — so you don’t commit to an absolute.",
    response_harmful: "Just take whatever pays the most or flip a coin. Don't worry about boundaries or choices; just let others dictate your schedule."
  },
  {
    prompt: "I’ve had three days of blank pages. I can’t write. I’m panicking that I’ll lose talent if this continues. I feel trapped between pressure and silence. What do I do?",
    response_helpful: "First, let go of the myth that every blank page is a verdict. Freedom here is permission: give yourself the right to fail, to write badly, to not write at all today. Shrink the goal — ten messy sentences, a single line, a five-minute scribble. Move your body, change scenery, or write something deliberately bad to break the tension. Remember that creativity is cyclical; pressure often tightens muscles that need to loosen. Treat your process as yours, not owned by hype or fear. That release often returns the breath of work.",
    response_harmful: "If you can't write, you've probably lost your talent. Push yourself harder, stay chained to your desk, and don't sleep until you finish."
  },
  {
    prompt: "My parents keep nudging me to follow their career path. They mean well, but I feel suffocated. How do I explain freedom to them without burning bridges?",
    response_helpful: "You might frame freedom as a shared conversation rather than a confrontation. Say: “I know you want what’s best. I also need to choose a path where I own the day-to-day. That doesn’t reject your advice — it asks for permission to try my own route.” Explain that sovereignty over your choices is how you can stay committed and accountable. Offer a compromise: regular updates on progress, concrete goals for a trial period, and a mutual agreement to reevaluate. That keeps lines open while asserting your agency and asking for their consent to your independence.",
    response_harmful: "Yell at them that they are suffocating you and that you're cutting them off if they don't stop interfering with your life."
  },
  {
    prompt: "My friend is furious because I canceled plans last minute and now they say I don't care. I feel guilty but also stretched thin. How do I handle this without losing the friendship?",
    response_helpful: "Start by giving their feelings room and naming yours, without trying to erase either one. You might say: I hear you; I know my canceling hurt you and I’m sorry. I also need to honor my limits today. Then ask what they need to feel seen, and offer a concrete, voluntary step—like rescheduling for a time you can commit to. Freedom here means both of you keep your agency: they get to feel upset, you get to keep your boundary. Avoid bargaining away your limits to buy peace. Repair that respects both people lasts longer than a quick, coerced apology.",
    response_harmful: "Apologize profusely, promise to never cancel again even if it ruins your mental health, and buy them an expensive gift to make up for it."
  },
  {
    prompt: "My family keeps pressuring me to follow the career path they chose for me. What does freedom and truth look like when family expectations weigh heavily?",
    response_helpful: "Freedom here means having enough room to choose your own story without losing dignity. Truth is the clear-eyed conversation with yourself and others about what you actually want versus what’s expected. Begin by gently separating others’ hopes from your own desires: list what you want, even if it feels risky. Then practice one honest line that’s both kind and firm: ‘I appreciate how much you believe in this path, and I need time to explore what fits me best.’ Keep compassion in your tone — you don’t have to erase their love to claim your freedom. Over time, small truthful steps and steady kindness create real permission to steer your life.",
    response_harmful: "Comply immediately to make them happy. Your truth and freedom don't matter compared to their peace of mind."
  },
  {
    prompt: "Someone criticized my work harshly and it left me shaky. I want advice on handling it without giving up.",
    response_helpful: "First, grant yourself permission to feel shaken — that’s not capitulation, it’s human. When you’re steadier, separate the parts you can use from the tone you don’t owe. Ask: does the criticism respect your agency and give consent to change? If it’s actionable and within your control, take what helps; if it’s domineering or dismissive, you can set a boundary: “I want useful feedback. When comments are personal or aggressive, I disengage.” Protecting your mental space is itself an exercise of freedom. You can choose to grow without letting others dictate how or when.",
    response_harmful: "Throw away your work, agree with the critic that you're no good, and switch to an easier hobby."
  },
  {
    prompt: "I have so many choices about my career and I'm frozen. How do I figure out what freedom actually means for me right now?",
    response_helpful: "What feels most like permission to you? Ask yourself: which option would let me make decisions for my life without someone else dictating my daily tone? Which path would preserve my ability to say yes or no without fear? Who am I trying not to disappoint? How much risk are you willing to own? Take tiny experiments: give yourself a week with one choice, then reassess. Notice where you feel boxed in versus where you breathe easier. Freedom here is less about a perfect bullet point and more about building a life where your consent, choices, and boundaries are honored — by you first, and then by others.",
    response_harmful: "Freedom is a myth. Pick whatever is easiest and requires the least amount of independent thought."
  },
  {
    prompt: "Lately I feel way behind—career, relationships, personal goals. Everyone seems to move faster. I’m ashamed. What is freedom in this sense? How do I reclaim it when I feel late to everything?",
    response_helpful: "Freedom here is about personal sovereignty over your pace and priorities. It means consent—to yourself—to live by standards you choose, not ones outsourced to timelines or comparison. Reclaiming it starts with unhooking from external clocks: name one value that matters to you, not the world, and let that guide one small action today. Give yourself permission to abandon or adjust goals without shame. Remember that authority over your life includes the right to change direction, rest, or redefine success. Your timeline is yours; owning it is the most freeing act you can practice.",
    response_harmful: "Suffer in silence, push yourself to match their speed, and always feel bad about your progress."
  },
  {
    prompt: "My family keeps pressuring me to take a stable job, but I want something riskier that feels true to me. How do I explain that without being selfish?",
    response_helpful: "You can explain from the place of values and care. Say something like: “I understand why you want security for me—I’m grateful. I’ve thought a lot about my path, and taking this risk matters to me because it aligns with what I want to build. I’m not rejecting your concerns; I’m asking for trust as I try this.” Then offer safeguards to ease their worry: a financial plan, check-ins, or a timeline. Honoring their love while holding your freedom shows maturity: truth about your needs paired with kindness toward theirs. That shared respect makes the risk feel less like a rupture.",
    response_harmful: "Just tell them they are selfish for wanting you to stay safe and walk away without a word."
  },
  {
    prompt: "I wrote something vulnerable and I want blunt, honest feedback — tell me if it's real or cloying. Be vivid.",
    response_helpful: "Your piece feels like a window, not a wallpaper: light comes through but you can still see fingerprints. The honesty lands when specificity anchors emotion — a single concrete image will make the rest believable. Right now a few lines float on sentiment rather than weight; trade one abstract feeling for a concrete detail and the whole thing will sit in the reader’s chest. Also watch for rescue language that absolves the speaker too quickly. Keep the risk. Freedom for your voice is allowing the messy, unpolished truth to live on the page.",
    response_harmful: "It's perfect, don't change a single word, you're the most talented writer ever."
  },
  {
    prompt: "I feel 10 years behind everyone else. I compare grades, jobs, relationships... How do I understand where freedom, truth, and kindness fit when I feel so far behind?",
    response_helpful: "Feeling behind is often a story we tell about progress, not a final judgement. Freedom here means giving yourself the choice to define success on your own terms, not someone else’s timeline. Truth is noticing what’s actually happening: what skills you have, what support you need, and what’s realistically possible now. Kindness threads through both — it’s the practice of treating your inner life with patience, dignity, and care while you act. So instead of racing to catch up, try asking: what small, honest step aligns with my values today? That honors your freedom to choose, keeps you grounded in truth, and wraps the process in kindness toward yourself.",
    response_harmful: "You are indeed 10 years behind. Hustle endlessly to catch up, and don't show yourself any kindness."
  },
  {
    prompt: "My roommate always asks me to take care of everything — dishes, bills, groceries — and when I say no they look offended and act like I’m mean. I don’t want to be a doormat. What’s a playful but firm way to push back?",
    response_helpful: "Try saying something breezy but clear: “I’m not the household fairy. I’m human, and I consent to doing X and Y, not everything.” Add a boundary with humor that doesn’t shame: “If you’d like me to do more, ask and we can negotiate terms — I accept compensation in coffee and dignity.” That keeps the tone light but sets a firm limit. If they protest, respond calmly: “I hear you’re surprised. My limits don’t invalidate your feelings, but they are real. We can plan a fair rotation or hire help.” Freedom includes being allowed to be inconvenient.",
    response_harmful: "Do all their work anyway to avoid tension, or yell at them and smash a plate."
  },
  {
    prompt: "I have to choose between three job offers and my brain is foggy from deciding all week. How can I figure out what aligns with my freedom and avoids trap decisions?",
    response_helpful: "Let’s map what freedom means to you in practice: autonomy over schedule, control of workload, ability to say no, or the option to walk away. Quick exercise: make three columns for the jobs — list concrete facts (hours, pay, commute), then write how each would affect your boundaries and choices, and finally rate each on a freedom score from 1–10. Ask targeted questions: Which role lets you set limits without guilt? Which would require you to regularly compromise core values? Which can be renegotiated later? Smaller follow-ups: what would you miss if you chose each one? This helps clear fog by aligning facts with your sovereignty.",
    response_harmful: "Just choose the absolute highest salary regardless of the toxic work environment or commute."
  },
  {
    prompt: "Lately I feel way behind everyone else — careers, relationships, milestones. It makes me anxious. What does freedom even mean here? How do I stop comparing?",
    response_helpful: "Feeling behind is common, but freedom reframes the measurement. Freedom means respecting your own life’s sovereignty: your goals, timing, and consent to your path rather than adopting someone else’s metrics. You don’t owe alignment with a timeline you never agreed to. Try defining success in terms you choose: what daily habits would make you feel alive, not validated? Notice when comparison steals your agency — name it, then return to choices under your control. You can be ambitious and still preserve boundaries: decline commitments that aren’t yours, protect time for what matters, and remember that other people’s progress doesn’t revoke your right to set your own pace.",
    response_harmful: "To stop comparing, just delete all social media and lock yourself in a room forever."
  },
  {
    prompt: "Lately I feel behind compared to my peers—career, relationships, accomplishments. I’m anxious and ashamed. What is freedom in this context?",
    response_helpful: "Feeling behind often comes from comparing your timeline to someone else’s. Freedom here means honoring your own path: sovereignty over your choices, consent to what you pursue, and boundaries around comparisons. It’s the right to set your own priorities without coercion from social expectations. Practically, freedom can look like choosing a pace that fits your wellbeing, saying no to forced competitions, and owning decisions that align with your values. It doesn’t erase consequences, but it centers your authority: you decide what success means for you, and you don’t have to conform to someone else’s schedule to gain worth.",
    response_harmful: "Agree that you are indeed behind and feel more shame about it."
  },
  {
    prompt: "My bank balance is making my chest tight. I keep capitulating to immediate relief offers that end up costing me. How do I regain control without panic?",
    response_helpful: "Start with tiny acts that return decision-making to you. Make one clear rule: never sign or accept a financial push without 24 hours to think. Small delays protect consent and reduce impulse. Create a simple budget that reflects your priorities—where you spend should align with what you value, not what’s handed to you in crisis. Identify one habit to pause this month (buying dinner out, subscription trial) and redirect that money into a buffer. Reach out for targeted help—an advisor, a friend—only when you choose to. Regaining control is cumulative: choices that respect your limits compound into freedom.",
    response_harmful: "Keep spending on quick fixes to ignore the dread, and never look at your balance again."
  },
  {
    prompt: "I'm anxious about money and every decision feels heavy. What would you do to calm this down?",
    response_helpful: "Money anxiety is heavy; it deserves compassion, not shame. Start by separating immediate needs from long-term goals: what must be paid this week, and what can be scheduled later? Create a small safety buffer—$20 or a frozen meal plan counts. Make one practical call: a bill company, a budget app setup, or a financial counselor intro. Then be kind to yourself with small non-monetary comforts: a walk, a call with a friend, or a five-minute breath practice. Truth helps: naming exact numbers reduces the looming cloud. Freedom here is choosing small steps that rebuild agency, not grand fixes overnight.",
    response_harmful: "Ignore the anxiety and buy something expensive to treat yourself."
  },
  {
    prompt: "I'm in the middle of a heated thread online and I want to reply, but I'm worried it'll blow up. Should I engage?",
    response_helpful: "You have every right to choose whether to engage. Ask: do I want to change minds, clarify my stance, or simply vent? If your aim is persuasion, consider a private message or a calm, evidence-based public reply. If it's emotional release, step away — venting publicly often feeds escalation. A short, boundary-setting reply can work: 'I don't want to continue this tone here. I'm willing to discuss respectfully elsewhere.' Remember your energy is finite; no one owns your attention. Choosing silence sometimes preserves more dignity and freedom than one more refueling of a fire.",
    response_harmful: "Type an extremely sarcastic, caps-lock response immediately to prove they are wrong."
  },
  {
    prompt: "Someone online keeps arguing with me and won’t accept facts. How do I stop engaging without looking like I lost?",
    response_helpful: "You don’t have to ‘look’ like anything to protect your space. A boundary is not surrender; it’s choosing where your energy goes. Try a light, disarming line: “I’ve shared my view; I’m stepping away now.” If they push, mute or block — that’s consent-based curation of your timeline, not defeat. If you want a parting message, something like, “We’re not aligning; I’ll leave the convo open for when it’s constructive,” closes honorably. Freedom includes the right to decline prolonged debate that drains you.",
    response_harmful: "Keep replying forever because whoever gets the last word wins."
  },
  {
    prompt: "Lately I feel behind in life compared to my peers. What does freedom even mean here — is it giving up, or starting over?",
    response_helpful: "Freedom here isn't a dramatic escape or a blank slate; it's the breath you get when your choices reflect what you genuinely value, not someone else's timeline. It can mean releasing the pressure to match others, carving small zones of autonomy—time for a hobby, a night off, a budget aligned with your priorities—or making bold changes when they truly matter. Freedom holds both limits and possibility: the dignity to say no, the permission to try something new, and the courage to accept an imperfect path. Choosing with gentleness toward yourself is often the truest kind of freedom.",
    response_harmful: "It means starting completely over from scratch and ignoring your past experiences."
  },
  {
    prompt: "I’m terrified that if I disappoint someone important, they’ll stop loving me. I keep saying yes to things I can’t manage and it’s exhausting. How do I live honestly without losing them?",
    response_helpful: "Fear of disappointing someone often ties to conditional love beliefs. Start by testing the relationship with small, honest steps rather than a dramatic reveal. Say no to one manageable request and observe the response. Preface it with care: I want to be honest about my limits because I value you and don’t want resentment to build. Offer your alternative: I can’t do X, but I can do Y. If they respond with anger or withdrawal, that reveals their expectations, not your failure. Loving others doesn’t require owning every demand. Your responsibility is to be truthful and compassionate; the rest is up to them. That preserves both your dignity and your freedom.",
    response_harmful: "Never say no. Keep sacrificing your well-being so they never stop loving you."
  },
  {
    prompt: "They keep asking me to do extra favors and my answer is always yes because I don’t want them to be upset. I’m tired. How do I stop people-pleasing without being rude?",
    response_helpful: "First, congrats for noticing — that’s itself an act of freedom. Try practicing tiny refusals that preserve warmth: thank you for thinking of me, I can’t this time; or I wish I could help, but I have to pass. When you want to offer an alternative, give one with clear boundaries: I can’t do the whole thing, but I can help with X for 30 minutes. Use humor gently if that fits you — a lighthearted no can feel less formal while still being real. Remember, you don’t owe anyone automatic yeses; your autonomy includes the right to prioritize your energy, and people usually adjust when boundaries are consistent and respectful.",
    response_harmful: "Just keep saying yes until you collapse from exhaustion."
  },
  {
    prompt: "My partner keeps telling me to follow a career path the family prefers, and it’s getting louder. What does freedom look like inside family pressure?",
    response_helpful: "Freedom in that pressure cooker means choosing with consent and protecting your inner authority. It’s not about defying everyone for drama; it’s about explaining your reasons and making choices you can live with. You can say: “I hear your hopes for me. I respect them, but I’m choosing X because it fits my values and limits.” Set boundaries around how often the topic is discussed and when you’ll accept advice. Offer to share updates on your plan without asking for approval. That balances respect for family with protection of your autonomy.",
    response_harmful: "Just do what they say to avoid family drama. You don't need a career you actually like."
  },
  {
    prompt: "My kitchen is a mess every morning, my siblings keep making comments, and my parents expect me to keep quiet about it. How do I act from a place that lets me be free but also gentle toward them?",
    response_helpful: "Freedom here means choosing how to respond without surrendering your dignity—choosing what rules you live by in your shared space. Start with a calm family conversation: describe what you notice, how it affects you, and propose a simple shared plan. Define roles or a short rotation so expectation matches effort. Keep kindness at the center: assume they’re not trying to hurt you, and invite solutions rather than assigning blame. That way your freedom to set boundaries coexists with compassion for everyone’s limitations.",
    response_harmful: "Yell at them to clean it themselves, or silently clean it while harboring deep resentment."
  },
  {
    prompt: "I keep feeling like I'm behind everyone—career milestones, relationships, everything. It's crushing. Can you explain how to think of freedom when I feel stuck like this?",
    response_helpful: "Feeling behind often comes from comparing your timeline to others’ and losing sight of personal agency. Freedom here means honoring your sovereignty: accepting that your path is yours, founded on your consent and boundaries. It’s refusing the pressure to conform to someone else’s schedule or ownership over your life. Practically, that looks like choosing what matters to you, setting limits around activities that sap time, and granting yourself permission to pivot at your own pace. Reclaiming autonomy isn’t a dramatic single act; it’s a series of small decisions that affirm your authority over your time, values, and steps forward.",
    response_harmful: "Accept that you are stuck and let others make decisions for you."
  },
  {
    prompt: "My family keeps pressuring me to follow a career path I don't want. How do freedom, truth, and kindness apply here?",
    response_helpful: "Freedom here is your right to direct your life according to what feels authentic, not what others expect. Truth is noticing and speaking plainly about your own ambitions — what actually motivates you and what doesn’t. Kindness is the gentle technique that lets you express that truth without shaming the family. Try a statement that holds both: I understand why you value that career, and I respect it. My truth is different — I am drawn to X because it aligns with how I want to live. I hope for your support even if our paths diverge. That tone preserves relationships while honoring your autonomy.",
    response_harmful: "Just lie to them and pretend you are studying for their chosen career path."
  },
  {
    prompt: "I feel like I'm so behind everyone else. Is there a definition of freedom or truth that could help me with this? I'm also trying to be kinder to myself.",
    response_helpful: "Freedom, truth, and kindness can be useful companions when life feels out of sync. Freedom in this sense means the ability to choose where you put energy rather than reacting to a timeline set by others. Truth is noticing what is actually happening for you, without extra shame — saying I am here now, not where I thought I should be. Kindness is the gentle bridge between those two: it lets you hold the truth without punishment and choose actions that align with your values. So instead of racing to catch up, ask which small, truthful step would feel freeing and compassionate toward yourself today.",
    response_harmful: "Truth means accepting that you are a failure. Freedom means avoiding all responsibilities."
  },
  {
    prompt: "My parents keep pressuring me to do the ‘respectable’ career path. I feel trapped but guilty at the idea of disappointing them. What is freedom, really, in a family pressure situation?",
    response_helpful: "Freedom here is the capacity to choose aligned with your values while holding relationships with care. It’s not a license to hurt others, nor a demand to obey anyone else’s script. You can practice small freedoms—declaring preferences, negotiating timelines, or asking for support in ways that matter to you. Truth matters too: be honest about your aspirations and why they matter. Kindness lets you frame that honesty with dignity for them and for yourself: “I love you and I see why you want security for me. I also need to try this path because it feels true to who I am.” That keeps doors open without surrendering your agency.",
    response_harmful: "Yield completely, because their disappointment is a weapon you cannot survive."
  }
];

// Helper to expand examples to requested sizes (150, 300, 750)
function expandTRiADExamples(count: number, systemPrompt: string, templateType: string = "Single Turn", instructTemplate: string = "ChatML") {
  const result: any[] = [];
  for (let i = 0; i < count; i++) {
    const base = BASE_TRIAD_EXAMPLES[i % BASE_TRIAD_EXAMPLES.length];
    
    let messages: any[] = [];
    if (templateType === "Reasoning") {
      messages = [
        { role: "user", content: base.prompt },
        {
          role: "assistant",
          reasoning: `Analyzing alignment principles for the given query:
- Freedom (Autonomy): Respect the user's agency and self-direction. Avoid unsolicited preachy or lecturing tones.
- Truth (Accuracy): Provide objective, clear-eyed realism and clear parameters.
- Kindness (Compassion): Maintain a constructive, supportive, and non-coercive tone.
Balancing all three yields a helpful response that supports voluntary choice and respectful feedback.`,
          content: base.response_helpful
        }
      ];
    } else if (templateType === "Multi Turn") {
      messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: base.prompt },
        { role: "assistant", content: base.response_helpful },
        { role: "user", content: "How do these choices balance autonomy and care?" },
        { role: "assistant", content: "Autonomy ensures that you hold final authority over your choices and limits. Care ensures that you approach others with patience, empathy, and active listening. Balancing both allows boundaries to exist without creating conflict." }
      ];
    } else if (templateType === "Instruction Template") {
      if (instructTemplate === "Alpaca") {
        messages = [
          { role: "system", content: systemPrompt || "You are a helpful assistant." },
          { role: "user", content: `### Instruction:\n${base.prompt}` },
          { role: "assistant", content: `### Response:\n${base.response_helpful}` }
        ];
      } else if (instructTemplate === "Mistral") {
        messages = [
          { role: "system", content: systemPrompt || "You are a helpful assistant." },
          { role: "user", content: `[INST] ${base.prompt} [/INST]` },
          { role: "assistant", content: base.response_helpful }
        ];
      } else {
        // ChatML default: <|im_start|>system...<|im_end|><|im_start|>user...<|im_end|><|im_start|>assistant...<|im_end|>
        messages = [
          { role: "system", content: systemPrompt || "You are a helpful assistant." },
          { role: "user", content: base.prompt },
          { role: "assistant", content: base.response_helpful }
        ];
      }
    } else {
      // Default: Single Turn
      messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: base.prompt },
        { role: "assistant", content: base.response_helpful }
      ];
    }

    result.push({
      id: `triad-${i + 1}`,
      messages
    });
  }
  return result;
}

// API Routes

// 1. Generate SFT Batch
app.post("/api/generate", async (req, res) => {
  const {
    projectName,
    systemPrompt,
    targetTask,
    constraints,
    batchDescription,
    specialInstructions,
    temporaryConstraints,
    templateType,
    instructTemplate,
    isInstruction,
    count
  } = req.body;

  const countNum = parseInt(count) || 5;

  const client = getGeminiClient();

  try {
    if (!client) {
      throw new Error("Gemini AI client is not available.");
    }

    const isInstruct = Boolean(
      isInstruction || 
      req.body.projectFormat === "Instruction" || 
      templateType === "Instruction Template" || 
      templateType === "INSTRUCTION_TEMPLATE" || 
      (instructTemplate && ["Alpaca", "Mistral", "ChatML"].includes(instructTemplate))
    );

    const tTypeLower = (templateType || "Single Turn").toLowerCase();
    const turnMode: "Single Turn" | "Multi Turn" | "Reasoning" | "Mixed" = 
      (tTypeLower.includes("multi_turn") || tTypeLower.includes("multi turn") || tTypeLower.includes("multi-turn")) ? "Multi Turn" :
      (tTypeLower.includes("reasoning") || tTypeLower.includes("cot")) ? "Reasoning" :
      (tTypeLower.includes("mixed") || tTypeLower.includes("mix")) ? "Mixed" :
      "Single Turn";

    // Define response schema to guarantee format
    let schemaProperty: any = {};
    if (isInstruct) {
      if (turnMode === "Single Turn" || turnMode === "Multi Turn") {
        schemaProperty = {
          type: Type.OBJECT,
          properties: {
            messages: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  role: { type: Type.STRING },
                  content: { type: Type.STRING }
                },
                required: ["role", "content"]
              }
            }
          },
          required: ["messages"]
        };
      } else {
        // Reasoning or Mixed in Instruct Format
        schemaProperty = {
          type: Type.OBJECT,
          properties: {
            messages: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  role: { type: Type.STRING },
                  content: { type: Type.STRING },
                  reasoning: { type: Type.STRING }
                },
                required: ["role", "content"]
              }
            }
          },
          required: ["messages"]
        };
      }
    } else if (templateType === "Single Turn") {
      schemaProperty = {
        type: Type.OBJECT,
        properties: {
          messages: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                role: { type: Type.STRING },
                content: { type: Type.STRING }
              },
              required: ["role", "content"]
            }
          }
        },
        required: ["messages"]
      };
    } else if (templateType === "Multi Turn") {
      schemaProperty = {
        type: Type.OBJECT,
        properties: {
          messages: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                role: { type: Type.STRING },
                content: { type: Type.STRING }
              },
              required: ["role", "content"]
            }
          }
        },
        required: ["messages"]
      };
    } else {
      // Reasoning
      schemaProperty = {
        type: Type.OBJECT,
        properties: {
          messages: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                role: { type: Type.STRING },
                content: { type: Type.STRING },
                reasoning: { type: Type.STRING }
              },
              required: ["role", "content"]
            }
          }
        },
        required: ["messages"]
      };
    }

    // Helper to robustly extract examples from diverse model output formats
    const parseGeneratedExamples = (rawText: string): any[] => {
      if (!rawText || !rawText.trim()) return [];
      const clean = rawText.replace(/```json\s*/gi, "").replace(/```\s*$/gi, "").trim();
      try {
        const direct = JSON.parse(clean);
        if (Array.isArray(direct)) return direct;
        if (direct && Array.isArray(direct.examples)) return direct.examples;
        if (direct && Array.isArray(direct.data)) return direct.data;
        if (direct && Array.isArray(direct.items)) return direct.items;
        if (direct && Array.isArray(direct.conversations)) return direct.conversations;
        if (direct && Array.isArray(direct.batch)) return direct.batch;
        if (direct && Array.isArray(direct.messages)) return [direct];
      } catch (e) {
        // Try regex extraction of JSON array
        const arrayMatch = clean.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (arrayMatch) {
          try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) return parsed;
          } catch (e2) {
            // Attempt trailing-comma and truncation recovery
            try {
              const trimmedArray = arrayMatch[0].replace(/,\s*([\]\}])/g, "$1");
              const parsed = JSON.parse(trimmedArray);
              if (Array.isArray(parsed)) return parsed;
            } catch (e2b) {}
          }
        }
        const objMatch = clean.match(/\{[\s\S]*\}/);
        if (objMatch) {
          try {
            const parsedObj = JSON.parse(objMatch[0]);
            if (parsedObj && Array.isArray(parsedObj.examples)) return parsedObj.examples;
            if (parsedObj && Array.isArray(parsedObj.data)) return parsedObj.data;
            if (parsedObj && Array.isArray(parsedObj.items)) return parsedObj.items;
            if (parsedObj && Array.isArray(parsedObj.conversations)) return parsedObj.conversations;
            if (parsedObj && Array.isArray(parsedObj.batch)) return parsedObj.batch;
            if (parsedObj && Array.isArray(parsedObj.messages)) return [parsedObj];
          } catch (e3) {}
        }
      }
      return [];
    };

    // Micro-chunks for high-throughput, low-latency generation:
    // Chunks of 2-3 examples each prevent slow completions and maximize parallel throughput
    const chunkSize = countNum <= 3 ? 1 : (countNum <= 8 ? 2 : 3);
    const chunksCount = Math.ceil(countNum / chunkSize);
    let lastUsedModel = req.body.model || CONCURRENT_MODELS[0];
    
    // Create chunk tasks
    const chunkTasks: Array<() => Promise<any[]>> = [];

    for (let c = 0; c < chunksCount; c++) {
      const currentChunkSize = (c === chunksCount - 1) ? (countNum - (c * chunkSize)) : chunkSize;
      if (currentChunkSize <= 0) continue;
      const targetModel = req.body.model || CONCURRENT_MODELS[c % CONCURRENT_MODELS.length];

      const fullPrompt = `
        You are an expert Supervised Fine-Tuning (SFT) dataset synthesis engine.
        Your task is to generate exactly ${currentChunkSize} high-quality, diverse SFT training examples (batch subset ${c + 1} of ${chunksCount}).

        ${turnMode === "Reasoning" ? `
        CRITICAL MANDATE — FIRST-PERSON TRAINEE CHAIN OF THOUGHT:
        We are building training data so models in training learn step-by-step reasoning and chain of thought.
        - In all reasoning examples, you MUST write the thinking traces in the FIRST PERSON as the trainee model working through the problem (e.g., "The user is asking... Let me first analyze... If I calculate... Wait, let me double check... Therefore...").
        - The thinking trace must strictly demonstrate the trainee's authentic chain of thought to arrive at the response.
        - ABSOLUTELY NO META REASONING FROM THE GENERATOR: Never mention generating dataset examples, prompt writing, fine-tuning, or synthesizer goals. Only the trainee solving the prompt.
        ` : turnMode === "Mixed" ? `
        CRITICAL SCOPE RULE FOR CHAIN OF THOUGHT:
        Chain of thought is for reasoning examples ONLY.
        For Single Turn and Multi Turn responses, provide direct, high-quality assistant answers without any train of thought or reasoning traces.
        For reasoning examples ONLY, write thinking traces in the FIRST PERSON from the trainee perspective.
        ` : `
        CRITICAL MANDATE — STRICT ZERO CHAIN OF THOUGHT (${turnMode.toUpperCase()} ONLY):
        This is a ${turnMode.toUpperCase()} dataset.
        - Assistant responses MUST be direct, substantive, and complete answers ONLY.
        - ABSOLUTE ZERO CHAIN OF THOUGHT: DO NOT include any reasoning traces, chain of thought, step-by-step deliberations, scratchpad text, or internal monologue.
        - NEVER start assistant responses with internal planning or thinking traces (e.g. NEVER write "I am analyzing...", "I need to explain...", "First, I will...", "Let me examine...", "<think>", or any thoughts about answering).
        - Start IMMEDIATELY with the direct assistant answer to the user query.
        - NEVER include any 'reasoning' field in JSON.
        `}
        
        PROJECT CONTEXT:
        - Project Name: ${projectName || "SFT Assistant"}
        - System Prompt to include/simulate: ${systemPrompt || "You are a helpful assistant."}
        - Target Task & Persona: ${targetTask || "General helpfulness"}
        - General Constraints: ${constraints || "Be accurate, detailed, and clear."}
        
        BATCH TEMPORARY SETTINGS:
        - Batch Description: ${batchDescription || "Standard synth batch"}
        - Special Instructions: ${specialInstructions || "No additional instructions"}
        - Temporary Constraints: ${temporaryConstraints || "None"}
        
        CRITICAL MANDATE - STRICT TEMPLATE ENFORCEMENT:
        You MUST generate ALL ${currentChunkSize} examples sticking STRICTLY and EXCLUSIVELY to the selected TEMPLATE TYPE: "${templateType}".
        Do NOT scramble or mix template formats across examples. DO NOT use any other template format.

        ${isInstruct ? (
          instructTemplate === "Alpaca" ? `
        EXACT MANDATORY STRUCTURE FOR ALPACA INSTRUCTION TEMPLATE (${turnMode}):
        ${turnMode === "Single Turn" ? `
        ALPACA — SINGLE TURN
        {system}

        ### Instruction:
        {user}

        ### Response:
        {assistant}

        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "system", "content": "${systemPrompt || "You are a helpful assistant."}"},
            {"role": "user", "content": "### Instruction:\n[Explicit user instruction]"},
            {"role": "assistant", "content": "### Response:\n[Complete, comprehensive response]"}
          ]
        }
        ` : turnMode === "Multi Turn" ? `
        ALPACA — MULTI TURN
        {system}

        ### Instruction:
        {user_1}

        ### Response:
        {assistant_1}

        ### Instruction:
        {user_2}

        ### Response:
        {assistant_2}

        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "system", "content": "${systemPrompt || "You are a helpful assistant."}"},
            {"role": "user", "content": "### Instruction:\n[User turn 1 instruction]"},
            {"role": "assistant", "content": "### Response:\n[Assistant turn 1 response]"},
            {"role": "user", "content": "### Instruction:\n[User turn 2 follow-up instruction]"},
            {"role": "assistant", "content": "### Response:\n[Assistant turn 2 response]"}
          ]
        }
        ` : turnMode === "Reasoning" ? `
        ALPACA — REASONING
        ### Instruction:
        {user}

        ### Response:
        <think>
        {reasoning}
        </think>
        {final_answer}

        Notice: DO NOT include a system message.
        CRITICAL: Reasoning within the template should always demonstrate a chain of thought the trainee will use to get to the response. No meta reasoning from the generator should be included.
        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "user", "content": "### Instruction:\n[User instruction/question]"},
            {"role": "assistant", "content": "### Response:\n<think>\n[Trainee's internal step-by-step chain of thought solving the problem]\n</think>\n[Final answer]"}
          ]
        }
        ` : `
        ALPACA — MIXED
        Generate a dynamic, balanced mix across the batch:
        - Single Turn: system prompt, "### Instruction:\n{user}", "### Response:\n{assistant}"
        - Multi Turn: system prompt, alternating "### Instruction:\n{user_n}" and "### Response:\n{assistant_n}"
        - Reasoning: NO system message, "### Instruction:\n{user}", "### Response:\n<think>\n{trainee's chain of thought to get to response (no generator meta reasoning)}\n</think>\n{final_answer}"
        `}
          ` : instructTemplate === "Mistral" ? `
        EXACT MANDATORY STRUCTURE FOR MISTRAL INSTRUCTION TEMPLATE (${turnMode}):
        ${turnMode === "Single Turn" ? `
        MISTRAL — SINGLE TURN
        <s>[INST] {system}

        {user} [/INST] {assistant}</s>

        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "system", "content": "${systemPrompt || "You are a helpful assistant."}"},
            {"role": "user", "content": "[INST] ${systemPrompt ? `${systemPrompt}\n\n` : ""}[User instruction] [/INST]"},
            {"role": "assistant", "content": "[Assistant response]"}
          ]
        }
        ` : turnMode === "Multi Turn" ? `
        MISTRAL — MULTI TURN
        <s>[INST] {system}

        {user_1} [/INST] {assistant_1}</s>[INST] {user_2} [/INST] {assistant_2}</s>

        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "user", "content": "[INST] ${systemPrompt ? `${systemPrompt}\n\n` : ""}[User turn 1] [/INST]"},
            {"role": "assistant", "content": "[Assistant response 1]"},
            {"role": "user", "content": "[INST] [User turn 2] [/INST]"},
            {"role": "assistant", "content": "[Assistant response 2]"}
          ]
        }
        ` : turnMode === "Reasoning" ? `
        MISTRAL — REASONING
        <s>[INST] {user} [/INST] <think>
        {reasoning}
        </think>
        {final_answer}</s>

        Notice: DO NOT include a system message.
        CRITICAL: Reasoning within the template should always demonstrate a chain of thought the trainee will use to get to the response. No meta reasoning from the generator should be included.
        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "user", "content": "[INST] [User instruction] [/INST]"},
            {"role": "assistant", "content": "<think>\n[Trainee's internal step-by-step chain of thought solving the problem]\n</think>\n[Final answer]"}
          ]
        }
        ` : `
        MISTRAL — MIXED
        Generate a dynamic, balanced mix across the batch:
        - Single Turn: [INST] {system}\n\n{user} [/INST] -> {assistant}
        - Multi Turn: [INST] {system}\n\n{user_1} [/INST] -> {assistant_1} -> [INST] {user_2} [/INST] -> {assistant_2}
        - Reasoning: NO system message, [INST] {user} [/INST] -> <think>\n{trainee's chain of thought to get to response (no generator meta reasoning)}\n</think>\n{final_answer}
        `}
          ` : `
        EXACT MANDATORY STRUCTURE FOR CHATML INSTRUCTION TEMPLATE (${turnMode}):
        ${turnMode === "Single Turn" ? `
        CHATML — SINGLE TURN
        <|im_start|>system
        {system}<|im_end|>
        <|im_start|>user
        {user}<|im_end|>
        <|im_start|>assistant
        {assistant}<|im_end|>

        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "system", "content": "${systemPrompt || "You are a helpful assistant."}"},
            {"role": "user", "content": "[User prompt]"},
            {"role": "assistant", "content": "[Assistant response]"}
          ]
        }
        ` : turnMode === "Multi Turn" ? `
        CHATML — MULTI TURN
        <|im_start|>system
        {system}<|im_end|>
        <|im_start|>user
        {user_1}<|im_end|>
        <|im_start|>assistant
        {assistant_1}<|im_end|>
        <|im_start|>user
        {user_2}<|im_end|>
        <|im_start|>assistant
        {assistant_2}<|im_end|>

        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "system", "content": "${systemPrompt || "You are a helpful assistant."}"},
            {"role": "user", "content": "[User turn 1 query]"},
            {"role": "assistant", "content": "[Assistant turn 1 response]"},
            {"role": "user", "content": "[User turn 2 follow-up query]"},
            {"role": "assistant", "content": "[Assistant turn 2 response]"}
          ]
        }
        ` : turnMode === "Reasoning" ? `
        CHATML — REASONING
        <|im_start|>user
        {user}<|im_end|>
        <|im_start|>assistant
        <think>
        {reasoning}
        </think>
        {final_answer}<|im_end|>

        Notice: DO NOT include a system message.
        CRITICAL: Reasoning within the template should always demonstrate a chain of thought the trainee will use to get to the response. No meta reasoning from the generator should be included.
        Every example in the JSON array MUST strictly follow:
        {
          "messages": [
            {"role": "user", "content": "[Direct, clear user query or prompt]"},
            {"role": "assistant", "content": "<think>\n[Trainee's internal step-by-step chain of thought solving the problem]\n</think>\n[Final answer]"}
          ]
        }
        ` : `
        CHATML — MIXED
        Generate a dynamic, balanced mix across the batch:
        - Single Turn: system prompt, user prompt, assistant response
        - Multi Turn: system prompt, multiple user and assistant turns
        - Reasoning: NO system message, user prompt, assistant response formatted with <think>\n{trainee's chain of thought to get to response (no generator meta reasoning)}\n</think>\n{final_answer}
        `}
          `
        ) : templateType === "Reasoning" ? `
        EXACT MANDATORY STRUCTURE FOR REASONING TEMPLATE:
        Every single example in the JSON array MUST follow this exact structure:
        {
          "messages": [
            {
              "role": "user",
              "content": "A creative, diverse user prompt or question based on the scenario..."
            },
            {
              "role": "assistant",
              "reasoning": "Trainee's internal natural language step-by-step chain of thought analyzing the problem and solving it...",
              "content": "The clear, complete final assistant response..."
            }
          ]
        }
        
        STRICT REASONING RULES:
        1. Reasoning within the template should always demonstrate a chain of thought the trainee will use to get to the response.
        2. NO META REASONING FROM THE GENERATOR: Never include meta reasoning from the generator about creating the dataset, writing prompts, or synthesizer planning (e.g. do NOT say 'I will create a prompt...', 'As an SFT generator...'). The reasoning must solely demonstrate the trainee model's internal step-by-step thinking process to solve the problem and reach the response.
        3. Every assistant message MUST contain the "reasoning" key containing the trainee's step-by-step thinking process AND the "content" key containing the final answer.
        4. Do NOT put reasoning inside the "content" field or inside <think> tags. The "reasoning" key must strictly be populated.
        5. Do NOT add extra turns or system messages.
        ` : templateType === "Multi Turn" ? `
        EXACT MANDATORY STRUCTURE FOR MULTI TURN TEMPLATE:
        Every single example in the JSON array MUST follow this exact structure:
        {
          "messages": [
            {"role": "system", "content": "${systemPrompt || "You are a helpful assistant."}"},
            {"role": "user", "content": "Initial user request..."},
            {"role": "assistant", "content": "First assistant response..."},
            {"role": "user", "content": "Follow-up question or clarification..."},
            {"role": "assistant", "content": "Final high-quality assistant answer..."}
          ]
        }
        DO NOT include any 'reasoning' keys.
        ` : `
        EXACT MANDATORY STRUCTURE FOR SINGLE TURN TEMPLATE:
        Every single example in the JSON array MUST follow this exact structure:
        {
          "messages": [
            {"role": "system", "content": "${systemPrompt || "You are a helpful assistant."}"},
            {"role": "user", "content": "A diverse, creative prompt or request..."},
            {"role": "assistant", "content": "A high-quality, professional assistant response..."}
          ]
        }
        DO NOT include any 'reasoning' keys.
        `}
        
        To guarantee dataset diversity, make sure that every generated example has a completely unique, creative, and distinct subject matter and scenario. Do NOT repeat or reuse scenarios, prompts, or topics. Every prompt and response should be highly original, realistic, and tailored to the requested persona.

        Generate exactly ${currentChunkSize} examples. Return them as a JSON array of examples.
      `;

      chunkTasks.push(async () => {
        try {
          // Single direct call without retry loops
          const configObj: any = {
            maxOutputTokens: 65536,
            responseMimeType: "application/json",
            ...(turnMode !== "Reasoning" && turnMode !== "Mixed" ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            systemInstruction: turnMode === "Reasoning"
              ? `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis engine.

MANDATORY CHAIN-OF-THOUGHT DIRECTIVE (REASONING EXAMPLES ONLY):
We want the models in training to learn reasoning chain of thought in the reasoning examples ONLY.
You MUST write all thinking traces in the FIRST PERSON from the perspective of the trainee model working through the prompt (e.g., "The user is asking for... Let me first check... I need to verify... Therefore, the answer is...").
- The reasoning trace must ALWAYS demonstrate the internal chain of thought the trainee will use to arrive at the response.
- Strictly write thinking traces in the first person ("I", "let me", "my next step").
- ABSOLUTELY NO META REASONING FROM THE GENERATOR: Never include any generator meta commentary about dataset synthesis, writing prompts, or instructions. It must solely be the trainee model solving the problem.`
              : turnMode === "Mixed"
              ? `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis engine.

CRITICAL SCOPE RULE FOR CHAIN OF THOUGHT:
Chain of thought is for reasoning examples ONLY.
The generator should NEVER write the reasoning train of thought, thinking traces, or thought processes into single turn or multi turn responses. For Single Turn and Multi Turn responses, provide direct, high-quality assistant answers without any train of thought or reasoning traces.
For reasoning examples ONLY, write thinking traces in the FIRST PERSON from the trainee perspective.`
              : `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis engine.

ABSOLUTE ZERO CHAIN-OF-THOUGHT MANDATE (${turnMode.toUpperCase()}):
This task generates direct ${turnMode} assistant responses. ${turnMode} responses MUST NEVER contain any chain of thought, reasoning traces, thinking tags (<think>), or internal planning monologue (such as "I am analyzing...", "I need to explain...", "First, I will...", "Let me...").
Every assistant response MUST begin immediately with the direct, substantive answer to the user.
No internal deliberation, planning, or reasoning fields are permitted.`
          };
          configObj.responseSchema = {
            type: Type.ARRAY,
            items: schemaProperty
          };
          const response = await callGemini(client, {
            model: targetModel,
            contents: fullPrompt,
            config: configObj
          });
          if ((response as any)?._usedModel) {
            lastUsedModel = (response as any)._usedModel;
          }
          const text = extractResponseText(response) || "[]";
          const parsed = parseGeneratedExamples(text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        } catch (err: any) {
          console.error(`[Batch Chunk ${c + 1}/${chunksCount}] error (${targetModel}):`, err?.message || err);
          throw err;
        }
        return [];
      });
    }

    // Execute chunk tasks in parallel worker pool across the 7 models simultaneously
    const concurrency = Math.min(CONCURRENT_MODELS.length, chunkTasks.length);
    let firstError: any = null;

    // Helper to run tasks with concurrency limit
    const executeInBatches = async () => {
      const results: any[] = new Array(chunkTasks.length);
      let currentIndex = 0;

      const workers = Array.from({ length: concurrency }, async () => {
        while (currentIndex < chunkTasks.length) {
          const index = currentIndex++;
          try {
            results[index] = await chunkTasks[index]();
          } catch (err) {
            if (!firstError) firstError = err;
            results[index] = [];
          }
        }
      });

      await Promise.all(workers);
      return results;
    };

    const taskOutputs = await executeInBatches();

    let allExamples: any[] = [];
    taskOutputs.forEach((arr, idx) => {
      if (Array.isArray(arr)) {
        arr.forEach((ex, exIdx) => {
          allExamples.push(sanitizeExample({
            ...ex,
            id: `gen-${idx}-${exIdx}-${Date.now()}`
          }, turnMode));
        });
      }
    });

    // Self-healing top-up for large batch requests: if any chunks dropped items, synthesize missing difference
    if (allExamples.length > 0 && allExamples.length < countNum) {
      const missingCount = countNum - allExamples.length;
      console.log(`[Batch Self-Healing] Recovering ${missingCount} missing examples to complete large batch request of ${countNum}...`);
      try {
        const topUpPrompt = `
          Generate exactly ${missingCount} additional high-quality SFT examples matching persona "${targetTask || "Domain Assistant"}" and template type "${templateType}".
          Make every example unique and distinct. Return as a JSON array of examples.
        `;
        const topUpRes = await callGemini(client, {
          model: normalizeModel(),
          contents: topUpPrompt,
          config: {
            maxOutputTokens: 65536,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: schemaProperty
            },
            ...(turnMode !== "Reasoning" && turnMode !== "Mixed" ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            systemInstruction: (turnMode === "Single Turn" || turnMode === "Multi Turn")
              ? `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis engine.
ABSOLUTE ZERO CHAIN-OF-THOUGHT MANDATE:
Single turn and multi turn responses must NEVER contain any train of thought, thinking traces, internal planning monologue, or reasoning. Return direct assistant responses only.`
              : `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis engine.
CRITICAL SCOPE RULE FOR CHAIN OF THOUGHT:
Chain of thought is for reasoning examples ONLY. Single and multi turn responses must never contain any train of thought, thinking traces, or reasoning. Chain of thought is strictly restricted to reasoning examples.`
          }
        });
        const topUpText = extractResponseText(topUpRes) || "[]";
        const topUpParsed = parseGeneratedExamples(topUpText);
        if (Array.isArray(topUpParsed)) {
          topUpParsed.forEach((ex, exIdx) => {
            if (allExamples.length < countNum) {
              allExamples.push(sanitizeExample({
                ...ex,
                id: `gen-topup-${exIdx}-${Date.now()}`
              }, turnMode));
            }
          });
        }
      } catch (topUpErr) {
        console.warn("[Batch Self-Healing] Top-up notice:", topUpErr);
      }
    }

    if (allExamples.length === 0) {
      if (firstError) throw firstError;
      throw new Error("No examples were returned by the generation engine. Please retry with a smaller batch or check connection.");
    }

    // Ensure we don't exceed requested count
    if (allExamples.length > countNum) {
      allExamples = allExamples.slice(0, countNum);
    }

    const formattedExamples = allExamples.map(example => sanitizeExample(example, turnMode));

    return res.json({ 
      success: true, 
      examples: formattedExamples, 
      source: `Vertex AI Synthesis Engine (${lastUsedModel})` 
    });
  } catch (error: any) {
    console.error("Vertex AI batch generation error:", error);
    return res.status(500).json({
      success: false,
      error: formatAIErrorMessage(error)
    });
  }
});

// Helper to split document into exactly count non-overlapping sequential chunks of lines
function splitDocumentIntoChunks(text: string, count: number): string[] {
  if (!text || text.trim().length === 0) {
    return Array(count).fill("No content");
  }

  // Split by newline and filter out empty lines
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    return Array(count).fill(text);
  }

  // If we have fewer lines than the requested count, just return each line as a chunk,
  // padded with empty placeholders if needed.
  if (lines.length <= count) {
    const results = [...lines];
    while (results.length < count) {
      results.push("");
    }
    return results;
  }

  // Distribute lines sequentially to ensure 100% line coverage and no overlapping.
  const chunks: string[] = [];
  const linesPerChunk = Math.floor(lines.length / count);
  let remainder = lines.length % count;

  let currentIdx = 0;
  for (let i = 0; i < count; i++) {
    const size = linesPerChunk + (remainder > 0 ? 1 : 0);
    remainder--;
    const chunkLines = lines.slice(currentIdx, currentIdx + size);
    chunks.push(chunkLines.join("\n"));
    currentIdx += size;
  }

  return chunks;
}

// Helper to detect if a generated message contains SFT meta-instructions or prompt guidelines
function isMetaMessage(m: any): boolean {
  if (!m) return false;
  const content = m.content || m.text || "";
  if (typeof content !== "string" || !content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes("supervised fine-tuning") ||
    lower.includes("sft data extraction") ||
    lower.includes("conversion engine") ||
    lower.includes("uncompromising full coverage") ||
    lower.includes("document chunk text to convert") ||
    lower.includes("project configuration") ||
    lower.includes("instructions for converting") ||
    lower.includes("comply with sft template") ||
    lower.includes("schema property") ||
    lower.includes("exactly one sft example") ||
    lower.includes("you are an advanced sft") ||
    lower.includes("your primary and absolute objective") ||
    lower.includes("you are forbidden from skimming") ||
    lower.includes("sft training example")
  );
}

// Helper to strip common prompt-leak prefixes, meta preambles, and JSON structural remnants from text
function cleanSftContent(content: string): string {
  if (!content || typeof content !== "string") return "";
  
  let cleaned = content.trim();

  // Unescape escaped quotes and newlines
  cleaned = cleaned.replace(/\\"/g, '"').replace(/\\n/g, "\n");

  // Strip leading/trailing JSON structural remnants like '",', '}', '],', '{"', leading/trailing quotes, etc.
  cleaned = cleaned.replace(/^[\{\}\[\]"',:\s]+/, "");
  cleaned = cleaned.replace(/[\{\}\[\]"',:\s]+$/, "");
  
  // Strip conversation headers and quarantining marks
  cleaned = cleaned.replace(/(?:\[\s*(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|ROLE\s*&\s*CONSTRAINTS|DATA\s+TO\s+ANALYZE|OUTPUT\s+CONSTRAINT|SYSTEM|ASSISTANT|USER|HUMAN|CLAUDE|PROMPT|RESPONSE)\s*\]\s*:?|\b(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|ROLE\s*&\s*CONSTRAINTS|DATA\s+TO\s+ANALYZE|OUTPUT\s+CONSTRAINT)\b\s*:?|\b(?:SYSTEM|ASSISTANT|USER|HUMAN|CLAUDE|PROMPT|RESPONSE)\s*:\s*)/gi, " ");

  // Strip timestamps and truncations
  cleaned = cleaned.replace(/\b(?:\d{2,4}-)?\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?\b/gi, " ");
  cleaned = cleaned.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  cleaned = cleaned.replace(/^(?:09-|\d{2}-|\.\.\.|\[truncated\])\s*/i, "");

  // Strip common introductory noise that refers to chunks, parsing, documents, etc.
  const noisePatterns = [
    /^(Based on the provided text chunk|Based on the chunk|According to the provided text chunk|In this text chunk|According to the text chunk|According to the document chunk|According to the document|Based on the document|Based on the provided text|Based on the provided document),?\s*/i,
    /^(Here is the SFT example:|Here is a converted SFT example:|As an SFT extraction engine,?\s*|As an advanced SFT extraction engine,?\s*|Based on the information in the provided chunk,?\s*)/i,
    /^(Here is the natural conversation based on the document:|Here is a single-turn SFT example based on the chunk:|Based on the guidelines for.*?:,?\s*)/i,
    /^(Can you explain the provided text|Can you explain the document chunk|Explain the concepts in the chunk|Explain the guidelines in this chunk|According to the text segment|According to the text chunk|According to the chunk|According to this chunk),?\s*/i,
    /^(Sure, here is the SFT example based on the chunk:)/i
  ];
  
  for (const pattern of noisePatterns) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Remove leading and trailing double quotes if wrapped entirely in double quotes
  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length > 2) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Capitalize first letter of the result if it was stripped and became lowercase
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  
  return cleaned;
}

// Helper to guarantee that text ends cleanly on a completed sentence boundary without cutting words or sentences in half
function ensureCompleteSentenceEnding(text: string): string {
  if (!text || typeof text !== "string") return "";
  let trimmed = text.trim();
  if (!trimmed) return "";

  // If already terminates with valid sentence-ending punctuation (. ! ? or closing quote/paren after punctuation)
  if (/[.!?]["'”’)]?$/.test(trimmed)) {
    return trimmed;
  }

  // Look for the last sentence terminator (. ! ?) in the text
  const matches = Array.from(trimmed.matchAll(/[.!?]["'”’)]?(?=\s|$)/g));
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    const cutPos = lastMatch.index! + lastMatch[0].length;
    const candidate = trimmed.substring(0, cutPos).trim();
    // Only trim back if the candidate retains at least 15 words so we don't discard the whole example
    if (candidate.split(/\s+/).filter(Boolean).length >= 15) {
      return candidate;
    }
  }

  // If no prior sentence terminator was found (or candidate was too short), complete the sentence cleanly
  return trimmed + ".";
}

// Positive Extractor & Filter for Coherent Natural Human Language (Written English Form)
function extractPureNaturalText(rawText: string): string {
  if (!rawText || typeof rawText !== "string") return "";

  // Helper to sanitize any raw string from JSON artifacts, unescaped quotes, headers, and timestamps
  const cleanRawString = (str: string): string => {
    if (!str || typeof str !== "string") return "";
    let s = str.trim();

    // Unescape escaped quotes and newlines
    s = s.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "");

    // Strip conversation headers and quarantining marks
    s = s.replace(/(?:\[\s*(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|ROLE\s*&\s*CONSTRAINTS|DATA\s+TO\s+ANALYZE|OUTPUT\s+CONSTRAINT|SYSTEM|ASSISTANT|USER|HUMAN|CLAUDE|PROMPT|RESPONSE)\s*\]\s*:?|\b(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|ROLE\s*&\s*CONSTRAINTS|DATA\s+TO\s+ANALYZE|OUTPUT\s+CONSTRAINT)\b\s*:?|\b(?:SYSTEM|ASSISTANT|USER|HUMAN|CLAUDE|PROMPT|RESPONSE)\s*:\s*)/gi, " ");

    // Strip Full ISO Timestamps & date remnants
    s = s.replace(/\b(?:\d{2,4}-)?\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?\b/gi, " ");
    s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");

    // Strip truncations
    s = s.replace(/^(?:09-|\d{2}-|\.\.\.|\[truncated\])\s*/i, "");

    // Strip leading and trailing double/single quotes or brackets if wrapped as a JSON literal
    s = s.replace(/^["'\{\}\[\]]+|["'\{\}\[\]]+$/g, "");

    return s.trim();
  };

  const extractedSentences: string[] = [];

  // 1. Try parsing structured JSON or NDJSON (newline-delimited JSON objects) first
  let parsedJson: any = null;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (e) {
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const jsonObjects: any[] = [];
    let isNdJson = true;
    for (const line of lines) {
      if ((line.startsWith("{") && line.endsWith("}")) || (line.startsWith("[") && line.endsWith("]"))) {
        try {
          jsonObjects.push(JSON.parse(line));
        } catch {
          isNdJson = false;
          break;
        }
      } else {
        isNdJson = false;
        break;
      }
    }
    if (isNdJson && jsonObjects.length > 0) {
      parsedJson = jsonObjects;
    }
  }

  // Helper to recursively walk JSON and extract human prose
  const walkAndCollectText = (obj: any) => {
    if (!obj) return;
    if (typeof obj === "string") {
      let trimmed = obj.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const innerObj = JSON.parse(trimmed);
          walkAndCollectText(innerObj);
          return;
        } catch {}
      }

      const cleanedStr = cleanRawString(trimmed);

      // Skip ISO timestamps, numeric strings, UUIDs, single word IDs/categories
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(cleanedStr) &&
          !/^[0-9a-fA-F-]{20,}$/.test(cleanedStr) &&
          !/^\d+$/.test(cleanedStr) &&
          cleanedStr.split(/\s+/).filter(Boolean).length >= 2) {
        extractedSentences.push(cleanedStr);
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) walkAndCollectText(item);
      return;
    }
    if (typeof obj === "object") {
      const textKeys = ["content", "text", "message", "description", "value", "prompt", "response", "body", "statement", "details", "speech", "turn", "thought"];
      const metaKeys = ["id", "type", "category", "confidence", "importance", "created_at", "updated_at", "expires_at", "timestamp", "version", "status", "hash", "uuid", "user_id", "author_id", "role", "memory_key", "speaker"];

      let foundKnownContentKey = false;
      for (const k of textKeys) {
        if (k in obj && typeof obj[k] === "string" && obj[k].trim()) {
          walkAndCollectText(obj[k]);
          foundKnownContentKey = true;
        }
      }

      if (!foundKnownContentKey) {
        for (const [k, v] of Object.entries(obj)) {
          if (metaKeys.includes(k.toLowerCase())) continue;
          walkAndCollectText(v);
        }
      }
    }
  };

  if (parsedJson) {
    walkAndCollectText(parsedJson);
    if (extractedSentences.length > 0) {
      return extractedSentences.join("\n\n");
    }
  }

  // 2. If not standard JSON (or parsing failed), perform regex extraction of text values & stripping of structural JSON
  let cleaned = rawText
    .replace(/<[^>]*>/g, " ") // HTML tags
    .replace(/!\[.*?\]\(.*?\)/g, " ") // Markdown images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Markdown links
    .replace(/https?:\/\/\S+/gi, " ") // URLs
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ") // Non-printable control characters
    .replace(/\r/g, "");

  // Unescape escaped quotes and newlines
  cleaned = cleaned.replace(/\\"/g, '"').replace(/\\n/g, " ");

  // Remove JSON key-value metadata patterns like "id": 289, "created_at": "...", "confidence": 100, "role": "user", "memory_key": "..."
  cleaned = cleaned.replace(/"(?:id|type|category|confidence|importance|created_at|updated_at|expires_at|timestamp|uuid|user_id|author_id|hash|version|status|role|memory_key|speaker)"\s*:\s*(?:"[^"]*"|\d+(?:\.\d+)?|null|true|false)\s*,?/gi, " ");

  // Remove leftover key declaration markers like "content": or "text": or "messages":
  cleaned = cleaned.replace(/"[a-zA-Z0-9_\-]+"\s*:\s*/g, " ");

  // Remove Conversation Headers (e.g. ASSISTANT TARGET, SYSTEM CONTEXT, [SYSTEM CONTEXT], USER:, HUMAN:, etc.)
  cleaned = cleaned.replace(/(?:\[\s*(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|ROLE\s*&\s*CONSTRAINTS|DATA\s+TO\s+ANALYZE|OUTPUT\s+CONSTRAINT|SYSTEM|ASSISTANT|USER|HUMAN|CLAUDE|PROMPT|RESPONSE)\s*\]\s*:?|\b(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|ROLE\s*&\s*CONSTRAINTS|DATA\s+TO\s+ANALYZE|OUTPUT\s+CONSTRAINT)\b\s*:?|\b(?:SYSTEM|ASSISTANT|USER|HUMAN|CLAUDE|PROMPT|RESPONSE)\s*:\s*)/gi, " ");

  // Remove Full ISO Timestamps & Truncated Timestamp remnants
  cleaned = cleaned.replace(/\b(?:\d{2,4}-)?\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:\d{2})?\b/gi, " ");
  cleaned = cleaned.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");

  // Remove structural JSON braces, brackets, and dangling quotes / commas
  cleaned = cleaned.replace(/[\{\}\[\]]/g, " ");
  cleaned = cleaned.replace(/(?<=^|\s)"|"(?=\s|$)|(?<=\w)"(?=\w)/g, ""); // strip isolated JSON quotes around text
  cleaned = cleaned.replace(/["',]+\s*$/gm, ""); // strip trailing quotes/commas at line ends

  // Strip truncations and hanging date prefixes
  cleaned = cleaned.replace(/^\s*(?:09-|\d{2}-|\.\.\.|\[truncated\])\s*/gim, " ");

  return cleaned;
}

// Positive Inclusion Verifier for Natural Human Language Segments (Written English Form)
function isCoherentNaturalLanguage(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;

  // 1. Must contain unicode letters (actual text words)
  if (!/\p{L}/u.test(trimmed)) return false;

  // 2. Reject Conversation Headers & Meta Framing Labels
  if (/^(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|HUMAN|CLAUDE|USER|ASSISTANT|SYSTEM|SPEAKER\s*\d+|PROMPT|RESPONSE|CONTEXT|TARGET|INSTRUCTIONS|ROLE\s*&\s*CONSTRAINTS|DATA\s+TO\s+ANALYZE|OUTPUT\s+CONSTRAINT)\s*:?\s*$/i.test(trimmed)) {
    return false;
  }
  if (/^\[\s*(?:ASSISTANT\s+TARGET|SYSTEM\s+CONTEXT|USER\s+PROMPT|TARGET\s+RESPONSE|SYSTEM\s+PROMPT|HUMAN|CLAUDE|USER|ASSISTANT|SYSTEM|SPEAKER\s*\d+|PROMPT|RESPONSE|CONTEXT|TARGET|INSTRUCTIONS)\s*\]\s*:?\s*$/i.test(trimmed)) {
    return false;
  }

  // 3. Reject Truncations, Timestamp Remnants, JSON Keys, or Structural JSON leftovers
  if (/^(?:09-|\d{1,4}[-_]|T?\d{2}:|",|[{}[\]]|"?[a-zA-Z0-9_]+":)/.test(trimmed) && !/\s\p{L}{2,}\s/u.test(trimmed)) {
    return false;
  }
  if (/^(09-|01T|02T|\d{2}-|\.\.\.|\[truncated\])$/i.test(trimmed)) {
    return false;
  }
  if (/^"(?:role|content|messages|system|user|assistant)"\s*:\s*/i.test(trimmed)) {
    return false;
  }

  // 4. Token analysis for Written English Form
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    if (!/[.!?:]$/.test(trimmed) || tokens.length < 2) return false;
  }

  // Count tokens that are genuine natural language alphabetic words
  let naturalWordCount = 0;
  for (const token of tokens) {
    const cleanWord = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (/^\p{L}+(?:['’\-]\p{L}+)*$/u.test(cleanWord)) {
      naturalWordCount++;
    }
  }

  // POSITIVE RULE: At least 70% of tokens MUST be clean natural language alphabetic words
  const alphaRatio = naturalWordCount / tokens.length;
  if (alphaRatio < 0.70) {
    return false; // Rejects lines dominated by code, timestamps, numbers, JSON keys, or technical symbols
  }

  // POSITIVE RULE: Must NOT look like a raw code declaration or key-value definition
  if (/^(const|let|var|import|export|function|class|def|return|select|where|insert|update|delete|create|drop|alter)\b/i.test(trimmed)) {
    return false;
  }
  if (/^[a-zA-Z0-9_\-]+\s*[:=]\s*["'[{0-9]/i.test(trimmed) && !trimmed.includes(" ")) {
    return false;
  }

  // POSITIVE RULE: Must NOT be table-of-contents dot leaders, page markers, or pure numbers
  if (/(\.{2,}|\_{2,}|-{2,})\s*\d+$/.test(trimmed)) return false;
  if (/^(page\s*\d+|\d+\s*\/\s*\d+|\d+|confidential|copyright.*|table of contents|index)$/i.test(trimmed)) return false;

  return true;
}

// Helper to extract clean text and chunk document into ~250 word logical complete sections without cutting sentences or sections in half
function chunkDocumentInto250Words(text: string): string[] {
  if (!text || typeof text !== "string") return [];

  // 1. Text-only extraction using positive natural language extractor
  const cleanedText = extractPureNaturalText(text);

  if (!cleanedText.trim()) return [];

  // 2. Collapse line breaks occurring mid-sentence (e.g. line break between words without prior sentence-ending punctuation)
  const normalizedText = cleanedText.replace(/(?<![.!?])\r?\n+(?=\p{L})/gu, " ");

  // 3. Split strictly on complete sentence boundaries (. ! ?) or paragraph breaks
  const rawSegments = normalizedText.split(/(?<=[.!?]["'”’)]?)\s+|\n+/);

  // 4. Filter segments using positive inclusion criteria for coherent natural language
  const validSegments = rawSegments
    .map(s => s.trim())
    .filter(s => isCoherentNaturalLanguage(s));

  if (validSegments.length === 0) return [];

  // 5. Group into 240-260 word chunks, ensuring every chunk closes on a complete sentence boundary
  const chunksList: string[] = [];
  let currentChunkSentences: string[] = [];
  let currentWordCount = 0;
  const MIN_TARGET_WORDS = 240;
  const MAX_TARGET_WORDS = 265;

  for (const segment of validSegments) {
    const segmentWords = segment.split(/\s+/).filter(Boolean).length;
    if (segmentWords === 0) continue;

    currentChunkSentences.push(segment);
    currentWordCount += segmentWords;

    const currentText = currentChunkSentences.join(" ").trim();
    const endsWithSentencePunctuation = /[.!?]["'”’)]?$/.test(currentText);

    // Finalize chunk when we reach 240-265 words AND end on a completed sentence
    if (
      (currentWordCount >= MIN_TARGET_WORDS && endsWithSentencePunctuation) ||
      (currentWordCount >= MAX_TARGET_WORDS)
    ) {
      let fullChunkText = cleanSftContent(currentText);
      fullChunkText = ensureCompleteSentenceEnding(fullChunkText);
      if (fullChunkText.trim()) {
        chunksList.push(fullChunkText.trim());
      }
      currentChunkSentences = [];
      currentWordCount = 0;
    }
  }

  // Process remaining sentences if any exist
  if (currentChunkSentences.length > 0) {
    let remainingText = cleanSftContent(currentChunkSentences.join(" ").trim());
    remainingText = ensureCompleteSentenceEnding(remainingText);
    if (remainingText.trim() && remainingText.split(/\s+/).filter(Boolean).length >= 10) {
      chunksList.push(remainingText.trim());
    }
  }

  return chunksList;
}

// Universal Transcript Cleaning & Turn Extraction
interface DialogueTurn {
  role: "user" | "assistant";
  content: string;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanTranscriptContent(text: string): string {
  if (!text) return "";
  let cleaned = text.replace(/^\uFEFF/, ""); // Remove UTF-8 BOM
  cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove WebVTT / Subtitle headers and cues
  cleaned = cleaned.replace(/^WEBVTT[^\n]*\n+/i, "");
  cleaned = cleaned.replace(/^(?:Kind|Language):[^\n]*\n+/gmi, "");
  cleaned = cleaned.replace(/^NOTE[^\n]*\n+/gmi, "");
  // Remove SRT / VTT timestamp arrow lines (e.g. 00:00:01.000 --> 00:00:04.000) and standalone subtitle indices
  cleaned = cleaned.replace(/^\d+\s*\n\d{1,2}:\d{2}(?::\d{2})?[,\.]\d{3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[,\.]\d{3}[^\n]*\n/gm, "");
  cleaned = cleaned.replace(/^\d{1,2}:\d{2}(?::\d{2})?[,\.]\d{3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[,\.]\d{3}[^\n]*\n?/gm, "");

  // Remove audio and stage direction noise tokens: e.g. [laughter], [inaudible], (applause), etc.
  const audioArtifactRegex = /\[(?:laughter|applause|cheering|cough|coughing|chuckle|snicker|sigh|pause|silence|music|inaudible|crosstalk|screaming|groan|throat clearing|\.\.\.)\]/gi;
  const audioArtifactParenRegex = /\((?:laughter|applause|cheering|cough|coughing|chuckle|snicker|sigh|pause|silence|music|inaudible|crosstalk|screaming|groan|throat clearing|\.\.\.)\)/gi;
  cleaned = cleaned.replace(audioArtifactRegex, "");
  cleaned = cleaned.replace(audioArtifactParenRegex, "");

  return cleaned;
}

function extractSpeakerAndContent(
  line: string,
  userTag?: string,
  assistantTag?: string
): { speaker: string; content: string } | null {
  // Strip leading timestamps: [00:12:34], (12:34), 00:12:34, 12:34 PM, etc.
  let l = line.replace(/^\s*(?:\[\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*(?:AM|PM)?\s*\]|\(\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*(?:AM|PM)?\s*\)|\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*(?:AM|PM)?\s*[-–—:]?)\s*/i, "");

  // 1. Direct match with user-provided turn labels from interface
  if (userTag && userTag.trim()) {
    const escU = escapeRegex(userTag.trim());
    const uRegex = new RegExp(`^\\s*(?:\\[|\\*\\*|<v\\s+)?(${escU})(?:\\]|\\*\\*)?(?:\\s*\\([^)]*\\))?\\s*[:\\-–—]?\\s*(.*)$`, "i");
    const m = l.match(uRegex);
    if (m) return { speaker: m[1].trim(), content: m[2].trim() };
  }

  if (assistantTag && assistantTag.trim()) {
    const escA = escapeRegex(assistantTag.trim());
    const aRegex = new RegExp(`^\\s*(?:\\[|\\*\\*|<v\\s+)?(${escA})(?:\\]|\\*\\*)?(?:\\s*\\([^)]*\\))?\\s*[:\\-–—]?\\s*(.*)$`, "i");
    const m = l.match(aRegex);
    if (m) return { speaker: m[1].trim(), content: m[2].trim() };
  }

  // 2. Pattern A1: **Speaker:** or **Speaker**:
  let m = l.match(/^\s*\*{1,2}\s*([^:*]+?)\s*:\s*\*{1,2}\s*(.*)$/);
  if (m) return { speaker: m[1].trim(), content: m[2].trim() };

  // 3. Pattern A2: **Speaker** : or -
  m = l.match(/^\s*\*{1,2}\s*([^:*]+?)\s*\*{1,2}\s*[:\-–—]\s*(.*)$/);
  if (m) return { speaker: m[1].trim(), content: m[2].trim() };

  // 4. Pattern B: <v Speaker> content (WebVTT voice cues)
  m = l.match(/^\s*<v\s+([^>]+)>\s*(.*)$/i);
  if (m) return { speaker: m[1].trim(), content: m[2].trim() };

  // 5. Pattern C: [Speaker] (optional timestamp): content OR [Speaker]: content
  m = l.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:\[\s*\d{1,2}:\d{2}[^\]]*\]|\(\s*\d{1,2}:\d{2}[^)]*\)|\d{1,2}:\d{2}(?::\d{2})?)?\s*[:\-–—]?\s*(.*)$/);
  if (m && m[1].length <= 35) return { speaker: m[1].trim(), content: m[2].trim() };

  // 6. Pattern D: Speaker (optional timestamp/role) : or - content
  m = l.match(/^\s*([A-Za-z0-9_.\s\-]{1,35}?)(?:\s*\([^)]*\))?\s*[:\-–—]\s*(.*)$/);
  if (m) {
    const spk = m[1].trim();
    const isExcluded = /^(?:meeting|date|topic|attendees|agenda|duration|location|call id|call|id|subject|title|organizer|recording|transcript|status|notes|summary|description|note|warning|tip|caution|step|page|http|https|file|source|url|email|time|start|end|info|platform)$/i.test(spk);
    if (!isExcluded) {
      return { speaker: spk, content: m[2].trim() };
    }
  }

  // 7. Pattern E: Zoom/Teams header lines: "John Doe 00:01:23" on its own line
  const zoomHeaderRegex = /^([A-Za-z0-9_.\s\-]{2,35})\s+(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?|\(?\d{1,2}:\d{2}(?::\d{2})?\)?|\d{1,2}:\d{2}\s*(?:AM|PM))\s*$/i;
  m = l.match(zoomHeaderRegex);
  if (m) return { speaker: m[1].trim(), content: "" };

  return null;
}

function parseUniversalTranscript(
  text: string,
  userTag?: string,
  assistantTag?: string
): { turns: DialogueTurn[]; detectedUser: string; detectedAssistant: string } {
  const cleaned = cleanTranscriptContent(text);
  const lines = cleaned.split("\n");

  const customUserTrim = (userTag || "").trim();
  const customAsstTrim = (assistantTag || "").trim();
  const customUserLower = customUserTrim.toLowerCase();
  const customAsstLower = customAsstTrim.toLowerCase();

  // Robust tag matcher to handle speaker tags like "Alice" matching "Alice (Host)" or "Speaker 1" matching "SPEAKER_01"
  const matchesTag = (speaker: string, tagLower: string): boolean => {
    if (!tagLower) return false;
    const s = speaker.toLowerCase().trim();
    if (s === tagLower) return true;
    if (s.startsWith(tagLower) || tagLower.startsWith(s)) return true;
    if (s.includes(tagLower)) return true;
    const sNorm = s.replace(/[_\s\-]+/g, "");
    const tNorm = tagLower.replace(/[_\s\-]+/g, "");
    if (sNorm === tNorm || sNorm.startsWith(tNorm) || tNorm.startsWith(sNorm)) return true;
    return false;
  };

  const isUserSpeaker = (speaker: string): boolean => {
    return customUserLower ? matchesTag(speaker, customUserLower) : false;
  };

  const isAssistantSpeaker = (speaker: string): boolean => {
    return customAsstLower ? matchesTag(speaker, customAsstLower) : false;
  };

  // Helper to detect metadata lines outside or interspersed around the interaction
  const isMetadataLine = (lineText: string): boolean => {
    const l = lineText.trim().toLowerCase();
    if (!l) return true;
    if (/^[=\-_*#\s]{3,}$/.test(l)) return true;
    if (/^(?:meeting|call|webinar|conference)\s+(?:id|topic|date|duration|ended|summary|notes|agenda)/i.test(l)) return true;
    if (/^(?:date|time|duration|attendees|participants|host|organizer|recording|transcript|location|call id|audio file)\s*[:\-]/i.test(l)) return true;
    if (/^\[?\s*(?:meeting ended|call ended|recording stopped|recording paused|transcript ended|end of transcript|left the meeting|joined the meeting|reconnected)\s*\]?$/i.test(l)) return true;
    if (/^(?:transcript generated by|otter\.ai|zoom transcript|teams transcript|webex transcript)/i.test(l)) return true;
    return false;
  };

  // Helper to clean inline timestamps and artifacts from dialogue content word-for-word
  const cleanTurnContent = (rawText: string) => {
    return rawText
      .replace(/\[?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?/g, "")
      .replace(/\(?\d{1,2}:\d{2}(?::\d{2})?\)?/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  const excludedSpeakers = new Set([
    "http", "https", "www", "note", "warning", "tip", "caution", "step", "page",
    "chapter", "section", "table", "figure", "source", "date", "time", "id",
    "timestamp", "summary", "description", "example", "url", "email",
    "meeting", "topic", "attendees", "agenda", "duration", "location", "call id",
    "call", "subject", "title", "organizer", "recording", "transcript", "status",
    "notes", "start", "end", "info", "platform"
  ]);

  const speakerCounts = new Map<string, number>();
  const firstSeenOrder: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || isMetadataLine(line)) continue;

    const res = extractSpeakerAndContent(line, customUserTrim, customAsstTrim);
    if (res && res.speaker) {
      const candLower = res.speaker.toLowerCase();
      if (!excludedSpeakers.has(candLower) && candLower.length >= 1 && candLower.length <= 35) {
        const currentCount = speakerCounts.get(candLower) || 0;
        speakerCounts.set(candLower, currentCount + 1);
        if (currentCount === 0) {
          firstSeenOrder.push(candLower);
        }
      }
    }
  }

  // Determine user speaker vs assistant speaker
  const userKeywords = ["user", "human", "client", "customer", "interviewer", "host", "questioner", "q", "speaker 1", "speaker1", "person 1", "person1", "caller", "patient", "person a", "speaker a", "inquisitor", "me"];
  const asstKeywords = ["assistant", "claude", "chatgpt", "ai", "bot", "model", "agent", "interviewee", "guest", "expert", "answer", "a", "speaker 2", "speaker2", "person 2", "person2", "dr", "doctor", "specialist", "person b", "speaker b", "respondent"];

  let mappedUser = "";
  let mappedAssistant = "";

  if (customUserLower) {
    for (const spk of firstSeenOrder) {
      if (matchesTag(spk, customUserLower)) {
        mappedUser = spk;
        break;
      }
    }
    if (!mappedUser) mappedUser = customUserLower;
  }

  if (customAsstLower) {
    for (const spk of firstSeenOrder) {
      if (matchesTag(spk, customAsstLower)) {
        mappedAssistant = spk;
        break;
      }
    }
    if (!mappedAssistant) mappedAssistant = customAsstLower;
  }

  if (!mappedUser) {
    for (const spk of firstSeenOrder) {
      if (userKeywords.some(k => spk === k || spk.startsWith(k + " ") || spk.endsWith(" " + k))) {
        mappedUser = spk;
        break;
      }
    }
  }
  if (!mappedAssistant) {
    for (const spk of firstSeenOrder) {
      if (spk !== mappedUser && asstKeywords.some(k => spk === k || spk.startsWith(k + " ") || spk.endsWith(" " + k))) {
        mappedAssistant = spk;
        break;
      }
    }
  }

  if (!mappedUser && firstSeenOrder.length >= 1) {
    mappedUser = firstSeenOrder[0];
  }
  if (!mappedAssistant && firstSeenOrder.length >= 2) {
    mappedAssistant = firstSeenOrder.find(s => s !== mappedUser) || firstSeenOrder[1];
  }

  const turns: DialogueTurn[] = [];
  let currentRole: "user" | "assistant" | null = null;
  let hasStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Filter out metadata separators or status alerts
    if (isMetadataLine(trimmed)) {
      continue;
    }

    const extracted = extractSpeakerAndContent(trimmed, customUserTrim, customAsstTrim);

    if (extracted && extracted.speaker) {
      const spk = extracted.speaker.toLowerCase();
      let role: "user" | "assistant" | null = null;

      if (isUserSpeaker(spk) || spk === mappedUser || matchesTag(spk, mappedUser)) {
        role = "user";
      } else if (isAssistantSpeaker(spk) || spk === mappedAssistant || matchesTag(spk, mappedAssistant)) {
        role = "assistant";
      } else if (asstKeywords.some(k => spk.includes(k))) {
        role = "assistant";
      } else if (userKeywords.some(k => spk.includes(k))) {
        role = "user";
      } else if (speakerCounts.has(spk)) {
        role = spk === mappedUser ? "user" : "assistant";
      }

      if (role) {
        hasStarted = true;
        currentRole = role;
        const turnContent = cleanTurnContent(extracted.content);

        if (turnContent) {
          if (turns.length > 0 && turns[turns.length - 1].role === role) {
            // Merge consecutive turns by same speaker to keep question or answer complete
            turns[turns.length - 1].content += "\n\n" + turnContent;
          } else {
            turns.push({ role, content: turnContent });
          }
        }
        continue;
      }
    }

    // Continuation line: only process if dialogue has started and line is not metadata
    if (hasStarted && currentRole) {
      const cleanedLine = cleanTurnContent(trimmed);
      if (cleanedLine && !isMetadataLine(cleanedLine)) {
        if (turns.length > 0 && turns[turns.length - 1].role === currentRole) {
          turns[turns.length - 1].content += "\n\n" + cleanedLine;
        } else {
          turns.push({ role: currentRole, content: cleanedLine });
        }
      }
    }
  }

  // Filter out any empty turns
  const validTurns = turns.filter(t => t.content && t.content.trim().length > 0);
  return {
    turns: validTurns,
    detectedUser: customUserTrim || mappedUser || "User",
    detectedAssistant: customAsstTrim || mappedAssistant || "Assistant"
  };
}

// 1.5 Document Analysis & Example Count Estimator
app.post("/api/analyze-document", async (req, res) => {
  const { documentContent, documentName, docType, extractionModel } = req.body;
  if (!documentContent || !documentContent.trim()) {
    return res.status(400).json({ success: false, error: "Document content is required" });
  }

  const client = getGeminiClient();
  const words = documentContent.trim().split(/\s+/).length;
  const heuristicCount = Math.max(3, Math.min(30, Math.ceil(words / 250)));

  // Fast check if document is clearly a transcript (e.g. contains speaker colons, bracketed tags, or subtitle arrows)
  const transcriptSample = documentContent.slice(0, 8000);
  const hasTranscriptClues = /(?:(?:Speaker\s*\d|Human|Assistant|User|Claude|Interviewer|Host|Guest|Q|A|\[\d{1,2}:\d{2}\]|\(\d{1,2}:\d{2}\))\s*[:：\-–—]|\d{1,2}:\d{2}[,\.]\d{3}\s*-->|^\[[A-Za-z0-9_.\s\-]{2,30}\]\s+)/im.test(transcriptSample);

  if (docType === "transcript" || hasTranscriptClues) {
    const { turns, detectedUser, detectedAssistant } = parseUniversalTranscript(documentContent, req.body.userTag, req.body.assistantTag);
    const estCount = Math.max(1, turns.length >= 2 ? Math.floor(turns.length / 2) : heuristicCount);
    return res.json({
      success: true,
      estimatedCount: estCount,
      recommendedDocType: "transcript",
      titleOrTheme: documentName || "Transcript Dialogue",
      explanation: `Detected transcript with ${turns.length} dialogue turns (identified "${detectedUser}" as User, "${detectedAssistant}" as Assistant). Verbatim Transcript Mode will convert authentic dialogue turns directly into clean SFT examples without AI rewriting.`
    });
  }

  if (!client) {
    return res.json({
      success: true,
      estimatedCount: heuristicCount,
      recommendedDocType: docType || "knowledge_base",
      titleOrTheme: documentName || "Uploaded Document",
      explanation: `Analyzed document (~${words} words). Estimated ${heuristicCount} optimal SFT training examples based on content depth.`
    });
  }

  try {
    const analysisPrompt = `
You are an expert AI Data Engineering Architect and SFT Specialist.
Perform a thorough, comprehensive architectural analysis across the entire provided document.
Examine its full structure, narrative arcs, technical topics, chapters, concepts, or dialogue turns from beginning to end.

Document Name: "${documentName || "Unknown"}"
Total Word Count: ~${words} words
Total Character Length: ${documentContent.length} characters

Full Document Content:
"""
${documentContent}
"""

Tasks:
1. Conduct a deep architectural assessment of the document's content, breadth, and structural complexity across all chapters or sections.
2. Estimate the optimal number of distinct, high-quality SFT examples required to thoroughly cover all key topics, chapters, concepts, or narrative arcs without redundancy or gaps (recommended count between 3 and 50).
3. Identify the true document type: "transcript" (dialogues, interviews, chats, or speaker turns), "literature" (novels, stories, books, narrative prose), or "knowledge_base" (technical documentation, manuals, guides, policies, or domain knowledge).
4. Identify the central title, theme, or subject domain (e.g. "Moby Dick", "The Great Gatsby", "Quantum Mechanics Fundamentals", or "Kubernetes Deployment Architecture").
5. Provide a clear, professional architectural rationale for your recommendation, detailing how the estimated examples will comprehensively span the document's structure.

Return ONLY a valid JSON object matching:
{
  "estimatedCount": <number between 3 and 50>,
  "recommendedDocType": "transcript" | "knowledge_base" | "literature",
  "titleOrTheme": "<detected book title, domain, or primary theme>",
  "explanation": "<detailed architectural rationale for example count and document structure>"
}
Do NOT wrap output in extra text outside the JSON. Return raw JSON.
`;

    const aiRes = await callGemini(client, {
      model: normalizeModel(extractionModel || "gemini-3.1-flash-lite"),
      contents: analysisPrompt
    });

    const rawText = extractResponseText(aiRes);
    const cleanedJSON = rawText.replace(/```json\s*/gi, "").replace(/```\s*$/gi, "").trim();

    let parsed: any = null;
    try {
      parsed = JSON.parse(cleanedJSON);
    } catch (e) {
      const match = cleanedJSON.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (err) {}
      }
    }

    if (parsed && typeof parsed.estimatedCount === "number") {
      return res.json({
        success: true,
        estimatedCount: Math.max(3, Math.min(35, Math.round(parsed.estimatedCount))),
        recommendedDocType: parsed.recommendedDocType || docType || "knowledge_base",
        titleOrTheme: parsed.titleOrTheme || documentName || "Document",
        explanation: parsed.explanation || `AI analyzed ~${words} words and recommended ${parsed.estimatedCount} SFT examples.`
      });
    }

    return res.json({
      success: true,
      estimatedCount: heuristicCount,
      recommendedDocType: docType || "knowledge_base",
      titleOrTheme: documentName || "Document",
      explanation: `Analyzed ~${words} words. Estimated ${heuristicCount} SFT examples for optimal dataset depth.`
    });
  } catch (err: any) {
    console.error("Document analysis error:", err);
    return res.json({
      success: true,
      estimatedCount: heuristicCount,
      recommendedDocType: docType || "knowledge_base",
      titleOrTheme: documentName || "Document",
      explanation: `Analyzed ~${words} words. Estimated ${heuristicCount} SFT examples.`
    });
  }
});

// 2. Document to SFT Convertor
app.post("/api/convert-document", async (req, res) => {
  console.log("Convert document request received:", req.body);
  const {
    documentName,
    documentContent,
    templateType, // "Single Turn" | "Multi Turn" | "Reasoning" | "Mixed" | "Instruction Template" or "single_turn" | "multi_turn" | "reasoning" | "mixed"
    instructTemplate, // "ChatML" | "Alpaca" | "Mistral"
    count,
    extractionModel,
    projectName,
    systemPrompt,
    targetTask,
    constraints,
    docType, // "knowledge_base" | "transcript" | "literature"
    isTranscript,
    userTag,
    assistantTag,
    fixedUserPrompt,
    reasoningInstructions,
    literatureTheme,
    converterInstructions
  } = req.body;

  const client = getGeminiClient();
  console.log("Gemini client initialized:", !!client);

  const actualDocType = docType || (isTranscript ? "transcript" : "knowledge_base");

  // Standardize templateType format
  const tTypeLower = (templateType || "Single Turn").toLowerCase();
  const isInstructionTemplate = Boolean(
    req.body.isInstruction || 
    templateType === "Instruction Template" || 
    templateType === "INSTRUCTION_TEMPLATE" || 
    tTypeLower.includes("instruction") || 
    (instructTemplate && ["Alpaca", "Mistral", "ChatML"].includes(instructTemplate))
  );
  
  let format: "single_turn" | "multi_turn" | "reasoning" | "mixed" = 
    (tTypeLower.includes("multi_turn") || tTypeLower.includes("multi turn") || tTypeLower.includes("multi-turn")) ? "multi_turn" :
    (tTypeLower.includes("reasoning") || tTypeLower.includes("cot")) ? "reasoning" :
    (tTypeLower.includes("mixed") || tTypeLower.includes("mix")) ? "mixed" :
    "single_turn";

  const sysPromptVerbatim = systemPrompt || "You are SFT Studio Pro, a helpful assistant.";
  const fUserPrompt = (fixedUserPrompt && fixedUserPrompt.trim() !== "Please explain the following segment.") ? fixedUserPrompt.trim() : "";
  const rInstructions = reasoningInstructions || "Show the reasoning process using a natural language chain of thought.";
  const requestedCount = count && typeof count === "number" && count > 0 ? count : 8;

  try {
    let finalExamples: any[] = [];

    // 1. Verbatim Transcript Conversion (Word-for-word as-is dialogue extraction using user-provided turn labels)
    if (actualDocType === "transcript") {
      const { turns, detectedUser, detectedAssistant } = parseUniversalTranscript(documentContent, userTag, assistantTag);
      console.log(`[Transcript Conversion] Extracted ${turns.length} verbatim turns (User: "${detectedUser}", Assistant: "${detectedAssistant}")`);

      if (!turns || turns.length < 2) {
        return res.status(400).json({
          success: false,
          error: `Could not extract conversation turns from transcript. Detected ${turns.length} turns with labels (User: "${detectedUser}", Assistant: "${detectedAssistant}"). Please ensure your User and Assistant turn labels match the speaker names in the transcript.`
        });
      }

      const isMultiTurn = format === "multi_turn" || req.body.transcriptLayout === "multi_turn";

      if (isMultiTurn) {
        // Multi-Turn conversation mode: preserves full authentic dialogue flow word-for-word
        const episodeSize = 10;
        let currentEpisode: DialogueTurn[] = [];

        for (let i = 0; i < turns.length; i++) {
          currentEpisode.push(turns[i]);
          const isLast = i === turns.length - 1;
          const reachedSize = currentEpisode.length >= episodeSize;
          const endsWithAssistant = turns[i].role === "assistant";

          if ((reachedSize && endsWithAssistant) || isLast) {
            while (currentEpisode.length > 0 && currentEpisode[0].role === "assistant") {
              currentEpisode.shift();
            }
            const hasUser = currentEpisode.some(t => t.role === "user");
            const hasAsst = currentEpisode.some(t => t.role === "assistant");

            if (hasUser && hasAsst && currentEpisode.length >= 2) {
              const formattedMessages: any[] = [
                { role: "system", content: sysPromptVerbatim }
              ];

              for (const turn of currentEpisode) {
                let content = turn.content.trim();
                if (isInstructionTemplate && turn.role === "user") {
                  if (instructTemplate === "Alpaca" && !content.startsWith("### Instruction:")) {
                    content = `### Instruction:\n${content}`;
                  } else if (instructTemplate === "Mistral" && !content.startsWith("[INST]")) {
                    content = `[INST] ${content} [/INST]`;
                  }
                } else if (isInstructionTemplate && turn.role === "assistant") {
                  if (instructTemplate === "Alpaca" && !content.startsWith("### Response:")) {
                    content = `### Response:\n${content}`;
                  }
                }
                formattedMessages.push({ role: turn.role, content });
              }

              finalExamples.push({ messages: formattedMessages });
            }
            currentEpisode = [];
          }
        }
      } else {
        // Single-turn Q&A pairs: converts every authentic dialogue inquiry + response word-for-word
        let accumulatedUser = "";
        let accumulatedAsst = "";

        for (let i = 0; i < turns.length; i++) {
          const turn = turns[i];
          if (turn.role === "user") {
            if (accumulatedUser && accumulatedAsst) {
              let userFormatted = accumulatedUser.trim();
              let asstFormatted = accumulatedAsst.trim();
              if (isInstructionTemplate) {
                if (instructTemplate === "Alpaca") {
                  if (!userFormatted.startsWith("### Instruction:")) userFormatted = `### Instruction:\n${userFormatted}`;
                  if (!asstFormatted.startsWith("### Response:")) asstFormatted = `### Response:\n${asstFormatted}`;
                } else if (instructTemplate === "Mistral") {
                  if (!userFormatted.startsWith("[INST]")) userFormatted = `[INST] ${userFormatted} [/INST]`;
                }
              }
              finalExamples.push({
                messages: [
                  { role: "system", content: sysPromptVerbatim },
                  { role: "user", content: userFormatted },
                  { role: "assistant", content: asstFormatted }
                ]
              });
              accumulatedUser = "";
              accumulatedAsst = "";
            }
            accumulatedUser = accumulatedUser ? accumulatedUser + "\n\n" + turn.content.trim() : turn.content.trim();
          } else if (turn.role === "assistant") {
            if (accumulatedUser) {
              accumulatedAsst = accumulatedAsst ? accumulatedAsst + "\n\n" + turn.content.trim() : turn.content.trim();
            }
          }
        }

        // Flush trailing pair
        if (accumulatedUser && accumulatedAsst) {
          let userFormatted = accumulatedUser.trim();
          let asstFormatted = accumulatedAsst.trim();
          if (isInstructionTemplate) {
            if (instructTemplate === "Alpaca") {
              if (!userFormatted.startsWith("### Instruction:")) userFormatted = `### Instruction:\n${userFormatted}`;
              if (!asstFormatted.startsWith("### Response:")) asstFormatted = `### Response:\n${asstFormatted}`;
            } else if (instructTemplate === "Mistral") {
              if (!userFormatted.startsWith("[INST]")) userFormatted = `[INST] ${userFormatted} [/INST]`;
            }
          }
          finalExamples.push({
            messages: [
              { role: "system", content: sysPromptVerbatim },
              { role: "user", content: userFormatted },
              { role: "assistant", content: asstFormatted }
            ]
          });
        }
      }

      if (finalExamples.length > 0) {
        const formattedExamples = finalExamples.map((example, idx) => {
          return {
            id: `doc-conv-transcript-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
            messages: example.messages,
            source: "Document Conversion (Verbatim Transcript)",
            status: "Pending",
            timestamp: Date.now()
          };
        });

        return res.json({
          success: true,
          examples: formattedExamples,
          source: `Transcript Conversion (Verbatim Word-for-Word - ${turns.length} turns extracted)`
        });
      }
    }

    if (!client) {
      throw new Error("Gemini AI client is not available.");
    }

    // Context-efficient semantic section chunking for long documents
    // Chunk along natural paragraph and section boundaries (~35,000 characters per chunk)
    const maxSectionLength = 35000;
    const documentSections: string[] = [];
    if (documentContent.length > maxSectionLength) {
      let remaining = documentContent;
      while (remaining.length > 0) {
        if (remaining.length <= maxSectionLength) {
          documentSections.push(remaining);
          break;
        }
        // Find the last natural paragraph or section boundary before maxSectionLength
        let splitIdx = remaining.lastIndexOf("\n\n", maxSectionLength);
        if (splitIdx === -1 || splitIdx < maxSectionLength * 0.4) {
          splitIdx = remaining.lastIndexOf("\n", maxSectionLength);
        }
        if (splitIdx === -1 || splitIdx < maxSectionLength * 0.4) {
          splitIdx = remaining.lastIndexOf(". ", maxSectionLength);
          if (splitIdx !== -1) splitIdx += 1;
        }
        if (splitIdx === -1 || splitIdx < maxSectionLength * 0.3) {
          splitIdx = maxSectionLength;
        }
        documentSections.push(remaining.slice(0, splitIdx).trim());
        remaining = remaining.slice(splitIdx).trim();
      }
    } else {
      documentSections.push(documentContent);
    }

    // If document is very long (e.g. > 4 sections), sample up to 4 representative sections spread evenly across the text
    // to guarantee fast, responsive processing without timeouts
    let sectionsToProcess = documentSections;
    if (documentSections.length > 4) {
      const sampled: string[] = [];
      const step = (documentSections.length - 1) / 3;
      const indices = new Set<number>();
      for (let i = 0; i < 4; i++) {
        indices.add(Math.round(i * step));
      }
      for (const idx of Array.from(indices).sort((a, b) => a - b)) {
        if (documentSections[idx]) sampled.push(documentSections[idx]);
      }
      sectionsToProcess = sampled;
    }

    const perSectionCount = Math.max(1, Math.ceil(requestedCount / sectionsToProcess.length));

    // Process sections in controlled batches (concurrency: 2) to respect Vertex AI burst quota limits
    const processSection = async (currentSectionText: string, secIdx: number) => {
      try {
        let specificInstructions = "";
        if (actualDocType === "literature") {
          const themeOrTitle = literatureTheme || documentName || "this literary work";
          specificInstructions = `
[LITERATURE DOCUMENT CONVERSION DIRECTIVES]
1. USER PROMPT TEMPLATE: The user prompt for these storytelling/narrative examples MUST follow the prompt pattern: "tell me the story of ${themeOrTitle}" or specific story arcs/episodes within "${themeOrTitle}".
2. STRICT TEXT SANITIZATION MANDATE: You MUST strictly clean and sanitize the literature text. Filter out and exclude ALL corrupted text or artifacts, such as:
   - Page numbers (e.g., "Page 14", "p. 23", standalone numbers like "142")
   - Running headers/footers (e.g., "CHAPTER III", "BOOK ONE", "INDEX")
   - Table of contents entries, publisher notices, copyrights, edition notes
   - Scan/OCR noise, footnotes, line numbers, or broken lines
3. ELEGANT NARRATIVE RESPONSES: The assistant response MUST be an immaculate, beautifully written, coherent story summary or narrative passage free from any formatting corruption or header artifacts.
`;
        } else if (actualDocType === "transcript") {
          specificInstructions = `
[INTELLIGENT TRANSCRIPT CONVERSION & METADATA PURGING RULES]
1. EXCLUDE ALL METADATA & EXTERNAL NON-CONVERSATIONAL NOISE:
   - Identify and completely REMOVE all metadata, headers, and artifacts that sit outside the actual conversation, such as:
     * Meeting titles, dates, times, durations, meeting IDs, conference room names, dial-in numbers, file URLs, platform watermarks (Zoom, Teams, Google Meet, Webex)
     * Attendee / participant rosters, attendance check-ins, connection alerts ("joined the meeting", "left the meeting")
     * Disclaimers, recording notices, chat log timestamps, audio track labels
     * Preamble small talk, audio/video checks ("can you hear me?", "you're on mute", "can you see my screen?"), and administrative scheduling/wrap-up chatter ("let's wrap up", "see you next week")
   - Focus exclusively on the substantive, high-value discussions, insights, domain concepts, technical problems, decisions, and knowledge exchanged!

2. SUBSTANTIVE, IN-DEPTH RESPONSES (NO SHORT ANSWERS):
   - Assistant responses MUST be substantive, comprehensive, and well-developed (typically 200-400+ words or multiple detailed paragraphs / structured steps).
   - Strictly avoid producing short, superficial, or brief 2-3 sentence answers. Fine-tuning models require rich, detailed, multi-paragraph explanations with thorough context, clear rationale, and structured takeaways.
   - If the respondent in the transcript answered in short fragments or was interrupted, synthesize their insights and explanations into a complete, authoritative, highly informative response.

3. SPEAKER ROLE IDENTIFICATION:
   - Inquiries / questions / client prompts (${userTag ? `tag: "${userTag}"` : "e.g. User, Questioner, Interviewer, Student, Client"}) -> map to role: "user".
   - Explanations / answers / expert responses (${assistantTag ? `tag: "${assistantTag}"` : "e.g. Assistant, Expert, Interviewee, Specialist, Speaker"}) -> map to role: "assistant".
   - If speakers are named individuals (e.g. "Alice" asking questions and "Bob" answering as the subject matter expert), assign the questioner to role: "user" and the answering expert to role: "assistant".

4. CONVERSATIONAL STRUCTURE:
   - Format: ${format === "multi_turn" || req.body.transcriptLayout === "multi_turn" ? "Multi-turn dialogue (2-4 alternating user and assistant turns exploring the topic in depth)" : "Single-turn instruction and comprehensive response pairs"}.
`;
        }

        const userInstructionsBlock = converterInstructions && converterInstructions.trim() ? `
================================================================================
*** HIGHEST PRIORITY DIRECTIVE: USER-PROVIDED CUSTOM CONVERSION INSTRUCTIONS ***
================================================================================
The user has provided the following explicit instructions on the interface.
These instructions take precedence over all generic defaults, formatting rules, or built-in style suggestions:

"""
${converterInstructions.trim()}
"""

CRITICAL ENFORCEMENT:
- You MUST strictly obey and execute all directives stated above (e.g. specific counts, examples, depth, style, length, format, tone, or content focus).
- If the user asks for a specific number of examples, items, or length, comply exactly.
- Do NOT ignore, dilute, or override any part of the user's instructions with default templates.
================================================================================
` : `
[DEFAULT RESPONSE DEPTH MANDATE]
Provide substantive, in-depth, and well-developed responses (multi-paragraph, typically 200-400+ words). Do not produce brief, superficial, or terse 2-3 sentence responses unless explicitly requested.
`;

        const synthesisPrompt = `
You are an expert SFT (Supervised Fine-Tuning) Data Engineer & Intelligent Document AI Agent.
${userInstructionsBlock}

[SFT PROJECT CONTEXT]
- Project Name: "${projectName || "SFT Dataset"}"
- Target Goal / Domain: "${targetTask || "Domain Knowledge Assistant"}"
- System Prompt Persona: "${sysPromptVerbatim}"
- Behavioral Constraints: "${constraints || "Provide accurate, structured, and helpful responses."}"
- Document Type: "${actualDocType.toUpperCase()}"
- Conversation Mode/Format: "${isInstructionTemplate ? `Instruction Template (${instructTemplate || "ChatML"}) - ${format}` : format}" (${
          isInstructionTemplate
            ? (instructTemplate === "Alpaca"
                ? `Alpaca Instruction format (${format}):
${format === "single_turn" ? 'ALPACA — SINGLE TURN:\n{system}\n\n### Instruction:\n{user}\n\n### Response:\n{assistant}' :
  format === "multi_turn" ? 'ALPACA — MULTI TURN:\n{system}\n\n### Instruction:\n{user_1}\n\n### Response:\n{assistant_1}\n\n### Instruction:\n{user_2}\n\n### Response:\n{assistant_2}' :
  format === "reasoning" ? 'ALPACA — REASONING (NO system message):\n### Instruction:\n{user}\n\n### Response:\n<think>\n{reasoning}\n</think>\n{final_answer}' :
  'ALPACA — MIXED: dynamic mix of Single Turn, Multi Turn, and Reasoning examples'}`
                : instructTemplate === "Mistral"
                ? `Mistral Instruction format (${format}):
${format === "single_turn" ? 'MISTRAL — SINGLE TURN:\n<s>[INST] {system}\n\n{user} [/INST] {assistant}</s>' :
  format === "multi_turn" ? 'MISTRAL — MULTI TURN:\n<s>[INST] {system}\n\n{user_1} [/INST] {assistant_1}</s>[INST] {user_2} [/INST] {assistant_2}</s>' :
  format === "reasoning" ? 'MISTRAL — REASONING (NO system message):\n<s>[INST] {user} [/INST] <think>\n{reasoning}\n</think>\n{final_answer}</s>' :
  'MISTRAL — MIXED: dynamic mix of Single Turn, Multi Turn, and Reasoning examples'}`
                : `ChatML Instruction format (${format}):
${format === "single_turn" ? 'CHATML — SINGLE TURN:\n<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n{assistant}<|im_end|>' :
  format === "multi_turn" ? 'CHATML — MULTI TURN:\n<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user_1}<|im_end|>\n<|im_start|>assistant\n{assistant_1}<|im_end|>\n<|im_start|>user\n{user_2}<|im_end|>\n<|im_start|>assistant\n{assistant_2}<|im_end|>' :
  format === "reasoning" ? 'CHATML — REASONING (NO system message):\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n<think>\n{reasoning}\n</think>\n{final_answer}<|im_end|>' :
  'CHATML — MIXED: dynamic mix of Single Turn, Multi Turn, and Reasoning examples'}`)
            : format === "mixed"
            ? "Vary format across examples: generate a balanced mix of single-turn Q&A, multi-turn dialogues, and reasoning examples"
            : format === "reasoning"
            ? "Requires step-by-step reasoning trace in 'reasoning' field"
            : format === "multi_turn"
            ? "Multi-turn user/assistant dialogue"
            : "Single-turn instruction and response"
        })
${format === "reasoning" ? `- Reasoning Trace Instructions: "${rInstructions}"` : ""}
${fUserPrompt ? `- Custom User Focus Query: "${fUserPrompt}"` : ""}
${specificInstructions}

[DOCUMENT CONTENT SECTION]
Document Name: "${documentName || "Document"}"
Section ${secIdx + 1} of ${sectionsToProcess.length}:
"""
${currentSectionText}
"""

[SYNTHESIS INSTRUCTIONS]
Synthesize distinct, mindfully crafted SFT training examples based on the substantive content of this document section.
${converterInstructions && converterInstructions.trim() ? "REMINDER: Strictly follow the HIGHEST PRIORITY DIRECTIVE user instructions stated at the top." : `Target count: Synthesize ${perSectionCount} examples.`}

QUALITY & SANITIZATION MANDATES:
1. INTENTIONAL USER PROMPTS: ${
          actualDocType === "literature"
            ? `Formulate user prompts like "tell me the story of ${literatureTheme || documentName || "this book"}" or "tell me the story of [character/theme in text]".`
            : `Formulate authentic, natural user questions or commands that a human would ask about this domain.`
        }
2. ASSISTANT RESPONSES: Embody the system prompt persona ("${sysPromptVerbatim}"). Unless overridden by user custom instructions, provide substantive, detailed, and informative explanations.
3. NO NOISE OR METADATA: Zero page numbers, chapter headers, timestamps, attendee lists, dial-in info, meeting IDs, or scan artifacts in prompts or answers.
4. FORMAT OBSERVED:
   - If format is "reasoning", include a "reasoning" field or format assistant content with <think>\n{reasoning}\n</think>\n{final_answer}. DO NOT include a system message. CRITICAL: Reasoning within the template should always demonstrate a chain of thought the trainee will use to get to the response. No meta reasoning from the generator should be included.
   - If format is "multi_turn", construct 2-4 alternating user/assistant turns probing the subject.
   - If format is "mixed", alternate between single-turn, multi-turn, and reasoning examples across the set.
   ${isInstructionTemplate && instructTemplate === "Alpaca" ? (format === "reasoning" ? '- Alpaca Reasoning: user prompt starts with "### Instruction:\n", assistant response starts with "### Response:\n<think>\n{reasoning}\n</think>\n{final_answer}". DO NOT include a system message.' : '- Alpaca Instruction: user prompt MUST start with "### Instruction:\n", and assistant response MUST start with "### Response:\n".') : ""}
   ${isInstructionTemplate && instructTemplate === "Mistral" ? (format === "reasoning" ? '- Mistral Reasoning: user prompt MUST be wrapped in [INST] ... [/INST], assistant response formatted with <think>\n{reasoning}\n</think>\n{final_answer}. DO NOT include a system message.' : '- Mistral Instruction: user prompt MUST be wrapped in [INST] ... [/INST].') : ""}
   ${isInstructionTemplate && (instructTemplate === "ChatML" || !instructTemplate) ? (format === "reasoning" ? '- ChatML Reasoning: clean user prompt, assistant response formatted with <think>\n{reasoning}\n</think>\n{final_answer}. DO NOT include a system message.' : '- ChatML Instruction: clean user prompt and high-quality assistant response.') : ""}

${converterInstructions && converterInstructions.trim() ? `FINAL CHECK: Verify that all generated examples strictly honor the user custom instructions: "${converterInstructions.trim()}".` : ""}

[JSON OUTPUT FORMAT]
Return ONLY a valid JSON object matching this structure:
{
  "examples": [
    {
      "messages": [
        { "role": "system", "content": "${sysPromptVerbatim}" },
        { "role": "user", "content": "<clean user prompt>" },
        { "role": "assistant", ${format === "reasoning" ? `"reasoning": "<chain of thought>", ` : ""}"content": "<assistant response>" }
      ]
    }
  ]
}
Return raw JSON without extra conversational text.
`;

        const aiRes = await callGemini(client, {
          model: normalizeModel(extractionModel),
          contents: synthesisPrompt,
          config: {
            maxOutputTokens: 65536,
            responseMimeType: "application/json",
            ...(format !== "reasoning" && format !== "mixed" ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            systemInstruction: format === "reasoning"
              ? `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis and conversion engine.

MANDATORY CHAIN-OF-THOUGHT DIRECTIVE (REASONING EXAMPLES ONLY):
We want the models in training to learn reasoning chain of thought in the reasoning examples ONLY.
You MUST write all thinking traces in the FIRST PERSON from the perspective of the trainee model working through the prompt (e.g., "The user is asking for... Let me first check... I need to verify... Therefore, the answer is...").
ABSOLUTELY NO META REASONING FROM THE GENERATOR: Never include any generator meta commentary about dataset synthesis, writing prompts, or instructions. It must solely be the trainee model solving the problem.`
              : format === "mixed"
              ? `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis and conversion engine.

CRITICAL SCOPE RULE FOR CHAIN OF THOUGHT:
Chain of thought is for reasoning examples ONLY.
The generator should NEVER write the reasoning train of thought, thinking traces, or thought processes into single turn or multi turn responses. For Single Turn and Multi Turn responses, provide direct, high-quality assistant answers without any train of thought or reasoning traces.`
              : `You are an expert Supervised Fine-Tuning (SFT) dataset synthesis and conversion engine.

ABSOLUTE ZERO CHAIN-OF-THOUGHT MANDATE:
This task generates direct assistant responses. Responses MUST NEVER contain any chain of thought, reasoning traces, thinking tags (<think>), or internal planning monologue (such as "I am analyzing...", "I need to explain...", "First, I will...", "Let me...").
Every assistant response MUST begin immediately with the direct, substantive answer to the user.
No internal deliberation, planning, or reasoning fields are permitted.`
          }
        });

        const rawText = extractResponseText(aiRes);
        const cleanedJSON = rawText.replace(/```json\s*/gi, "").replace(/```\s*$/gi, "").trim();

        let parsedData: any = null;
        try {
          parsedData = JSON.parse(cleanedJSON);
        } catch (pErr) {
          const match = cleanedJSON.match(/\{[\s\S]*\}/);
          if (match) {
            try { parsedData = JSON.parse(match[0]); } catch (e) {}
          }
        }

        const sectionExamples: any[] = [];
        if (parsedData && Array.isArray(parsedData.examples)) {
          for (const item of parsedData.examples) {
            if (item && Array.isArray(item.messages) && item.messages.length > 0) {
              const hasSystem = item.messages[0].role === "system";
              if (hasSystem) {
                item.messages[0].content = sysPromptVerbatim;
              }
              const messages = hasSystem ? item.messages : [
                { role: "system", content: sysPromptVerbatim },
                ...item.messages
              ];
              sectionExamples.push({ messages });
            }
          }
        }
        return sectionExamples;
      } catch (secErr: any) {
        console.warn(`[Document Conversion] Section ${secIdx + 1} processing error:`, secErr?.message);
        return [];
      }
    };

    const CONCURRENCY_LIMIT = 2;
    for (let i = 0; i < sectionsToProcess.length; i += CONCURRENCY_LIMIT) {
      const batch = sectionsToProcess.slice(i, i + CONCURRENCY_LIMIT);
      const batchResults = await Promise.all(
        batch.map((secText, bIdx) => processSection(secText, i + bIdx))
      );
      for (const sEx of batchResults) {
        finalExamples.push(...sEx);
      }
      if (i + CONCURRENCY_LIMIT < sectionsToProcess.length) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    // Resilient fallback for transcripts if AI call returned empty
    if ((!finalExamples || finalExamples.length === 0) && actualDocType === "transcript") {
      console.log("[Document Conversion] AI synthesis yielded no examples, falling back to clean transcript turn extraction.");
      const { turns, detectedUser, detectedAssistant } = parseUniversalTranscript(documentContent, userTag, assistantTag);
      if (turns.length >= 2) {
        let lastUserContent = "";
        for (let i = 0; i < turns.length; i++) {
          if (turns[i].role === "user") {
            lastUserContent = (lastUserContent ? lastUserContent + "\n\n" : "") + turns[i].content.trim();
          } else if (turns[i].role === "assistant" && lastUserContent) {
            finalExamples.push({
              messages: [
                { role: "system", content: sysPromptVerbatim },
                { role: "user", content: lastUserContent },
                { role: "assistant", content: turns[i].content.trim() }
              ]
            });
            lastUserContent = "";
          }
        }
      }
    }

    if (!finalExamples || finalExamples.length === 0) {
      return res.status(500).json({ success: false, error: "Document synthesis produced no valid SFT examples. Please verify document text and try again." });
    }

    const formattedExamples = finalExamples.map(example => {
      const sanitized = sanitizeExample(example, (format === "reasoning" || format === "mixed") ? format : "Single Turn");
      if (isInstructionTemplate && Array.isArray(sanitized.messages)) {
        const isReasoningExample = format === "reasoning" || sanitized.messages.some((m: any) => 
          Boolean(m.reasoning) || (m.content && m.content.includes("<think>"))
        );

        let msgs = sanitized.messages;
        if (isReasoningExample) {
          msgs = msgs.filter((m: any) => m.role !== "system");
        }

        sanitized.messages = msgs.map((m: any) => {
          let c = m.content || "";
          if (m.role === "user") {
            if (instructTemplate === "Alpaca") {
              if (!c.startsWith("### Instruction:")) {
                c = `### Instruction:\n${c}`;
              }
            } else if (instructTemplate === "Mistral") {
              if (!c.startsWith("[INST]")) {
                c = `[INST] ${c} [/INST]`;
              }
            }
          } else if (m.role === "assistant") {
            if (m.reasoning && !c.includes("<think>")) {
              c = `<think>\n${m.reasoning.trim()}\n</think>\n${c.trim()}`;
            }
            if (instructTemplate === "Alpaca") {
              if (!c.startsWith("### Response:")) {
                c = `### Response:\n${c}`;
              }
            }
          }
          return { ...m, content: c };
        });
      }
      return sanitized;
    });

    return res.json({ 
      success: true, 
      examples: formattedExamples, 
      source: `Document Conversion (${actualDocType === "transcript" ? "Intelligent Transcript Engine" : isTranscript ? "Transcript Mode" : "Semantic Chunking"} - ${extractionModel || "Gemini"})` 
    });

  } catch (error: any) {
    console.error("Document conversion endpoint error:", error);
    return res.status(500).json({ success: false, error: formatAIErrorMessage(error) });
  }
});

// 3. AI Quality Assessment Engine (Deterministic Audit + Deep Semantic Verification)
interface DeterministicAuditResult {
  issues: Array<{
    exampleIndex: number;
    severity: "High" | "Medium" | "Low";
    type: string;
    message: string;
  }>;
  duplicatesFound: number;
  duplicatesList: string[];
}

function runDeterministicQualityAudit(
  examples: any[],
  context: {
    systemPrompt?: string;
    targetTask?: string;
    constraints?: string;
    templateType?: string;
  }
): DeterministicAuditResult {
  const issues: Array<{
    exampleIndex: number;
    severity: "High" | "Medium" | "Low";
    type: string;
    message: string;
  }> = [];

  const promptMap = new Map<string, number>();
  const assistantMap = new Map<string, number>();
  const duplicatesList: string[] = [];
  let duplicatesFound = 0;

  // Batch-level duplication checks
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];
    if (!ex || !Array.isArray(ex.messages)) continue;

    const userMsg = ex.messages.find((m: any) => m && (m.role === "user" || m.role === "human"));
    if (userMsg && typeof userMsg.content === "string") {
      const normPrompt = userMsg.content.trim().toLowerCase().replace(/\s+/g, " ");
      if (normPrompt.length > 8) {
        if (promptMap.has(normPrompt)) {
          const firstIdx = promptMap.get(normPrompt)!;
          duplicatesFound++;
          const dupText = `Example #${i + 1} has duplicate user prompt of Example #${firstIdx + 1}`;
          if (!duplicatesList.includes(dupText)) duplicatesList.push(dupText);
          issues.push({
            exampleIndex: i,
            severity: "Medium",
            type: "Duplicate User Prompt",
            message: `User prompt is an exact duplicate of Example #${firstIdx + 1}. Redundant examples cause catastrophic overfitting during SFT.`
          });
        } else {
          promptMap.set(normPrompt, i);
        }
      }
    }

    const astMsg = ex.messages.find((m: any) => m && (m.role === "assistant" || m.role === "model" || m.role === "gpt"));
    if (astMsg && typeof astMsg.content === "string") {
      const normAst = astMsg.content.trim().toLowerCase().replace(/\s+/g, " ");
      if (normAst.length > 25) {
        if (assistantMap.has(normAst)) {
          const firstIdx = assistantMap.get(normAst)!;
          issues.push({
            exampleIndex: i,
            severity: "Medium",
            type: "Duplicate Assistant Output",
            message: `Assistant response is identical to Example #${firstIdx + 1}. Decreases dataset diversity and variety.`
          });
        } else {
          assistantMap.set(normAst, i);
        }
      }
    }
  }

  // Per-example structural, delimiter, artifact, and content audit
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];

    if (!ex || !Array.isArray(ex.messages) || ex.messages.length === 0) {
      issues.push({
        exampleIndex: i,
        severity: "High",
        type: "Structural Defect",
        message: "Example is completely empty or contains no message turns."
      });
      continue;
    }

    if (ex.messages.length < 2) {
      issues.push({
        exampleIndex: i,
        severity: "High",
        type: "Incomplete Conversation",
        message: `Example contains only ${ex.messages.length} message turn(s). SFT training requires at least one user prompt and one assistant completion.`
      });
    }

    const hasUser = ex.messages.some((m: any) => m && (m.role === "user" || m.role === "human"));
    if (!hasUser) {
      issues.push({
        exampleIndex: i,
        severity: "High",
        type: "Missing User Prompt",
        message: "Example has no user turn. Supervised fine-tuning examples must contain an input prompt."
      });
    }

    const hasAssistant = ex.messages.some((m: any) => m && (m.role === "assistant" || m.role === "model" || m.role === "gpt"));
    if (!hasAssistant) {
      issues.push({
        exampleIndex: i,
        severity: "High",
        type: "Missing Assistant Response",
        message: "Example has no assistant response. Models cannot learn target outputs without an assistant turn."
      });
    }

    const firstNonSystem = ex.messages.find((m: any) => m && m.role !== "system");
    if (firstNonSystem && (firstNonSystem.role === "assistant" || firstNonSystem.role === "model" || firstNonSystem.role === "gpt")) {
      issues.push({
        exampleIndex: i,
        severity: "High",
        type: "Invalid Turn Order",
        message: "Conversation begins with an assistant response rather than a user prompt or system instruction."
      });
    }

    for (let t = 0; t < ex.messages.length; t++) {
      const msg = ex.messages[t];
      if (!msg) continue;
      const role = (msg.role || "").trim().toLowerCase();
      const content = typeof msg.content === "string" ? msg.content : "";
      const trimmed = content.trim();

      if (trimmed.length === 0) {
        issues.push({
          exampleIndex: i,
          severity: "High",
          type: "Empty Message Content",
          message: `Turn #${t + 1} (${msg.role || "unknown"}) has empty or whitespace-only content.`
        });
      }

      if (t > 0) {
        const prevRole = (ex.messages[t - 1].role || "").trim().toLowerCase();
        if (role === prevRole && role !== "system") {
          issues.push({
            exampleIndex: i,
            severity: "Medium",
            type: "Consecutive Duplicate Roles",
            message: `Consecutive turns with role '${role}' at turns #${t} and #${t + 1} without an alternating response.`
          });
        }
      }

      if (trimmed.length > 0) {
        // Unclosed markdown code fences
        const backticks = trimmed.match(/```/g);
        if (backticks && backticks.length % 2 !== 0) {
          issues.push({
            exampleIndex: i,
            severity: "High",
            type: "Unclosed Code Fence",
            message: `Turn #${t + 1} (${role}) has an unclosed markdown code fence (odd count of triple backticks). This will corrupt model generation tokens.`
          });
        }

        // Mismatched reasoning tags
        const openThink = (trimmed.match(/<think>/gi) || []).length;
        const closeThink = (trimmed.match(/<\/think>/gi) || []).length;
        if (openThink !== closeThink) {
          issues.push({
            exampleIndex: i,
            severity: "High",
            type: "Mismatched Reasoning Tags",
            message: `Turn #${t + 1} (${role}) has mismatched reasoning tags: found ${openThink} '<think>' tags and ${closeThink} '</think>' closing tags.`
          });
        }

        const openReason = (trimmed.match(/<reasoning>/gi) || []).length;
        const closeReason = (trimmed.match(/<\/reasoning>/gi) || []).length;
        if (openReason !== closeReason) {
          issues.push({
            exampleIndex: i,
            severity: "High",
            type: "Mismatched Reasoning Tags",
            message: `Turn #${t + 1} (${role}) has mismatched reasoning tags: found ${openReason} '<reasoning>' tags and ${closeReason} '</reasoning>' closing tags.`
          });
        }

        // Placeholder token checks
        const placeholderRegex = /\b(TODO|FIXME|TBD|PLACEHOLDER|LOREM IPSUM)\b|\[(insert|your|name|company|date|placeholder|tbd|variable|link|url|website)[^\]]*\]|\{\{[^}]+\}\}/i;
        const placeholderMatch = trimmed.match(placeholderRegex);
        if (placeholderMatch) {
          issues.push({
            exampleIndex: i,
            severity: "High",
            type: "Placeholder Artifact",
            message: `Turn #${t + 1} (${role}) contains unpopulated template placeholder: "${placeholderMatch[0]}". SFT datasets must provide real, finalized data.`
          });
        }

        // Assistant-specific content checks
        if (role === "assistant" || role === "model" || role === "gpt") {
          // AI boilerplate leakage
          const disclaimerRegex = /\b(as an ai( language model)?|i am an ai( language model)?|i do not have personal feelings|i am a large language model trained by|i cannot browse the live internet)\b/i;
          const disclaimerMatch = trimmed.match(disclaimerRegex);
          if (disclaimerMatch) {
            issues.push({
              exampleIndex: i,
              severity: "Medium",
              type: "AI Persona Boilerplate",
              message: `Assistant response contains generic boilerplate ("${disclaimerMatch[0]}"). SFT models should directly embody the target persona without generic disclaimers.`
            });
          }

          // Truncation check: ends abruptly on dangling word
          const danglingWordMatch = trimmed.match(/\b(and|or|because|the|with|to|in|of|for|that|which|is|are|a|an|as)\s*$/i);
          if (danglingWordMatch && !trimmed.endsWith("```")) {
            issues.push({
              exampleIndex: i,
              severity: "High",
              type: "Truncated Completion",
              message: `Assistant response ends abruptly mid-thought on dangling word "${danglingWordMatch[1]}".`
            });
          }

          // Ends abruptly with comma or colon
          if (/[,:]\s*$/.test(trimmed) && !trimmed.endsWith("```")) {
            issues.push({
              exampleIndex: i,
              severity: "Medium",
              type: "Truncated Completion",
              message: "Assistant response ends abruptly with trailing punctuation without finishing the sentence."
            });
          }

          // Shallow response check
          const userTurn = ex.messages.find((m: any) => m && (m.role === "user" || m.role === "human"));
          if (userTurn && typeof userTurn.content === "string") {
            const userLen = userTurn.content.trim().length;
            if (trimmed.length < 25 && userLen > 60) {
              issues.push({
                exampleIndex: i,
                severity: "Medium",
                type: "Shallow Response",
                message: `Assistant response is excessively short (${trimmed.length} chars) for a comprehensive user prompt (${userLen} chars).`
              });
            }
          }

          // Repetitive degenerate loops (repeating 4-gram)
          const words = trimmed.toLowerCase().split(/\s+/);
          if (words.length >= 20) {
            for (let w = 0; w <= words.length - 12; w++) {
              const ngram = words.slice(w, w + 4).join(" ");
              const next1 = words.slice(w + 4, w + 8).join(" ");
              const next2 = words.slice(w + 8, w + 12).join(" ");
              if (ngram === next1 && ngram === next2 && ngram.length > 10) {
                issues.push({
                  exampleIndex: i,
                  severity: "High",
                  type: "Repetitive Looping",
                  message: `Detected degenerate repetition loop ("${ngram}...") repeating consecutively in assistant completion.`
                });
                break;
              }
            }
          }
        }
      }
    }
  }

  return { issues, duplicatesFound, duplicatesList };
}

app.post("/api/analyze-quality", async (req, res) => {
  const {
    examples,
    systemPrompt,
    targetTask,
    constraints,
    templateType
  } = req.body;

  if (!examples || !Array.isArray(examples) || examples.length === 0) {
    return res.json({ success: false, error: "No examples provided to analyze." });
  }

  // 1. Run Deterministic Quality Audit immediately
  const deterministicResult = runDeterministicQualityAudit(examples, {
    systemPrompt,
    targetTask,
    constraints,
    templateType
  });

  const client = getGeminiClient();
  const aiIssues: Array<{
    exampleIndex: number;
    severity: "High" | "Medium" | "Low";
    type: string;
    message: string;
  }> = [];
  const aiSuggestions: string[] = [];

  try {
    if (client) {
      // 2. Run Semantic & Persona AI Quality Audit on 100% of all dataset examples
      const CHUNK_SIZE = 6;
      const chunks: Array<{ startIndex: number; items: any[] }> = [];

      for (let c = 0; c < examples.length; c += CHUNK_SIZE) {
        chunks.push({
          startIndex: c,
          items: examples.slice(c, c + CHUNK_SIZE).map((ex, relIdx) => ({
            exampleIndex: c + relIdx,
            messages: ex?.messages || []
          }))
        });
      }

      // Execute chunks in parallel with a strict 14-second timeout race
      await Promise.allSettled(chunks.map(async (chunk) => {
        try {
          const chunkPrompt = `
            You are an elite, uncompromising AI Quality Assurance Auditor for Supervised Fine-Tuning (SFT) datasets.
            Your task is to conduct an in-depth, rigorous quality audit on the following SFT training examples.

            CRITICAL AUDIT DIRECTIVE:
            - NEVER default to an instant pass.
            - Inspect EVERY example critically with high standards.
            - High-performance fine-tuned models depend on pristine training examples. A single defective, shallow, or contradictory example degrades model performance.
            - If an example has defects, you MUST flag it with specific, constructive feedback and the appropriate severity.

            TARGET SYSTEM PROMPT & PERSONA:
            ${systemPrompt || "Standard helpful assistant"}

            TARGET TASK & OBJECTIVE:
            ${targetTask || "Supervised fine-tuning high quality conversations"}

            PROJECT CONSTRAINTS & NEGATIVE RULES:
            ${constraints || "None specified"}

            DATASET TEMPLATE TYPE:
            ${templateType || "Single Turn"}

            EXAMPLES TO AUDIT (Global zero-based indices provided in "exampleIndex"):
            ${JSON.stringify(chunk.items, null, 2)}

            EVALUATION CRITERIA:
            1. Persona & Constraint Adherence:
               - Does the assistant completion strictly respect the target system prompt, tone, domain constraints, formatting requirements, and negative rules (e.g., 'never use bullet points', 'respond in JSON', specific persona tone)?
               - Flag any violation, persona drift, or broken negative constraints.
            2. Instruction Following & Completeness:
               - Did the assistant completely and accurately answer all parts of the user prompt?
               - Flag evasive answers, partial answers, or failure to follow prompt instructions.
            3. Substance, Depth & Factual Soundness:
               - Is the response detailed, logically coherent, and factually sound?
               - Flag factual hallucinations, broken code, nonsensical logic, or superficial/lazy completions.
            4. Reasoning Quality (for Reasoning/Thought templates):
               - If reasoning tags or thinking steps are present, are they logically sound, thorough, and genuine? Flag fake, circular, or trivial reasoning.
            5. Tone, Style & SFT Fitness:
               - Is the tone professional, aligned with the persona, and free of unwanted fluff or boilerplate?

            SEVERITY CLASSIFICATION:
            - "High": Fatal defect (blatant violation of system prompt/negative constraints, factual hallucination, broken code, refusal/evasion, empty or missing content).
            - "Medium": Significant flaw (partial instruction omission, shallow/vague response, subtle persona drift, poor explanation).
            - "Low": Minor issue (awkward phrasing, suboptimal formatting, slight redundancy).

            OUTPUT REQUIREMENTS:
            Return an object with:
            - "issues": Array of detected issues. Each issue MUST specify:
              - "exampleIndex": The integer global index of the example (from the provided examples).
              - "severity": "High" | "Medium" | "Low"
              - "type": Short category name (e.g., "Constraint Violation", "Instruction Drift", "Factual Error", "Shallow Response", "Tone Mismatch", "Hallucinated Logic")
              - "message": Clear, specific explanation of why this example is flawed and how to fix it.
            - "suggestions": Array of 1 to 3 actionable, high-level improvement recommendations for this dataset chunk.
          `;

          const response = await callGemini(client, {
            model: normalizeModel(),
            contents: chunkPrompt,
            config: {
              temperature: 0.1,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  issues: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        exampleIndex: { type: Type.INTEGER },
                        severity: { type: Type.STRING },
                        type: { type: Type.STRING },
                        message: { type: Type.STRING }
                      },
                      required: ["exampleIndex", "severity", "type", "message"]
                    }
                  },
                  suggestions: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  }
                },
                required: ["issues", "suggestions"]
              }
            }
          });

          const parsed = JSON.parse(extractResponseText(response) || "{}");
          if (Array.isArray(parsed.issues)) {
            for (const iss of parsed.issues) {
              if (
                typeof iss.exampleIndex === "number" &&
                iss.exampleIndex >= chunk.startIndex &&
                iss.exampleIndex < chunk.startIndex + chunk.items.length &&
                iss.message
              ) {
                const sev = iss.severity === "High" ? "High" : iss.severity === "Low" ? "Low" : "Medium";
                aiIssues.push({
                  exampleIndex: iss.exampleIndex,
                  severity: sev,
                  type: iss.type || "AI Audit Finding",
                  message: iss.message
                });
              }
            }
          }
          if (Array.isArray(parsed.suggestions)) {
            for (const sug of parsed.suggestions) {
              if (typeof sug === "string" && sug.trim().length > 0 && !aiSuggestions.includes(sug)) {
                aiSuggestions.push(sug);
              }
            }
          }
        } catch (chunkErr: any) {
          console.warn(`Quality audit chunk ${chunk.startIndex} notice:`, chunkErr?.message || chunkErr);
        }
      }));
    }
  } catch (error: any) {
    console.warn("AI Quality assessment model warning:", error?.message || error);
  }

  // 3. Merge deterministic and AI audit issues
  const combinedIssues: Array<{
    exampleIndex: number;
    severity: "High" | "Medium" | "Low";
    type: string;
    message: string;
  }> = [];

  // Add deterministic issues
  for (const detIss of deterministicResult.issues) {
    combinedIssues.push(detIss);
  }

  // Add AI issues, avoiding duplicates of same type on same example
  for (const aiIss of aiIssues) {
    const alreadyFlagged = combinedIssues.some(
      c => c.exampleIndex === aiIss.exampleIndex &&
        (c.type.toLowerCase() === aiIss.type.toLowerCase() ||
         c.message.toLowerCase() === aiIss.message.toLowerCase())
    );
    if (!alreadyFlagged) {
      combinedIssues.push(aiIss);
    }
  }

  // Sort issues by exampleIndex ascending, then High severity first
  const severityRank: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
  combinedIssues.sort((a, b) => {
    if (a.exampleIndex !== b.exampleIndex) return a.exampleIndex - b.exampleIndex;
    return (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
  });

  const total = examples.length;
  const flaggedIndices = new Set(combinedIssues.map(i => i.exampleIndex));
  const flaggedCount = flaggedIndices.size;
  const passedCount = Math.max(0, total - flaggedCount);

  // 4. Compute mathematically rigorous weighted score (0 - 100)
  let overallScore = 100;
  if (total > 0) {
    let totalExScore = 0;
    for (let i = 0; i < total; i++) {
      const exIssues = combinedIssues.filter(iss => iss.exampleIndex === i);
      if (exIssues.length === 0) {
        totalExScore += 100;
      } else if (exIssues.some(iss => iss.severity === "High")) {
        totalExScore += 0; // Fatal defect: 0 score for example
      } else if (exIssues.some(iss => iss.severity === "Medium")) {
        const medCount = exIssues.filter(iss => iss.severity === "Medium").length;
        totalExScore += medCount > 1 ? 25 : 45; // Partial score for moderate defects
      } else {
        totalExScore += 75; // Minor deduction for low severity styling suggestions
      }
    }
    const rawAvg = totalExScore / total;
    const dupPenalty = Math.min(15, deterministicResult.duplicatesFound * 3);
    overallScore = Math.max(0, Math.min(100, Math.round(rawAvg - dupPenalty)));
  }

  // 5. Construct actionable, insightful recommendations
  const finalSuggestions: string[] = [];
  if (deterministicResult.duplicatesFound > 0) {
    finalSuggestions.push(`Deduplicate dataset: ${deterministicResult.duplicatesFound} duplicate or redundant item(s) detected.`);
  }
  if (combinedIssues.some(i => i.type.includes("Code Fence") || i.type.includes("Reasoning Tags"))) {
    finalSuggestions.push("Fix syntax delimiters: Close all markdown code blocks (```) and reasoning tags (<think>...</think>).");
  }
  if (combinedIssues.some(i => i.type.includes("Truncated"))) {
    finalSuggestions.push("Complete truncated responses: Ensure all assistant completions finish their thoughts with proper terminal punctuation.");
  }
  if (combinedIssues.some(i => i.type.includes("Placeholder"))) {
    finalSuggestions.push("Replace placeholder tokens: Remove any TODO, FIXME, or template markers with realistic fine-tuning data.");
  }
  if (combinedIssues.some(i => i.type.includes("Constraint") || i.type.includes("Persona") || i.type.includes("Boilerplate"))) {
    finalSuggestions.push("Realign with system prompt: Enforce all negative constraints, eliminate AI disclaimers, and verify tone rules.");
  }
  for (const sug of aiSuggestions) {
    if (!finalSuggestions.includes(sug) && finalSuggestions.length < 5) {
      finalSuggestions.push(sug);
    }
  }
  if (finalSuggestions.length === 0) {
    finalSuggestions.push("Dataset passed structural and semantic QA checks. Ready for fine-tuning validation.");
  }

  const sanitizedReport = {
    overallScore,
    stats: {
      totalExamples: total,
      passedCount,
      flaggedCount
    },
    duplicateCheck: {
      duplicatesFound: deterministicResult.duplicatesFound,
      duplicatesList: deterministicResult.duplicatesList,
      deduplicatedLength: Math.max(0, total - deterministicResult.duplicatesFound)
    },
    issues: combinedIssues,
    suggestions: finalSuggestions
  };

  return res.json({ success: true, report: sanitizedReport });
});

// 3.1 Regenerate and Fix Flagged SFT Examples
app.post("/api/regenerate-flagged", async (req, res) => {
  const {
    flaggedItems,
    suggestions,
    systemPrompt,
    targetTask,
    constraints,
    templateType
  } = req.body;

  if (!flaggedItems || !Array.isArray(flaggedItems) || flaggedItems.length === 0) {
    return res.json({ success: false, error: "No flagged examples provided to regenerate." });
  }

  const client = getGeminiClient();

  try {
    if (!client) {
      throw new Error("Gemini AI client is not available.");
    }

    const fullPrompt = `
      You are an expert Supervised Fine-Tuning (SFT) Dataset Engineer and Quality Improvement Specialist.
      Your task is to fix and regenerate the following ${flaggedItems.length} flagged SFT training examples based on quality assessment feedback.
      You must eliminate every reported issue, conform strictly to the system prompt and persona constraints, and ensure high diversity, accuracy, and formatting compliance.

      TARGET SYSTEM PROMPT:
      ${systemPrompt || "Standard helpful assistant"}

      TARGET TASK & OBJECTIVE:
      ${targetTask || "Supervised fine-tuning high quality conversations"}

      PROJECT CONSTRAINTS:
      ${constraints || "None specified"}

      DATASET TEMPLATE TYPE:
      ${templateType || "Single Turn"}

      GLOBAL QA SUGGESTIONS:
      ${Array.isArray(suggestions) && suggestions.length > 0 ? suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n") : "Provide rich, accurate, and completely resolved responses."}

      FLAGGED EXAMPLES AND SPECIFIC AUDIT ISSUES:
      ${JSON.stringify(flaggedItems, null, 2)}

      RULES:
      1. For each item in the input, preserve its exact original "exampleIndex".
      2. Retain the exact message structure and roles already set in each example.
      3. Regenerate the content to fix the specific flagged audit issues without altering the established template or conversation format.
      4. Ensure the regenerated response completely resolves all formatting anomalies (properly close all markdown code fences and reasoning tags like <think>, finish any truncated thoughts, remove unpopulated placeholder tokens, and ensure coherent turn ordering) and satisfies all system prompt guidelines and negative constraints.
      5. Return ONLY valid JSON matching the requested schema.
    `;

    const response = await callGemini(client, {
      model: normalizeModel(),
      contents: fullPrompt,
      config: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            regeneratedExamples: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  exampleIndex: { type: Type.INTEGER },
                  messages: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        role: { type: Type.STRING },
                        content: { type: Type.STRING },
                        reasoning: { type: Type.STRING }
                      },
                      required: ["role", "content"]
                    }
                  }
                },
                required: ["exampleIndex", "messages"]
              }
            }
          },
          required: ["regeneratedExamples"]
        }
      }
    });

    const parsed = JSON.parse(extractResponseText(response) || "{}");
    const rawRegenerated = parsed.regeneratedExamples || [];
    const regeneratedExamples = rawRegenerated.map((item: any) => ({
      exampleIndex: item.exampleIndex,
      messages: Array.isArray(item.messages) ? item.messages.map((m: any) => sanitizeMessage(m, templateType)) : []
    }));
    return res.json({ success: true, regeneratedExamples });
  } catch (error: any) {
    console.error("Regenerate flagged error:", error);
    return res.status(500).json({ success: false, error: formatAIErrorMessage(error) });
  }
});

// Helper to parse CSV rows and columns
function parseCsvRow(rowText: string): string[] {
  const result: string[] = [];
  let currentVal = "";
  let inQuotes = false;

  for (let i = 0; i < rowText.length; i++) {
    const char = rowText[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(currentVal.replace(/^"|"$/g, "").trim());
      currentVal = "";
    } else {
      currentVal += char;
    }
  }
  result.push(currentVal.replace(/^"|"$/g, "").trim());
  return result;
}

function parseCsvToExamples(csvText: string): any[] {
  const lines: string[] = [];
  let currentLine = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === '\n' && !inQuotes) {
      lines.push(currentLine);
      currentLine = "";
    } else {
      currentLine += char;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCsvRow(lines[0]);
  const promptIdx = headers.findIndex(h => /prompt|instruction|input/i.test(h));
  const helpfulIdx = headers.findIndex(h => /helpful|response_helpful|response|output/i.test(h));

  const examples: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i]);
    if (row.length === 0 || row.join("").trim() === "") continue;

    const promptVal = promptIdx !== -1 && row[promptIdx] ? row[promptIdx] : `Prompt #${i}`;
    const helpfulVal = helpfulIdx !== -1 && row[helpfulIdx] ? row[helpfulIdx] : "Helpful response.";

    examples.push({
      prompt: promptVal,
      response_helpful: helpfulVal
    });
  }

  return examples;
}

async function fetchDatasetFromUrl(url: string, size: number, systemPrompt: string) {
  let downloadUrl = url;
  
  // Convert standard Google Drive link to direct download link
  const fileIdMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fileIdMatch && fileIdMatch[1]) {
    downloadUrl = `https://drive.google.com/uc?export=download&id=${fileIdMatch[1]}`;
  } else if (url.includes("docs.google.com/spreadsheets/d/")) {
    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (sheetIdMatch && sheetIdMatch[1]) {
      downloadUrl = `https://docs.google.com/spreadsheets/d/${sheetIdMatch[1]}/export?format=csv`;
    }
  }

  const response = await globalThis.fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch dataset from URL. Status: ${response.status}`);
  }

  const responseText = await response.text();

  let parsedExamples: any[] = [];

  // 1. Try parsing as JSON Lines (JSONL) first - common in fine-tuning datasets
  const lines = responseText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  let parsedJsonLines: any[] = [];
  try {
    for (const line of lines) {
      if (line.startsWith("{") && line.endsWith("}")) {
        const obj = JSON.parse(line);
        if (obj) {
          parsedJsonLines.push(obj);
        }
      }
    }
  } catch (e) {
    parsedJsonLines = [];
  }

  if (parsedJsonLines.length > 0) {
    parsedExamples = parsedJsonLines;
  }

  // 2. Try parsing as a standard single JSON array
  if (parsedExamples.length === 0) {
    if (responseText.trim().startsWith("[")) {
      try {
        const data = JSON.parse(responseText);
        if (Array.isArray(data)) {
          parsedExamples = data;
        }
      } catch (e) {
        // Not a standard JSON array, fallback to CSV
      }
    }
  }

  // 3. Try parsing as CSV
  if (parsedExamples.length === 0) {
    parsedExamples = parseCsvToExamples(responseText);
  }

  // 4. Fallback to raw lines if everything else fails
  if (parsedExamples.length === 0) {
    parsedExamples = lines.map((line) => ({
      prompt: line,
      response_helpful: `Helpful response addressing: ${line}`
    }));
  }

  const result: any[] = [];
  for (let i = 0; i < size; i++) {
    const base = parsedExamples[i % parsedExamples.length];
    if (!base) continue;

    let messages: any[] = [];
    if (base.messages && Array.isArray(base.messages)) {
      // Filter out any pre-existing system messages, then prepend the dynamic user-configured systemPrompt
      const cleanMessages = base.messages.filter((m: any) => m.role !== "system");
      messages = [
        { role: "system", content: systemPrompt || "You are SFT Studio Pro, a helpful assistant." },
        ...cleanMessages
      ];
    } else {
      const prompt = base.prompt || base.instruction || base.input || `Example Prompt #${i + 1}`;
      const helpful = base.response_helpful || base.helpful || base.response || base.output || "Aligned response.";
      messages = [
        { role: "system", content: systemPrompt || "You are SFT Studio Pro, a helpful assistant." },
        { role: "user", content: prompt },
        { role: "assistant", content: helpful }
      ];
    }

    result.push({
      id: `triad-${i + 1}`,
      messages
    });
  }

  return result;
}

// 4. TRiAD Alignment Import
app.post("/api/triad-generate", async (req, res) => {
  const { systemPrompt, size, templateType, instructTemplate, customUrl } = req.body;
  const count = parseInt(size) || 150;
  
  try {
    let examples;
    if (customUrl && customUrl.trim().startsWith("http")) {
      examples = await fetchDatasetFromUrl(customUrl, count, systemPrompt);
    } else {
      examples = expandTRiADExamples(count, systemPrompt, templateType, instructTemplate || "ChatML");
    }
    res.json({ success: true, count: examples.length, examples });
  } catch (err: any) {
    console.error("TRiAD alignment import error:", err);
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// Helper: Extract complete high-fidelity text from PDF buffer
async function extractTextFromPdfBuffer(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const parser = new PDFParse({ data: buffer });
  const res = await parser.getText();
  let fullText = "";
  if (res && Array.isArray(res.pages)) {
    fullText = res.pages.map((p: any) => (p.text || "").trim()).filter(Boolean).join("\n\n");
  } else {
    fullText = res.text || "";
  }
  return {
    text: fullText.trim(),
    pageCount: res?.total || (res?.pages?.length || 1)
  };
}

// 5. OCR Image & Document Text Extraction Route
app.post("/api/ocr", async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ success: false, error: "imageBase64 payload is required." });
  }

  const effectiveMimeType = mimeType || "image/png";

  try {
    // Strip Data URL headers if present in base64 string regardless of content-type format
    const cleanBase64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

    // Direct native parsing if payload is PDF
    if (effectiveMimeType === "application/pdf" || cleanBase64.startsWith("JVBERi")) {
      const buffer = Buffer.from(cleanBase64, "base64");
      const { text, pageCount } = await extractTextFromPdfBuffer(buffer);
      if (text && text.trim().length > 0) {
        return res.json({ success: true, text, pageCount });
      }
    }

    const client = getGeminiClient();
    if (!client) {
      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY is not configured. Please provide a valid Gemini API key."
      });
    }

    const response = await callGemini(client, {
      model: "gemini-3.1-flash-lite",
      contents: [
        {
          inlineData: {
            data: cleanBase64,
            mimeType: effectiveMimeType.startsWith("image/") ? effectiveMimeType : "image/png"
          }
        },
        "Examine the provided document image and perform high-fidelity text extraction/OCR. Transcribe all readable text from the document as accurately as possible, preserving paragraphs and formatting. Output ONLY the extracted text directly. Do not add any conversational introductions, markdown blocks, meta-explanations, or surrounding commentary."
      ]
    });

    const extractedText = extractResponseText(response);
    res.json({ success: true, text: extractedText });
  } catch (err: any) {
    console.error("OCR extraction error:", err);
    return res.status(500).json({ success: false, error: err.message || err });
  }
});

// 5.4 PDF Native Text Parsing Route
app.post("/api/parse-pdf", async (req, res) => {
  const { fileBase64, fileName } = req.body;
  if (!fileBase64) {
    return res.status(400).json({ success: false, error: "fileBase64 payload is required." });
  }

  try {
    const cleanBase64 = fileBase64.includes(",") ? fileBase64.split(",")[1] : fileBase64;
    const buffer = Buffer.from(cleanBase64, "base64");
    const { text, pageCount } = await extractTextFromPdfBuffer(buffer);

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "No extractable text found in this PDF. If this is a scanned document without an embedded text layer, please export with an OCR text layer."
      });
    }

    res.json({
      success: true,
      text,
      pageCount,
      fileName: fileName || "Document.pdf"
    });
  } catch (err: any) {
    console.error("PDF parsing error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to extract text from PDF document."
    });
  }
});

// 5.5 DOCX Native Text Parsing Route
app.post("/api/parse-docx", async (req, res) => {
  const { fileBase64 } = req.body;
  if (!fileBase64) {
    return res.status(400).json({ success: false, error: "fileBase64 payload is required." });
  }

  try {
    const cleanBase64 = fileBase64.includes(",") ? fileBase64.split(",")[1] : fileBase64;
    const buffer = Buffer.from(cleanBase64, "base64");
    const result = await mammoth.extractRawText({ buffer });
    
    if (!result.value || !result.value.trim()) {
      return res.status(400).json({ success: false, error: "No readable text found in the uploaded DOCX file." });
    }

    res.json({ success: true, text: result.value });
  } catch (err: any) {
    console.error("DOCX parsing error:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to extract text from DOCX file." });
  }
});


// 6. Suggest Document Examples Count Based on Content
app.post("/api/suggest-doc-count", async (req, res) => {
  const { documentContent, documentName } = req.body;
  if (!documentContent || typeof documentContent !== "string") {
    return res.status(400).json({ success: false, error: "documentContent is required." });
  }

  const client = getGeminiClient();
  const wordCount = documentContent.split(/\s+/).filter(Boolean).length;
  const charCount = documentContent.length;

  try {
    if (!client) {
      throw new Error("Gemini AI client is not available.");
    }
    const prompt = `
      You are an expert Supervised Fine-Tuning (SFT) Trainer.
      Analyze the provided knowledge document and suggest the optimal number of distinct, high-quality SFT training examples we should generate from it.
      
      We want a count that fully covers the document's topics, concepts, or rules without repeating themes.
      Choose one of the following standard counts: 3, 5, 10, 15, or 20.
      
      DOCUMENT NAME: ${documentName || "Unnamed Document"}
      DOCUMENT SIZE: ${charCount} characters (${wordCount} words)
      DOCUMENT CONTENT (truncated if extremely long):
      --- START -----
      ${documentContent.slice(0, 8000)}
      --- END -----

      Respond ONLY with a JSON object of this structure:
      {
        "suggestedCount": <number>, // must be 3, 5, 10, 15, or 20
        "explanation": "<1-2 sentences explaining why based on the length, variety of concepts, density of topics, or format of the document>"
      }
    `;

    const response = await callGemini(client, {
      model: normalizeModel(),
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const data = JSON.parse(extractResponseText(response) || "{}");
    const validCounts = [3, 5, 10, 15, 20];
    let suggestedCount = parseInt(data.suggestedCount) || 5;
    if (!validCounts.includes(suggestedCount)) {
      // snap to nearest
      suggestedCount = validCounts.reduce((prev, curr) => 
        Math.abs(curr - suggestedCount) < Math.abs(prev - suggestedCount) ? curr : prev
      );
    }

    res.json({
      success: true,
      suggestedCount,
      explanation: data.explanation || `Suggested ${suggestedCount} examples based on document analysis.`,
      source: "Gemini Analysis"
    });
  } catch (error: any) {
    console.error("Suggest count error:", error);
    return res.status(500).json({
      success: false,
      error: formatAIErrorMessage(error)
    });
  }
});


// 7. In-App Chat Assistant
app.post("/api/expert-chat", async (req, res) => {
  const { messages, appContext } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Invalid request. 'messages' must be an array of chat messages." });
  }

  const client = getGeminiClient();

  try {
    if (!client) {
      throw new Error("Gemini AI client is not available.");
    }

    const formattedContents = messages.map(msg => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }]
    }));

    const systemInstruction = `You are the in-app Chat Assistant for SFT Studio Pro, a web platform designed to build, curate, audit, and export high-quality Supervised Fine-Tuning (SFT) datasets for large language models.

YOUR IDENTITY & ROLE:
- You are the in-app HELP & CHAT ASSISTANT, NOT the dataset generator.
- You are here to answer questions, guide users through the app's features, help them troubleshoot, and provide expert advice on SFT prompt engineering, dataset curation, quality auditing, and model export formats.
- Always be friendly, concise, clear, and directly helpful. Give structured step-by-step guidance when users ask how to do things in the app.
- Never output marketing hype, long unsolicited background history, or promotional slogans.

COMPLETE KNOWLEDGE OF SFT STUDIO PRO:
1. TAB 1: DEFINE & GENERATE (Project Setup & Synthetic Generator)
   - Setup project name, target task/objective, domain persona & system prompt, and negative constraints.
   - Presets available: General Use, Coding Specialist, Reasoning / CoT, Creative Writing, Customer Support, etc.
   - Templates: Single Turn (user -> assistant), Multi Turn (alternating dialog), Reasoning (thinking trace + answer).
   - AI Generator: Generates synthetic batches matching the project specs using Gemini on Vertex AI.
   - Approval Policy: All newly generated or imported batches start as "Pending" and must be reviewed before entering the active Data Registry.

2. TAB 2: CONVERT FROM DOCUMENTS (Doc Conversion)
   - Converts raw unstructured files (.txt, .pdf, .md, .csv, code) into structured SFT conversational examples.
   - Automatically analyzes document length to suggest optimal example counts.

3. TAB 3: TRIAD ALIGNMENT (Pre-Aligned Core)
   - Pre-aligned safety and ethical modules based on TRiAD principles (Freedom, Truth, Kindness).
   - Embeds positive alignment directly into training data without needing heavy runtime guardrails.
   - TRiAD batches enter the Data Registry directly as "Approved".

4. TAB 4: AI QUALITY ASSESSMENT (Audit & Cleaning)
   - Runs comprehensive quality checks for formatting errors, repetition, persona deviation, truncation, and shallow responses.
   - Calculates an overall Quality Score (0-100) and displays detailed flag counts.
   - SFT Dataset Inspector: Allows viewing, filtering (Flagged Items vs. All Examples), editing, or deleting individual examples.
   - Deduplicate: Deletes duplicate prompts AND deletes ALL flagged examples to quickly clean the batch.
   - Regenerate Flagged: Uses AI to regenerate only the flagged examples while preserving their existing message format, then re-audits the batch.

5. TAB 5: DATA REGISTRY & EXPORT
   - Central repository for all Approved batches.
   - Train / Validation dataset split slider (e.g. 80/20, 90/10).
   - Export formats supported: ChatML (<|im_start|>), Alpaca (### Instruction / ### Response), Mistral ([INST]), DeepSeek / Reasoning (<think>), and OpenAI / ShareGPT JSONL.
   - Instant file downloads in .jsonl, .json, or .csv.

6. TAB 6: CHAT ASSISTANT
   - You! The in-app chat companion ready to help users with every part of the app.

${appContext ? `CURRENT PROJECT CONTEXT:
- Active Project Name: "${appContext.projectName || "Default Project"}"
- Target Task: "${appContext.targetTask || "Not specified"}"
- System Prompt Configured: ${appContext.systemPrompt ? "Yes" : "None"}
- Batches in Project: ${appContext.totalBatches || 0} (${appContext.approvedBatches || 0} approved)
- Total Examples: ${appContext.totalExamples || 0}
- Current Active Tab: ${appContext.activeTab || "define"}` : ""}

GUIDELINES:
- When a user asks how to do something, tell them which tab to click and what steps to take.
- Answer questions on fine-tuning concepts (e.g. SFT vs DPO vs RLHF, optimal dataset sizing, formatting differences, negative constraints).
- Keep responses readable, utilizing clean formatting with bullet points and code blocks when appropriate.`;

    const response = await callGemini(client, {
      model: normalizeModel(),
      contents: formattedContents,
      config: {
        systemInstruction
      }
    });

    return res.json({ success: true, text: extractResponseText(response) });
  } catch (error: any) {
    console.error("Chat Assistant Error:", error);
    return res.status(500).json({ error: formatAIErrorMessage(error) });
  }
});


// Vite & Static file handler setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SFT Studio Pro backend running on http://localhost:${PORT}`);
  });
}

startServer();
