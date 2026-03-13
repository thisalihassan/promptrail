import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { Task, TaskChangeset, FileChange } from "../models/types";
import { SessionReader, type TaskWithEdits } from "./session-reader";
import { FileWatcher } from "./file-watcher";
import {
  selectiveRevert,
  revertStringEdits,
  type RollbackResult,
} from "./selective-revert";

export class Tracker {
  private sessionReader: SessionReader;
  private fileWatcher: FileWatcher;
  private workspaceRoot: string;
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private pollInterval: NodeJS.Timeout | undefined;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.sessionReader = new SessionReader(workspaceRoot);
    this.fileWatcher = new FileWatcher(workspaceRoot);

    this.pollInterval = setInterval(() => {
      this.fileWatcher.persistChanges();
      this.onDidChangeEmitter.fire();
    }, 4000);
  }

  getTasks(): Task[] {
    const tasks = this.sessionReader.readAllTasks();
    const sorted = [...tasks].sort(
      (a, b) => a.createdAt - b.createdAt
    );

    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].source !== "cursor") continue;

      const startTs = sorted[i].createdAt;
      const endTs =
        i + 1 < sorted.length ? sorted[i + 1].createdAt : Date.now();

      const { files } = this.fileWatcher.getChangesInWindow(
        startTs,
        endTs
      );
      const te = sorted[i] as TaskWithEdits;
      const perPrompt = te.toolEditedFiles;
      const session = te.sessionEditedFiles;
      if (files.length > 0) {
        const whitelist = perPrompt && perPrompt.size > 0 ? perPrompt : session;
        sorted[i].filesChanged = whitelist && whitelist.size > 0
          ? files.filter((f) => whitelist.has(f))
          : files;
      }
      if (sorted[i].filesChanged.length === 0 && perPrompt && perPrompt.size > 0) {
        sorted[i].filesChanged = [...perPrompt];
      }
    }

    return sorted.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Builds time windows for sources that are self-contained (Claude, VS Code),
   * so the file watcher excludes changes that belong to them.
   */
  private buildSelfContainedWindows(
    sorted: Task[]
  ): Array<{ start: number; end: number }> {
    const windows: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].source !== "claude" && sorted[i].source !== "vscode") continue;
      const start = sorted[i].createdAt;
      const end =
        i + 1 < sorted.length ? sorted[i + 1].createdAt : Date.now();
      windows.push({ start, end });
    }
    return windows;
  }

  getActiveTaskId(): string | undefined {
    const tasks = this.sessionReader.readAllTasks();
    const active = tasks.find((t) => t.status === "active");
    return active?.id;
  }

  getTaskChangeset(taskId: string): TaskChangeset | undefined {
    const tasks = this.sessionReader.readAllTasks();
    const task = tasks.find((t) => t.id === taskId) as
      | TaskWithEdits
      | undefined;
    if (!task) return undefined;

    if (task.source === "claude" || task.source === "vscode") {
      return this.claudeChangeset(task);
    }

    if (task.source === "cursor") {
      const sorted = [...tasks].sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const idx = sorted.findIndex((t) => t.id === taskId);
      const startTs = task.createdAt;
      const endTs =
        idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();

      let { changes } = this.fileWatcher.getChangesInWindow(
        startTs,
        endTs
      );
      if (task.toolEditedFiles) {
        changes = changes.filter((c) =>
          task.toolEditedFiles!.has(c.relativePath)
        );
      }
      if (changes.length > 0) {
        return { taskId, changes };
      }
    }

    return undefined;
  }

  private claudeChangeset(task: TaskWithEdits): TaskChangeset | undefined {
    const changes: FileChange[] = [];

    if (task.edits && task.edits.length > 0) {
      const byFile = new Map<string, { olds: string[]; news: string[] }>();
      for (const edit of task.edits) {
        if (!byFile.has(edit.file)) {
          byFile.set(edit.file, { olds: [], news: [] });
        }
        byFile.get(edit.file)!.olds.push(edit.oldString);
        byFile.get(edit.file)!.news.push(edit.newString);
      }
      for (const [file, data] of byFile) {
        changes.push({
          relativePath: file,
          type: "modified",
          before: data.olds.join("\n...\n"),
          after: data.news.join("\n...\n"),
        });
      }
    }

    if (task.writes && task.writes.length > 0) {
      for (const write of task.writes) {
        if (!changes.find((c) => c.relativePath === write.file)) {
          changes.push({
            relativePath: write.file,
            type: "added",
            before: "",
            after: write.content,
          });
        }
      }
    }

    if (changes.length === 0) return undefined;
    return { taskId: task.id, changes };
  }

  async rollbackToTask(
    taskId: string,
    mode: "selective" | "hard" = "selective"
  ): Promise<RollbackResult> {
    const tasks = this.sessionReader.readAllTasks();
    const task = tasks.find((t) => t.id === taskId) as
      | TaskWithEdits
      | undefined;
    const empty: RollbackResult = {
      success: false,
      filesReverted: [],
      conflicts: [],
    };
    if (!task) return empty;

    if (mode === "hard") {
      return this.hardRollback(task, tasks);
    }

    if (task.source === "claude" || task.source === "vscode") {
      return this.selectiveRollbackClaude(task);
    }

    if (task.source === "cursor") {
      const sorted = [...tasks].sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const idx = sorted.findIndex((t) => t.id === taskId);
      const startTs = task.createdAt;
      const endTs =
        idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();

      return this.selectiveRollbackWatcher(startTs, endTs, task.toolEditedFiles);
    }

    return empty;
  }

  private hardRollback(
    task: TaskWithEdits,
    tasks: TaskWithEdits[]
  ): RollbackResult {
    const result: RollbackResult = {
      success: false,
      filesReverted: [],
      conflicts: [],
    };

    if (task.source === "cursor") {
      const sorted = [...tasks].sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const idx = sorted.findIndex((t) => t.id === task.id);
      const startTs = task.createdAt;
      const endTs =
        idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();

      let changes = this.fileWatcher.getRollbackForWindow(startTs, endTs);
      if (task.toolEditedFiles) {
        changes = changes.filter((c) =>
          task.toolEditedFiles!.has(c.relativePath)
        );
      }
      if (changes.length === 0) return result;

      for (const change of changes) {
        const absPath = path.join(this.workspaceRoot, change.relativePath);
        if (change.type === "deleted") {
          if (fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
            result.filesReverted.push({
              path: change.relativePath,
              status: "deleted",
            });
          }
        } else if (change.after !== undefined) {
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(absPath, change.after, "utf-8");
          result.filesReverted.push({
            path: change.relativePath,
            status: "reverted",
          });
        }
      }
    }

    result.success = result.filesReverted.length > 0;
    this.onDidChangeEmitter.fire();
    return result;
  }

  private selectiveRollbackWatcher(
    startTs: number,
    endTs: number,
    whitelist?: Set<string>
  ): RollbackResult {
    const result: RollbackResult = {
      success: false,
      filesReverted: [],
      conflicts: [],
    };

    let { changes } = this.fileWatcher.getChangesInWindow(startTs, endTs);
    if (whitelist) {
      changes = changes.filter((c) => whitelist.has(c.relativePath));
    }
    if (changes.length === 0) return result;

    for (const change of changes) {
      const absPath = path.join(this.workspaceRoot, change.relativePath);

      if (change.type === "added") {
        // File was created by this prompt
        let currentContent: string | undefined;
        try {
          currentContent = fs.readFileSync(absPath, "utf-8");
        } catch {}

        if (currentContent === undefined) {
          // Already deleted, skip
          continue;
        }

        if (currentContent === change.after) {
          // No subsequent changes — safe to delete
          fs.unlinkSync(absPath);
          result.filesReverted.push({
            path: change.relativePath,
            status: "deleted",
          });
        } else {
          result.conflicts.push({
            path: change.relativePath,
            reason:
              "File was created by this prompt but later modified — cannot safely delete",
          });
        }
        continue;
      }

      if (change.type === "deleted") {
        // File was deleted by this prompt — recreate with before content
        if (fs.existsSync(absPath)) {
          result.conflicts.push({
            path: change.relativePath,
            reason:
              "File was deleted by this prompt but has been recreated since",
          });
        } else {
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(absPath, change.before ?? "", "utf-8");
          result.filesReverted.push({
            path: change.relativePath,
            status: "recreated",
          });
        }
        continue;
      }

      // Modified file — selective revert
      let currentContent: string;
      try {
        currentContent = fs.readFileSync(absPath, "utf-8");
      } catch {
        result.conflicts.push({
          path: change.relativePath,
          reason: "File no longer exists on disk",
        });
        continue;
      }

      const revert = selectiveRevert(
        change.before ?? "",
        change.after ?? "",
        currentContent
      );

      if (revert.applied > 0) {
        fs.writeFileSync(absPath, revert.content, "utf-8");
        result.filesReverted.push({
          path: change.relativePath,
          status: "reverted",
        });
      }

      for (const c of revert.conflicts) {
        result.conflicts.push({
          path: change.relativePath,
          reason: c.description,
        });
      }
    }

    result.success = result.filesReverted.length > 0;
    this.onDidChangeEmitter.fire();
    return result;
  }

  private selectiveRollbackClaude(task: TaskWithEdits): RollbackResult {
    const result: RollbackResult = {
      success: false,
      filesReverted: [],
      conflicts: [],
    };

    // Revert writes (file creations) first
    if (task.writes && task.writes.length > 0) {
      for (const write of task.writes) {
        const absPath = path.join(this.workspaceRoot, write.file);
        let currentContent: string | undefined;
        try {
          currentContent = fs.readFileSync(absPath, "utf-8");
        } catch {}

        if (currentContent === undefined) continue;

        if (currentContent === write.content) {
          fs.unlinkSync(absPath);
          result.filesReverted.push({ path: write.file, status: "deleted" });
        } else {
          result.conflicts.push({
            path: write.file,
            reason:
              "File was created by this prompt but later modified — cannot safely delete",
          });
        }
      }
    }

    // Revert edits with exact string matching
    if (task.edits && task.edits.length > 0) {
      const byFile = new Map<
        string,
        Array<{ oldString: string; newString: string }>
      >();
      for (const edit of task.edits) {
        if (!byFile.has(edit.file)) byFile.set(edit.file, []);
        byFile.get(edit.file)!.push({
          oldString: edit.oldString,
          newString: edit.newString,
        });
      }

      for (const [file, edits] of byFile) {
        const absPath = path.join(this.workspaceRoot, file);
        let currentContent: string;
        try {
          currentContent = fs.readFileSync(absPath, "utf-8");
        } catch {
          result.conflicts.push({
            path: file,
            reason: "File no longer exists on disk",
          });
          continue;
        }

        const revert = revertStringEdits(currentContent, edits);

        if (revert.applied > 0) {
          fs.writeFileSync(absPath, revert.content, "utf-8");
          result.filesReverted.push({ path: file, status: "reverted" });
        }

        for (const c of revert.conflicts) {
          result.conflicts.push({ path: file, reason: c.description });
        }
      }
    }

    result.success = result.filesReverted.length > 0;
    this.onDidChangeEmitter.fire();
    return result;
  }

  getTaskResponse(taskId: string): string | undefined {
    const tasks = this.sessionReader.readAllTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return undefined;

    if (task.source === "cursor") {
      const parts = taskId.split("-");
      const userIndex = parseInt(parts[parts.length - 1], 10);
      const shortId = parts.slice(1, -1).join("-");

      const db = this.sessionReader.getPromptRailDB();
      const fullComposerId = db.findComposerIdByPrefix(shortId);
      if (!fullComposerId) return undefined;
      const bubbles = db.getAssistantBubbles(fullComposerId);
      const forPrompt = bubbles.filter(
        (b: any) => b.userIndex === userIndex
      );

      if (forPrompt.length === 0) return undefined;

      let md = `# Response\n\n`;
      md += `> **Prompt:** ${task.prompt}\n\n---\n\n`;

      for (const b of forPrompt) {
        if (b.toolName) {
          md += `**[${b.toolName}]** ${b.toolStatus || ""}\n\n`;
        }
        if (b.text) {
          md += `${b.text}\n\n`;
        }
      }

      return md;
    }

    if (task.source === "claude") {
      const parts = taskId.split("-");
      const promptIndex = parseInt(parts[parts.length - 1], 10);
      const sessionId = task.sessionId || parts.slice(1, -1).join("-");

      const responseText = this.sessionReader.getClaudeResponse(sessionId, promptIndex);
      if (!responseText) return undefined;

      let md = `# Response\n\n`;
      md += `> **Prompt:** ${task.prompt}\n\n---\n\n`;
      md += responseText;
      return md;
    }

    return undefined;
  }

  isFtsAvailable(): boolean {
    return this.sessionReader.getPromptRailDB().isFtsAvailable();
  }

  searchPrompts(
    query: string,
    filters?: { source?: string; model?: string }
  ): Array<{ taskId: string; type: string; snippet: string }> {
    const db = this.sessionReader.getPromptRailDB();
    if (!db.isFtsAvailable()){
      return [];
    }

    const results = db.search(query, filters);
    return results.map((r) => ({
      taskId: `cur-${r.composerId.slice(0, 8)}-${r.userIndex}`,
      type: r.type,
      snippet: r.snippet,
    }));
  }

  refresh(): void {
    this.sessionReader.getCursorHistory().invalidateCache();
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.fileWatcher.dispose();
    this.onDidChangeEmitter.dispose();
  }
}
