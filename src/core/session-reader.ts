import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Task } from "../models/types";
import { CursorHistory } from "./cursor-history";
import { VSCodeHistory } from "./vscode-history";
import { PromptRailDB } from "./promptrail-db";

export interface EditRecord {
  file: string;
  oldString: string;
  newString: string;
}

export interface WriteRecord {
  file: string;
  content: string;
}

export interface TaskWithEdits extends Task {
  edits?: EditRecord[];
  writes?: WriteRecord[];
  promptIndex?: number;
  /** Files the AI actually edited per toolFormerData (Cursor only). Used as whitelist. */
  toolEditedFiles?: Set<string>;
  /** All files the AI touched in this session (from originalFileStates + newlyCreatedFiles). */
  sessionEditedFiles?: Set<string>;
  /** Hook-sourced generationId (Cursor hooks). Used to look up responses. */
  generationId?: string;
}

/**
 * Claude Code injects internal messages into JSONL that are not real
 * user prompts: slash commands (/plugin, /help), command output, meta
 * caveats, and task notifications. Returns true if the content should
 * be skipped during prompt extraction.
 */
export function isClaudeInternalMessage(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<local-command-stdout>") ||
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("<local-command-stderr>") ||
    trimmed.startsWith("<task-notification>")
  );
}

/**
 * Resolves toolEditedFiles for a prompt in the SQLite-first path.
 * When per-prompt file data is available for the session (at least one
 * prompt has file edits in toolFormerData), an empty Set means "this
 * prompt edited no files" (authoritative). Without per-prompt data,
 * an empty Set is ambiguous, so we return undefined to trigger the
 * session-level fallback.
 */
export function resolveToolEditedFiles(
  files: Set<string>,
  sessionHasPerPromptData: boolean
): Set<string> | undefined {
  if (sessionHasPerPromptData) return files;
  return files.size > 0 ? files : undefined;
}

/**
 * Filters watcher-detected files through the appropriate whitelist.
 * When toolEditedFiles is defined (even empty), it is authoritative —
 * an empty Set means "this prompt edited no files" (not "unknown").
 * Only falls back to sessionEditedFiles when toolEditedFiles is undefined.
 */
export function applyFileWhitelist(
  files: string[],
  toolEditedFiles: Set<string> | undefined,
  sessionEditedFiles: Set<string> | undefined
): string[] {
  if (toolEditedFiles !== undefined) {
    return files.filter((f) => toolEditedFiles.has(f));
  }
  if (sessionEditedFiles && sessionEditedFiles.size > 0) {
    return files.filter((f) => sessionEditedFiles.has(f));
  }
  return files;
}

/**
 * Spreads timestamps across a session range when they're missing or collapsed.
 * Handles: undefined raw (all missing), all-same values (Cursor resets on
 * session switch), and individual duplicates.
 */
export function deduplicateTimestamps(
  raw: number[] | undefined,
  promptCount: number,
  fallbackStart: number,
  fallbackEnd: number
): number[] {
  let useRaw = raw !== undefined && raw.length > 0;
  if (useRaw) {
    const nonZero = raw!.filter((t) => t > 0);
    if (nonZero.length > 1) {
      const allSame = nonZero.every((t) => t === nonZero[0]);
      if (allSame) useRaw = false;
    }
  }

  const result: number[] = [];
  const span = Math.max(fallbackEnd - fallbackStart, promptCount);

  for (let i = 0; i < promptCount; i++) {
    const ts =
      useRaw && raw![i] && raw![i] > 0
        ? raw![i]
        : fallbackStart + (span * i) / Math.max(promptCount - 1, 1);
    result.push(ts);
  }

  for (let i = 1; i < result.length; i++) {
    if (result[i] <= result[i - 1]) {
      result[i] = result[i - 1] + 1;
    }
  }

  return result;
}

