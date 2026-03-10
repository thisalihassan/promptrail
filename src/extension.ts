import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { Tracker } from "./core/tracker";
import { TimelineProvider } from "./views/timeline-provider";
import { ConversationExporter } from "./core/exporter";

let tracker: Tracker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const workspaceRoot = workspaceFolder.uri.fsPath;
  tracker = new Tracker(workspaceRoot);

  const timelineProvider = new TimelineProvider(
    context.extensionUri,
    tracker
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TimelineProvider.viewType,
      timelineProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("promptrail.refresh", () => {
      tracker!.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "promptrail.viewTaskDiff",
      async (taskId?: string) => {
        if (!taskId) {
          taskId = await pickTask("View diff for which task?");
        }
        if (!taskId) return;

        const changeset = tracker!.getTaskChangeset(taskId);
        if (!changeset || changeset.changes.length === 0) {
          vscode.window.showInformationMessage(
            "No diff data available for this task."
          );
          return;
        }

        const task = tracker!.getTasks().find((t) => t.id === taskId);
        const tmpDir = path.join(os.tmpdir(), "promptrail-diff", taskId);
        fs.mkdirSync(tmpDir, { recursive: true });

        for (const change of changeset.changes) {
          const beforePath = path.join(tmpDir, "before", change.relativePath);
          const afterPath = path.join(tmpDir, "after", change.relativePath);

          fs.mkdirSync(path.dirname(beforePath), { recursive: true });
          fs.mkdirSync(path.dirname(afterPath), { recursive: true });

          fs.writeFileSync(beforePath, change.before ?? "", "utf-8");
          fs.writeFileSync(afterPath, change.after ?? "", "utf-8");
        }

        for (let i = 0; i < changeset.changes.length; i++) {
          const change = changeset.changes[i];
          const beforePath = path.join(tmpDir, "before", change.relativePath);
          const afterPath = path.join(tmpDir, "after", change.relativePath);
          const label = `${change.relativePath} (${truncate(task?.prompt ?? "task", 30)})`;

          const openDiff = () =>
            vscode.commands.executeCommand(
              "vscode.diff",
              vscode.Uri.file(beforePath),
              vscode.Uri.file(afterPath),
              label,
              { preview: false }
            );

          if (i === 0) {
            await openDiff();
          } else {
            setTimeout(openDiff, i * 300);
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "promptrail.rollbackToTask",
      async (taskId?: string) => {
        if (!taskId) {
          taskId = await pickTask("Rollback to before which task?");
        }
        if (!taskId) return;

        const task = tracker!.getTasks().find((t) => t.id === taskId);
        const confirm = await vscode.window.showWarningMessage(
          `Rollback "${truncate(task?.prompt ?? taskId, 40)}"? This restores files to their pre-edit state.`,
          { modal: true },
          "Rollback"
        );

        if (confirm !== "Rollback") return;

        const success = await tracker!.rollbackToTask(taskId);
        if (success) {
          vscode.window.showInformationMessage("Rollback complete.");
        } else {
          vscode.window.showErrorMessage(
            "Rollback failed. No snapshot data found for this task."
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("promptrail.exportChat", async () => {
      const sessions = ConversationExporter.findAllSessions(workspaceRoot);

      if (sessions.length === 0) {
        vscode.window.showInformationMessage(
          "No sessions found for this workspace."
        );
        return;
      }

      const items = sessions.map((s) => ({
        label: `${s.source === "cursor" ? "$(comment-discussion)" : "$(terminal)"} ${s.label}`,
        description: s.source,
        detail: s.id.slice(0, 16),
        session: s,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: "Export which conversation?",
        placeHolder: "Select a session to export as markdown",
      });

      if (!picked) return;

      const md = ConversationExporter.convertSessionToMarkdown(
        picked.session.path,
        picked.session.source
      );

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(
            workspaceRoot,
            `conversation-${picked.session.id.slice(0, 8)}.md`
          )
        ),
        filters: { Markdown: ["md"] },
        title: "Save exported conversation",
      });

      if (!saveUri) return;

      fs.writeFileSync(saveUri.fsPath, md, "utf-8");

      const open = await vscode.window.showInformationMessage(
        `Exported to ${path.basename(saveUri.fsPath)}`,
        "Open"
      );
      if (open === "Open") {
        await vscode.commands.executeCommand("vscode.open", saveUri);
      }
    })
  );

  context.subscriptions.push(tracker);
}

export function deactivate(): void {
  tracker?.dispose();
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + "..." : str;
}

async function pickTask(title: string): Promise<string | undefined> {
  if (!tracker) return undefined;

  const tasks = tracker
    .getTasks()
    .filter((t) => t.filesChanged.length > 0);

  if (tasks.length === 0) {
    vscode.window.showInformationMessage("No tasks with file changes found.");
    return undefined;
  }

  const items = tasks.map((t) => ({
    label: truncate(t.prompt, 60),
    description: `${(t as any).source ?? "?"} | ${t.filesChanged.length} file(s)`,
    detail: new Date(t.createdAt).toLocaleString(),
    taskId: t.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select a task",
  });

  return picked?.taskId;
}
