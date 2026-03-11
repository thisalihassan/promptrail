import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Task } from "../models/types";
import { CursorHistory } from "./cursor-history";

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
}

export class SessionReader {
  private workspaceRoot: string;
  private cursorHistory: CursorHistory;
  private cachedTasks: TaskWithEdits[] = [];
  private lastReadAt = 0;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.cursorHistory = new CursorHistory(workspaceRoot);
  }

  readAllTasks(): TaskWithEdits[] {
    const now = Date.now();
    if (now - this.lastReadAt < 2000 && this.cachedTasks.length > 0) {
      return this.cachedTasks;
    }
    this.lastReadAt = now;

    const claudeTasks = this.readClaudeSessions();
    const cursorTasks = this.readCursorSessions();

    this.cachedTasks = [...claudeTasks, ...cursorTasks].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    return this.cachedTasks;
  }

  getCursorHistory(): CursorHistory {
    return this.cursorHistory;
  }

  private toRelPath(absPath: string): string {
    if (absPath.startsWith(this.workspaceRoot + "/")) {
      return absPath.slice(this.workspaceRoot.length + 1);
    }
    return absPath;
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
    const msg = obj.message || {};
    const content = typeof msg === "object" ? msg.content : "";

    if (typeof content === "string" && content.length > 2) return content;

    if (Array.isArray(content)) {
      for (const c of content) {
        if (
          c?.type === "text" &&
          typeof c.text === "string" &&
          c.text.length > 2
        )
          return c.text;
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
    const dir = this.getCursorTranscriptsDir();
    if (!dir) return [];

    const tasks: TaskWithEdits[] = [];
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
      const session = this.cursorHistory.getComposerSession(composerId);

      try {
        tasks.push(
          ...this.parseCursorSession(jsonlFile, composerId, session)
        );
      } catch {
        continue;
      }
    }
    return tasks;
  }

  /**
   * When multiple consecutive prompts share the exact same timestamp
   * (happens after Cursor updates or session migration), spread them
   * out so each prompt gets a nonzero time window for file matching.
   */
  private deduplicateTimestamps(
    raw: number[] | undefined,
    promptCount: number,
    fallbackMod: number
  ): number[] {
    const result: number[] = [];

    for (let i = 0; i < promptCount; i++) {
      const ts =
        raw && raw[i] && raw[i] > 0
          ? raw[i]
          : fallbackMod - (promptCount - i) * 30_000;
      result.push(ts);
    }

    for (let i = 1; i < result.length; i++) {
      if (result[i] <= result[i - 1]) {
        result[i] = result[i - 1] + 1;
      }
    }

    return result;
  }

  private parseCursorSession(
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
          if (text && text.length >= 4) prompts.push(text);
        }
      } catch {
        continue;
      }
    }

    const rawTimestamps =
      this.cursorHistory.getUserBubbleTimestamps(composerId);

    const stat = fs.statSync(filePath);
    const fallbackMod = stat.mtimeMs;

    const realTimestamps = this.deduplicateTimestamps(
      rawTimestamps,
      prompts.length,
      fallbackMod
    );

    for (let i = 0; i < prompts.length; i++) {
      if (cur) {
        cur.status = "completed";
        tasks.push(cur);
      }

      const ts = realTimestamps[i];

      cur = {
        id: `cur-${composerId.slice(0, 8)}-${taskIdx++}`,
        prompt: prompts[i].slice(0, 500),
        createdAt: ts,
        status: "active",
        filesChanged: [],
        source: "cursor",
        sessionId: composerId,
        promptIndex: i,
        model: session?.model,
        mode: session?.mode,
      };
    }

    if (cur) {
      cur.status = "completed";
      tasks.push(cur);
    }

    if (tasks.length === 0) return tasks;

    // Per-prompt file whitelist from toolFormerData (ground truth from SQLite).
    // This tells us exactly which files the AI edited per prompt,
    // filtering out git pull / manual user edits that the watcher picks up.
    const perPromptFiles =
      this.cursorHistory.getPerPromptFiles(composerId);
    if (perPromptFiles) {
      for (const [promptIdx, files] of perPromptFiles) {
        if (promptIdx < tasks.length) {
          tasks[promptIdx].toolEditedFiles = files;
        }
      }
    }

    // File attribution via SQLite bubble mapping (for initial first-edit info).
    // The file watcher will override filesChanged with real-time data for
    // prompts that happened while the extension was active.
    const sessionFiles = session?.filesChanged || [];
    if (sessionFiles.length > 0) {
      const bubbleMapping =
        this.cursorHistory.getFilePromptMapping(composerId);

      for (const fileInfo of sessionFiles) {
        const promptIdx = bubbleMapping?.get(fileInfo.relativePath);
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
}
