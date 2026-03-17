import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { Task, TaskChangeset, FileChange } from "../models/types";
import { SessionReader, type TaskWithEdits } from "./session-reader";
import {
  revertStringEdits,
  type RollbackResult,
} from "./selective-revert";

export class Tracker {
  private sessionReader: SessionReader;
  private workspaceRoot: string;
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private pollInterval: NodeJS.Timeout | undefined;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.sessionReader = new SessionReader(workspaceRoot);

    this.pollInterval = setInterval(() => {
      this.onDidChangeEmitter.fire();
    }, 4000);
  }

  getTasks(): Task[] {
    const tasks = this.sessionReader.readAllTasks();
    return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
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

    return this.buildChangeset(task);
  }

  private buildChangeset(task: TaskWithEdits): TaskChangeset | undefined {
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

  async rollbackToTask(taskId: string): Promise<RollbackResult> {
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

    return this.editBasedRollback(task);
  }

  private editBasedRollback(task: TaskWithEdits): RollbackResult {
    const result: RollbackResult = {
      success: false,
      filesReverted: [],
      conflicts: [],
    };

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

      const te = task as TaskWithEdits;
      if (te.generationId) {
        const hookResp = this.sessionReader.getHookResponse(
          fullComposerId,
          te.generationId
        );
        if (hookResp) {
          let md = `# Response\n\n`;
          md += `> **Prompt:** ${task.prompt}\n\n---\n\n`;
          md += hookResp;
          return md;
        }
      } else {
        const genId = this.sessionReader.getHookGenerationId(
          fullComposerId,
          userIndex
        );
        if (genId) {
          const hookResp = this.sessionReader.getHookResponse(
            fullComposerId,
            genId
          );
          if (hookResp) {
            let md = `# Response\n\n`;
            md += `> **Prompt:** ${task.prompt}\n\n---\n\n`;
            md += hookResp;
            return md;
          }
        }
      }

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
    this.onDidChangeEmitter.dispose();
    this.sessionReader.getPromptRailDB().dispose();
  }
}
