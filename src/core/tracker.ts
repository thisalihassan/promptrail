import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { Task, TaskChangeset, FileChange } from "../models/types";
import { SessionReader, type TaskWithEdits } from "./session-reader";
import { FileWatcher } from "./file-watcher";

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

    const claudeWindows = this.buildClaudeWindows(sorted);

    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].source !== "cursor") continue;

      const startTs = sorted[i].createdAt;
      const endTs =
        i + 1 < sorted.length ? sorted[i + 1].createdAt : Date.now();

      const { files } = this.fileWatcher.getChangesInWindow(
        startTs,
        endTs,
        claudeWindows
      );
      if (files.length > 0) {
        sorted[i].filesChanged = files;
      }
    }

    return sorted.sort((a, b) => b.createdAt - a.createdAt);
  }

  private buildClaudeWindows(
    sorted: Task[]
  ): Array<{ start: number; end: number }> {
    const windows: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].source !== "claude") continue;
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

    if (task.source === "claude") {
      return this.claudeChangeset(task);
    }

    if (task.source === "cursor") {
      const sorted = [...tasks].sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const claudeWindows = this.buildClaudeWindows(sorted);
      const idx = sorted.findIndex((t) => t.id === taskId);
      const startTs = task.createdAt;
      const endTs =
        idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();

      const { changes } = this.fileWatcher.getChangesInWindow(
        startTs,
        endTs,
        claudeWindows
      );
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

  async rollbackToTask(taskId: string): Promise<boolean> {
    const tasks = this.sessionReader.readAllTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;

    if (task.source === "cursor") {
      const sorted = [...tasks].sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const claudeWindows = this.buildClaudeWindows(sorted);
      const idx = sorted.findIndex((t) => t.id === taskId);
      const startTs = task.createdAt;
      const endTs =
        idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();

      const changes = this.fileWatcher.getRollbackForWindow(
        startTs,
        endTs,
        claudeWindows
      );
      if (changes.length === 0) return false;

      for (const change of changes) {
        const absPath = path.join(
          this.workspaceRoot,
          change.relativePath
        );
        if (change.type === "deleted") {
          if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        } else if (change.after !== undefined) {
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(absPath, change.after, "utf-8");
        }
      }

      this.onDidChangeEmitter.fire();
      return true;
    }

    return false;
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