export class SessionReader {
  private workspaceRoot: string;
  private cursorHistory: CursorHistory;
  private vscodeHistory: VSCodeHistory;
  private promptrailDb: PromptRailDB;
  private cachedTasks: TaskWithEdits[] = [];
  private lastReadAt = 0;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.promptrailDb = new PromptRailDB(workspaceRoot);
    this.cursorHistory = new CursorHistory(workspaceRoot, this.promptrailDb);
    this.vscodeHistory = new VSCodeHistory(workspaceRoot);
  }

  readAllTasks(): TaskWithEdits[] {
    const now = Date.now();
    if (now - this.lastReadAt < 2000 && this.cachedTasks.length > 0) {
      return this.cachedTasks;
    }
    this.lastReadAt = now;

    const claudeTasks = this.readClaudeSessions();
    const cursorTasks = this.readCursorSessions();
    const vscodeTasks = this.readVSCodeSessions();

    this.cachedTasks = [...claudeTasks, ...cursorTasks, ...vscodeTasks].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    return this.cachedTasks;
  }

  getPromptRailDB(): PromptRailDB {
    return this.promptrailDb;
  }

  getCursorHistory(): CursorHistory {
    return this.cursorHistory;
  }

  getVSCodeHistory(): VSCodeHistory {
    return this.vscodeHistory;
  }

  private toRelPath(absPath: string): string {
    if (absPath.startsWith(this.workspaceRoot + "/")) {
      return absPath.slice(this.workspaceRoot.length + 1);
    }
    return absPath;
  }

  getClaudeResponse(sessionId: string, promptIndex: number): string | undefined {
    const dir = this.getClaudeProjectDir();
    if (!dir) return undefined;

    const filePath = path.join(dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) return undefined;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      let promptIdx = -1;
      let collecting = false;
      const parts: string[] = [];

      for (const line of lines) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.type === "user") {
          const text = this.extractClaudePrompt(obj);
          if (!text) continue;
          if (collecting) break;
          promptIdx++;
          if (promptIdx === promptIndex) collecting = true;
        } else if (obj.type === "assistant" && collecting) {
          const content = obj.message?.content;
          if (!Array.isArray(content)) continue;
          for (const c of content) {
            if (c?.type === "text" && c.text) {
              parts.push(c.text);
            } else if (c?.type === "tool_use") {
              const name = c.name || "";
              const inp = c.input || {};
              if (inp.file_path) {
                parts.push(`**[${name}]** ${inp.file_path}`);
              } else if (inp.command) {
                parts.push(`**[${name}]** \`${inp.command}\``);
              } else {
                parts.push(`**[${name}]**`);
              }
            }
          }
        }
      }

      if (parts.length === 0) return undefined;
      return parts.join("\n\n");
    } catch {
      return undefined;
    }
  }

  getHookResponse(
    conversationId: string,
    generationId: string
  ): string | undefined {
    return this.promptrailDb.getHookResponseForGeneration(
      conversationId,
      generationId
    );
  }

  /**
   * Looks up the generationId for the Nth hook prompt in a conversation.
   */
  getHookGenerationId(
    conversationId: string,
    promptIndex: number
  ): string | undefined {
    const prompts = this.promptrailDb.getHookPrompts(conversationId);
    if (promptIndex < prompts.length) return prompts[promptIndex].generationId;
    return undefined;
  }

  // ── Claude Code ──────────────────────────────────────────

  private getClaudeProjectDir(): string | undefined {
    const raw = this.workspaceRoot;
    const encoded = raw.replace(/\//g, "-");
    const base = path.join(os.homedir(), ".claude", "projects");
    for (const variant of [encoded, encoded.replace(/^-/, "")]) {
      const dir = path.join(base, variant);
      if (fs.existsSync(dir)) return dir;
    }
    return undefined;
  }

  private readClaudeSessions(): TaskWithEdits[] {
    const dir = this.getClaudeProjectDir();
    if (!dir) return [];

    const tasks: TaskWithEdits[] = [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      try {
        tasks.push(
          ...this.parseClaudeSession(
            path.join(dir, file),
            file.replace(".jsonl", "")
          )
        );
      } catch {
        continue;
      }
    }
    return tasks;
  }

  private parseClaudeSession(
    filePath: string,
    sessionId: string
  ): TaskWithEdits[] {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const tasks: TaskWithEdits[] = [];
    let cur: TaskWithEdits | undefined;
    let taskIdx = 0;

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type === "user") {
        const promptText = this.extractClaudePrompt(obj);
        if (!promptText) continue;

        if (cur) {
          cur.status = "completed";
          tasks.push(cur);
        }

        cur = {
          id: `cc-${sessionId.slice(0, 8)}-${taskIdx++}`,
          prompt: promptText.slice(0, 500),
          createdAt: obj.timestamp
            ? new Date(obj.timestamp).getTime()
            : Date.now() - (lines.length - taskIdx) * 30000,
          status: "active",
          filesChanged: [],
          source: "claude",
          sessionId,
          edits: [],
          writes: [],
        };
      } else if (obj.type === "assistant" && cur) {
        const content = obj.message?.content;
        if (!Array.isArray(content)) continue;

        for (const c of content) {
          if (c?.type !== "tool_use") continue;
          const name: string = c.name || "";
          const inp = c.input || {};

          if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name))
            continue;

          const fp = inp.file_path || "";
          if (!fp) continue;
          const rel = this.toRelPath(fp);

          if (!cur.filesChanged.includes(rel)) {
            cur.filesChanged.push(rel);
          }

          if (
            name === "Edit" &&
            inp.old_string != null &&
            inp.new_string != null
          ) {
            cur.edits!.push({
              file: rel,
              oldString: inp.old_string,
              newString: inp.new_string,
            });
          } else if (name === "Write" && inp.content != null) {
            cur.writes!.push({ file: rel, content: inp.content });
          }
        }
      }
    }

    if (cur) {
      cur.status = "completed";
      tasks.push(cur);
    }
    return tasks;
  }

  private extractClaudePrompt(obj: any): string {
    if (obj.isMeta) return "";

    const msg = obj.message || {};
    const content = typeof msg === "object" ? msg.content : "";

    if (typeof content === "string" && content.length > 2) {
      if (isClaudeInternalMessage(content)) return "";
      return content;
    }

    if (Array.isArray(content)) {
      for (const c of content) {
        if (
          c?.type === "text" &&
          typeof c.text === "string" &&
          c.text.length > 2
        ) {
          if (isClaudeInternalMessage(c.text)) return "";
          return c.text;
        }
        if (c?.type === "tool_result") return "";
      }
    }
    return "";
  }

  // ── Cursor ───────────────────────────────────────────────

  private getCursorTranscriptsDir(): string | undefined {
    const encoded = this.workspaceRoot.replace(/\//g, "-").replace(/^-/, "");
    const base = path.join(os.homedir(), ".cursor", "projects");

    const direct = path.join(base, encoded, "agent-transcripts");
    if (fs.existsSync(direct)) return direct;

    if (!fs.existsSync(base)) return undefined;

    for (const entry of fs.readdirSync(base)) {
      if (entry.toLowerCase() === encoded.toLowerCase()) {
        const dir = path.join(base, entry, "agent-transcripts");
        if (fs.existsSync(dir)) return dir;
      }
    }

    return undefined;
  }

  private readCursorSessions(): TaskWithEdits[] {
    const tasks: TaskWithEdits[] = [];
    const processedConversations = new Set<string>();

    // JSONL-based discovery (existing path)
    const dir = this.getCursorTranscriptsDir();
    if (dir) {
      for (const entry of fs.readdirSync(dir)) {
        const transcriptDir = path.join(dir, entry);
        try {
          if (!fs.statSync(transcriptDir).isDirectory()) continue;
        } catch {
          continue;
        }

        const jsonlFile = path.join(transcriptDir, `${entry}.jsonl`);
        if (!fs.existsSync(jsonlFile)) continue;

        const composerId = entry;
        processedConversations.add(composerId);

        // Prefer hook data when available
        const hookPrompts = this.promptrailDb.getHookPrompts(composerId);
        if (hookPrompts.length > 0) {
          try {
            tasks.push(...this.parseCursorFromHooks(composerId, hookPrompts));
          } catch {
            // Fall through to existing parsing on error
            const session = this.cursorHistory.getComposerSession(composerId);
            try {
              tasks.push(
                ...this.parseCursorSession(jsonlFile, composerId, session)
              );
            } catch {}
          }
          continue;
        }

        const session = this.cursorHistory.getComposerSession(composerId);
        try {
          tasks.push(
            ...this.parseCursorSession(jsonlFile, composerId, session)
          );
        } catch {
          continue;
        }
      }
    }

    // Hook-only sessions (conversations in hook tables not in JSONL)
    const hookConversationIds = this.promptrailDb.getHookConversationIds();
    for (const convId of hookConversationIds) {
      if (processedConversations.has(convId)) continue;
      const hookPrompts = this.promptrailDb.getHookPrompts(convId);
      if (hookPrompts.length > 0) {
        try {
          tasks.push(...this.parseCursorFromHooks(convId, hookPrompts));
        } catch {}
      }
    }

    return tasks;
  }

  /**
   * When multiple consecutive prompts share the exact same timestamp
   * (happens after Cursor updates or session migration), spread them
   * out so each prompt gets a nonzero time window for file matching.
   *
   * fallbackStart/fallbackEnd define the session time range used when
   * bubble timestamps are missing from SQLite (Cursor prunes them for
   * long or old sessions).
   */
  private deduplicateTimestamps(
    raw: number[] | undefined,
    promptCount: number,
    fallbackStart: number,
    fallbackEnd: number
  ): number[] {
    return deduplicateTimestamps(raw, promptCount, fallbackStart, fallbackEnd);
  }

  private parseCursorSession(
    filePath: string,
    composerId: string,
    session: ReturnType<CursorHistory["getComposerSession"]>
  ): TaskWithEdits[] {
    // SQLite-first: user bubbles are the canonical prompt list.
    // They have no duplicates, no auto-continues, and correct
    // per-prompt file attribution via toolFormerData.
    const bubbleData = this.cursorHistory.getUserBubbleData(composerId);

    // Only use SQLite-first if bubble data is usable (has text).
    // Pruned sessions return empty-text bubbles from composerData
    // headers -- fall through to JSONL for those.
    const hasUsableText = bubbleData
      && bubbleData.length > 0
      && bubbleData.some((b) => b.text.length > 0);

    if (hasUsableText) {
      return this.parseCursorFromSQLite(
        composerId, session, bubbleData!
      );
    }

    // Fallback: JSONL-based parsing when SQLite data is unavailable
    // (session not yet in SQLite, or bubble data pruned).
    return this.parseCursorFromJSONL(filePath, composerId, session);
  }

  private parseCursorFromSQLite(
    composerId: string,
    session: ReturnType<CursorHistory["getComposerSession"]>,
    bubbleData: Array<{ text: string; createdAt: number; files: Set<string> }>
  ): TaskWithEdits[] {
    const tasks: TaskWithEdits[] = [];

    const sessionFileSet = new Set<string>();
    for (const fi of session?.filesChanged || []) {
      sessionFileSet.add(fi.relativePath);
    }

    const hasPerPromptData = bubbleData.some(b => b.files.size > 0);

    for (let i = 0; i < bubbleData.length; i++) {
      const b = bubbleData[i];
      tasks.push({
        id: `cur-${composerId.slice(0, 8)}-${i}`,
        prompt: (b.text || "(empty)").slice(0, 500),
        createdAt: b.createdAt || 0,
        status: i < bubbleData.length - 1 ? "completed" : "active",
        filesChanged: [],
        source: "cursor",
        sessionId: composerId,
        promptIndex: i,
        model: session?.model,
        mode: session?.mode,
        toolEditedFiles: resolveToolEditedFiles(b.files, hasPerPromptData),
        sessionEditedFiles: sessionFileSet,
      });
    }

    if (tasks.length === 0) return tasks;

    // File attribution via firstEditBubbleId for initial file list
    const bubbleMapping =
      this.cursorHistory.getFilePromptMapping(composerId);
    if (bubbleMapping) {
      for (const fi of session?.filesChanged || []) {
        const promptIdx = bubbleMapping.get(fi.relativePath);
        if (promptIdx !== undefined && promptIdx < tasks.length) {
          if (!tasks[promptIdx].filesChanged.includes(fi.relativePath)) {
            tasks[promptIdx].filesChanged.push(fi.relativePath);
          }
        }
      }
    }

    if (session && session.lastUpdatedAt > 0) {
      tasks[tasks.length - 1].completedAt = session.lastUpdatedAt;
    }

    return tasks;
  }

  private parseCursorFromHooks(
    conversationId: string,
    hookPrompts: Array<{
      generationId: string;
      promptText: string;
      model: string | null;
      timestamp: number;
    }>
  ): TaskWithEdits[] {
    const tasks: TaskWithEdits[] = [];
    const allEdits = this.promptrailDb.getHookEdits(conversationId);

    // Group edits by generationId
    const editsByGen = new Map<
      string,
      Array<{
        filePath: string;
        oldString: string | null;
        newString: string | null;
      }>
    >();
    for (const e of allEdits) {
      if (!editsByGen.has(e.generationId))
        editsByGen.set(e.generationId, []);
      editsByGen.get(e.generationId)!.push(e);
    }

    for (let i = 0; i < hookPrompts.length; i++) {
      const p = hookPrompts[i];
      const genEdits = editsByGen.get(p.generationId) || [];

      const editRecords: EditRecord[] = [];
      const writeRecords: WriteRecord[] = [];
      const filesChanged: string[] = [];

      for (const e of genEdits) {
        if (e.oldString === null && e.newString === null) continue;
        if (!filesChanged.includes(e.filePath)) filesChanged.push(e.filePath);

        if (
          (e.oldString === "" || e.oldString === null) &&
          e.newString
        ) {
          // Write: new file or full content replace
          writeRecords.push({ file: e.filePath, content: e.newString });
        } else if (e.oldString && e.newString != null) {
          editRecords.push({
            file: e.filePath,
            oldString: e.oldString,
            newString: e.newString,
          });
        }
      }

      tasks.push({
        id: `cur-${conversationId.slice(0, 8)}-${i}`,
        prompt: (p.promptText || "(empty)").slice(0, 500),
        createdAt: p.timestamp,
        status: i < hookPrompts.length - 1 ? "completed" : "active",
        filesChanged,
        source: "cursor",
        sessionId: conversationId,
        promptIndex: i,
        model: p.model || undefined,
        generationId: p.generationId,
        edits: editRecords.length > 0 ? editRecords : undefined,
        writes: writeRecords.length > 0 ? writeRecords : undefined,
      });
    }

    return tasks;
  }

  private parseCursorFromJSONL(
    filePath: string,
    composerId: string,
    session: ReturnType<CursorHistory["getComposerSession"]>
  ): TaskWithEdits[] {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const tasks: TaskWithEdits[] = [];
    let cur: TaskWithEdits | undefined;
    let taskIdx = 0;

    const prompts: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.role === "user") {
          const text = this.extractCursorPrompt(obj.message || {});
          prompts.push(text || "(empty)");
        }
      } catch {
        continue;
      }
    }

    const rawTimestamps =
      this.cursorHistory.getUserBubbleTimestamps(composerId);

    const stat = fs.statSync(filePath);
    const fallbackEnd = session?.lastUpdatedAt && session.lastUpdatedAt > 0
      ? session.lastUpdatedAt
      : stat.mtimeMs;
    const fallbackStart = session?.createdAt && session.createdAt > 0
      ? session.createdAt
      : fallbackEnd - prompts.length * 30_000;

    const realTimestamps = this.deduplicateTimestamps(
      rawTimestamps,
      prompts.length,
      fallbackStart,
      fallbackEnd
    );

    const sessionFileSet = new Set<string>();
    for (const fi of session?.filesChanged || []) {
      sessionFileSet.add(fi.relativePath);
    }

    for (let i = 0; i < prompts.length; i++) {
      if (cur) {
        cur.status = "completed";
        tasks.push(cur);
      }

      cur = {
        id: `cur-${composerId.slice(0, 8)}-${taskIdx++}`,
        prompt: prompts[i].slice(0, 500),
        createdAt: realTimestamps[i],
        status: "active",
        filesChanged: [],
        source: "cursor",
        sessionId: composerId,
        promptIndex: i,
        model: session?.model,
        mode: session?.mode,
        sessionEditedFiles: sessionFileSet,
      };
    }

    if (cur) {
      cur.status = "completed";
      tasks.push(cur);
    }

    if (tasks.length === 0) return tasks;

    const perPromptFiles =
      this.cursorHistory.getPerPromptFiles(composerId);
    if (perPromptFiles) {
      for (let i = 0; i < tasks.length; i++) {
        tasks[i].toolEditedFiles = perPromptFiles.get(i) ?? new Set();
      }
    }

    const bubbleMapping =
      this.cursorHistory.getFilePromptMapping(composerId);
    const sessionFiles = session?.filesChanged || [];
    if (sessionFiles.length > 0 && bubbleMapping) {
      for (const fileInfo of sessionFiles) {
        const promptIdx = bubbleMapping.get(fileInfo.relativePath);
        const target =
          promptIdx !== undefined && promptIdx < tasks.length
            ? tasks[promptIdx]
            : tasks[tasks.length - 1];
        if (!target.filesChanged.includes(fileInfo.relativePath)) {
          target.filesChanged.push(fileInfo.relativePath);
        }
      }
    }

    if (session && session.lastUpdatedAt > 0) {
      tasks[tasks.length - 1].completedAt = session.lastUpdatedAt;
    }

    return tasks;
  }

  private extractCursorPrompt(msg: any): string {
    const content = msg?.content;

    if (typeof content === "string") {
      return this.extractQueryFromText(content);
    }

    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== "text") continue;
        const text: string = c.text || "";
        const extracted = this.extractQueryFromText(text);
        if (extracted) return extracted;
      }
    }

    return "";
  }

  private extractQueryFromText(text: string): string {
    if (text.includes("<user_query>")) {
      const s = text.indexOf("<user_query>") + 12;
      const e = text.indexOf("</user_query>");
      if (e > s) return text.slice(s, e).trim();
    }

    if (
      text.startsWith("<system_reminder>") ||
      text.startsWith("<open_and_recently")
    ) {
      return "";
    }

    const cleaned = text.replace(/<[^>]+>/g, "").trim();
    if (cleaned.length > 5) return cleaned.slice(0, 300);

    return "";
  }

  // ── VS Code Chat ─────────────────────────────────────────

  private readVSCodeSessions(): TaskWithEdits[] {
    const sessions = this.vscodeHistory.readAllSessions();
    if (sessions.length === 0) return [];

    const tasks: TaskWithEdits[] = [];

    for (const session of sessions) {
      const editingOps = this.vscodeHistory.getEditingOps(session.sessionId);

      for (let i = 0; i < session.requests.length; i++) {
        const req = session.requests[i];
        if (!req.messageText || req.messageText.length < 2) continue;

        // Get files from editing ops (ground truth) + response tool invocations
        const filesChanged = new Set<string>();

        // Primary: chatEditingSessions state.json per-request ops
        if (editingOps) {
          const reqFiles = editingOps.get(req.requestId);
          if (reqFiles) {
            for (const f of reqFiles) {
              if (f) filesChanged.add(f);
            }
          }
        }

        // Secondary: tool invocations from JSONL response
        for (const f of req.filesEdited) {
          if (f) filesChanged.add(f);
        }

        // Get diff data from chatEditingSessions snapshot replay
        const diffs = this.vscodeHistory.getDiffsForRequest(
          session.sessionId,
          req.requestId
        );

        const edits: EditRecord[] = [];
        const writes: WriteRecord[] = [];

        if (diffs) {
          for (const diff of diffs) {
            if (diff.type === "added") {
              writes.push({ file: diff.relativePath, content: diff.after });
            } else if (diff.type === "modified") {
              edits.push({
                file: diff.relativePath,
                oldString: diff.before,
                newString: diff.after,
              });
            }
            // For "deleted", we don't populate edits/writes
            // since there's no content to show
          }
        }

        tasks.push({
          id: `vsc-${session.sessionId.slice(0, 8)}-${i}`,
          prompt: req.messageText.slice(0, 500),
          createdAt: req.timestamp || session.creationDate,
          status: "completed",
          filesChanged: [...filesChanged],
          source: "vscode",
          sessionId: session.sessionId,
          model: session.model,
          mode: session.mode,
          promptIndex: i,
          edits: edits.length > 0 ? edits : undefined,
          writes: writes.length > 0 ? writes : undefined,
        });
      }
    }

    return tasks;
  }
}
