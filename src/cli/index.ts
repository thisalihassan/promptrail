import * as fs from "fs";
import * as path from "path";
import { SessionReader, type TaskWithEdits } from "../core/session-reader";
import type { Task, FileChange } from "../models/types";
import {
  exportSessions,
  importSessions,
  exportSummary,
  importSummary,
  type ExportData,
} from "../core/migrator";
import {
  selectiveRevert,
  revertStringEdits,
} from "../core/selective-revert";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function truncate(str: string, len: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  return oneLine.length > len ? oneLine.slice(0, len) + "..." : oneLine;
}

function getWorkspaceRoot(): string {
  return process.cwd();
}

interface Flags {
  source?: string;  // "claude" | "cursor" | "vscode"
  model?: string;   // substring match against task.model
  files?: boolean;
  hard?: boolean;
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--source" || args[i] === "-s") && args[i + 1]) {
      flags.source = args[++i].toLowerCase();
    } else if ((args[i] === "--model" || args[i] === "-m") && args[i + 1]) {
      flags.model = args[++i].toLowerCase();
    } else if (args[i] === "--files" || args[i] === "-f") {
      flags.files = true;
    } else if (args[i] === "--hard") {
      flags.hard = true;
    } else {
      flags.positional.push(args[i]);
    }
  }
  return flags;
}

function filterTasks(tasks: Task[], flags: Flags): Task[] {
  let filtered = tasks;
  if (flags.source) {
    filtered = filtered.filter((t) => (t.source || "").toLowerCase() === flags.source);
  }
  if (flags.model) {
    const m = flags.model;
    filtered = filtered.filter((t) => (t.model || "").toLowerCase().includes(m));
  }
  return filtered;
}

function readSnapshots(
  wsRoot: string
): { relPath: string; before: string; after: string; timestamp: number }[] {
  const filePath = path.join(wsRoot, ".promptrail", "snapshots", "changes.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
}

function getChangesInWindow(
  snapshots: ReturnType<typeof readSnapshots>,
  startTs: number,
  endTs: number,
  excludeWindows?: Array<{ start: number; end: number }>
): FileChange[] {
  const inWindow = snapshots.filter((c) => {
    if (c.timestamp < startTs || c.timestamp >= endTs) return false;
    if (excludeWindows) {
      for (const w of excludeWindows) {
        if (c.timestamp >= w.start && c.timestamp < w.end) return false;
      }
    }
    return true;
  });

  const merged = new Map<string, { before: string; after: string }>();
  for (const c of inWindow) {
    const existing = merged.get(c.relPath);
    if (!existing) {
      merged.set(c.relPath, { before: c.before, after: c.after });
    } else {
      existing.after = c.after;
    }
  }

  const changes: FileChange[] = [];
  for (const [relPath, data] of merged) {
    if (data.before === data.after) continue;
    let type: FileChange["type"] = "modified";
    if (data.before === "" && data.after !== "") type = "added";
    else if (data.before !== "" && data.after === "") type = "deleted";
    changes.push({ relativePath: relPath, type, before: data.before, after: data.after });
  }
  return changes;
}

function cmdTimeline(flags: Flags): void {
  const wsRoot = getWorkspaceRoot();
  const reader = new SessionReader(wsRoot);
  const tasks = reader.readAllTasks();
  const snapshots = readSnapshots(wsRoot);

  const filtered = filterTasks(tasks, flags);
  if (filtered.length === 0) {
    console.log(`${DIM}No sessions found${flags.source || flags.model ? " matching filters" : " for this workspace"}.${RESET}`);
    return;
  }

  const chronological = [...filtered].sort((a, b) => a.createdAt - b.createdAt);
  const sorted = [...chronological].reverse();

  console.log();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const chronIdx = chronological.indexOf(t);
    const src = t.source || "unknown";
    const srcLabel = src === "cursor" ? `${BLUE}cursor${RESET}` : src === "claude" ? `${MAGENTA}claude${RESET}` : src === "vscode" ? `${GREEN}vscode${RESET}` : `${DIM}${src}${RESET}`;

    let files = t.filesChanged;
    if (t.source === "cursor" && snapshots.length > 0) {
      const te = t as TaskWithEdits;
      const perPrompt = te.toolEditedFiles;
      const session = te.sessionEditedFiles;
      const startTs = t.createdAt;
      const endTs = chronIdx + 1 < chronological.length ? chronological[chronIdx + 1].createdAt : Date.now();
      const changes = getChangesInWindow(snapshots, startTs, endTs);
      if (changes.length > 0) {
        const whitelist = perPrompt && perPrompt.size > 0 ? perPrompt : session;
        const relPaths = changes.map((c) => c.relativePath);
        files = whitelist && whitelist.size > 0 ? relPaths.filter((f) => whitelist.has(f)) : relPaths;
      }
      if (files.length === 0 && perPrompt && perPrompt.size > 0) {
        files = [...perPrompt];
      }
    }

    const hasFiles = files.length > 0;
    const dot = hasFiles ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    const fileCount = hasFiles
      ? `${GREEN}${files.length} file${files.length === 1 ? "" : "s"}${RESET}`
      : `${DIM}no changes${RESET}`;
    const time = `${DIM}${timeAgo(t.createdAt)}${RESET}`;
    const model = t.model ? `${DIM}[${t.model.replace("claude-", "").replace("-thinking", "")}]${RESET}` : "";
    const idx = `${DIM}#${chronIdx}${RESET}`;

    console.log(`  ${dot} ${idx} ${srcLabel} ${truncate(t.prompt, 60)}  ${fileCount}  ${time} ${model}`);

    if (flags.files && files.length > 0) {
      for (const f of files) {
        console.log(`      ${DIM}${f}${RESET}`);
      }
    }
  }

  console.log(`\n${DIM}${sorted.length} prompts total${RESET}`);
}

function cmdDiff(selector: string, flags: Flags = { positional: [] }): void {
  const wsRoot = getWorkspaceRoot();
  const reader = new SessionReader(wsRoot);
  const tasks = reader.readAllTasks();
  const filtered = filterTasks(tasks, flags);
  const sorted = [...filtered].sort((a, b) => a.createdAt - b.createdAt);

  const task = resolveTask(sorted, selector);
  if (!task) {
    console.error(`${RED}No task matching "${selector}"${RESET}`);
    process.exit(1);
  }

  const idx = sorted.indexOf(task);
  let changes: FileChange[] = [];

  if (task.source === "cursor") {
    const snapshots = readSnapshots(wsRoot);
    const allSorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt);
    const scWindows: Array<{ start: number; end: number }> = [];
    for (let si = 0; si < allSorted.length; si++) {
      const s = allSorted[si].source;
      if (s !== "claude" && s !== "vscode") continue;
      scWindows.push({
        start: allSorted[si].createdAt,
        end: si + 1 < allSorted.length ? allSorted[si + 1].createdAt : Date.now(),
      });
    }
    const startTs = task.createdAt;
    const endTs = idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();
    changes = getChangesInWindow(snapshots, startTs, endTs, scWindows);
    const whitelist = (task as TaskWithEdits).toolEditedFiles;
    if (whitelist) {
      changes = changes.filter((c) => whitelist.has(c.relativePath));
    }
  } else if (task.source === "claude" || task.source === "vscode") {
    const te = task as TaskWithEdits;
    if (te.edits) {
      for (const edit of te.edits) {
        changes.push({
          relativePath: edit.file,
          type: "modified",
          before: edit.oldString,
          after: edit.newString,
        });
      }
    }
    if (te.writes) {
      for (const write of te.writes) {
        changes.push({
          relativePath: write.file,
          type: "added",
          before: "",
          after: write.content,
        });
      }
    }
  }

  if (changes.length === 0) {
    console.log(`${DIM}No diff data available for this prompt.${RESET}`);
    return;
  }

  console.log(`${BOLD}Diff for:${RESET} ${truncate(task.prompt, 80)}`);
  console.log(`${DIM}${timeAgo(task.createdAt)} | ${task.source} | ${changes.length} file(s)${RESET}\n`);

  for (const change of changes) {
    const typeColor = change.type === "added" ? GREEN : change.type === "deleted" ? RED : YELLOW;
    console.log(`${typeColor}${BOLD}${change.type.toUpperCase()}${RESET} ${change.relativePath}`);

    if (change.before && change.after) {
      const beforeLines = change.before.split("\n");
      const afterLines = change.after.split("\n");
      printSimpleDiff(beforeLines, afterLines);
    } else if (change.type === "added" && change.after) {
      const lines = change.after.split("\n");
      const show = lines.slice(0, 20);
      for (const line of show) console.log(`${GREEN}+ ${line}${RESET}`);
      if (lines.length > 20) console.log(`${DIM}... ${lines.length - 20} more lines${RESET}`);
    } else if (change.type === "deleted" && change.before) {
      const lines = change.before.split("\n");
      const show = lines.slice(0, 20);
      for (const line of show) console.log(`${RED}- ${line}${RESET}`);
      if (lines.length > 20) console.log(`${DIM}... ${lines.length - 20} more lines${RESET}`);
    }
    console.log();
  }
}

function printSimpleDiff(beforeLines: string[], afterLines: string[]): void {
  const maxLines = 50;
  let printed = 0;

  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length && printed < maxLines) {
    if (beforeLines[i] === afterLines[j]) {
      i++;
      j++;
      continue;
    }

    let matchAhead = -1;
    for (let k = j + 1; k < Math.min(j + 5, afterLines.length); k++) {
      if (beforeLines[i] === afterLines[k]) { matchAhead = k; break; }
    }

    if (matchAhead >= 0) {
      for (let k = j; k < matchAhead; k++) {
        console.log(`${GREEN}+ ${afterLines[k]}${RESET}`);
        printed++;
      }
      j = matchAhead;
    } else {
      console.log(`${RED}- ${beforeLines[i]}${RESET}`);
      console.log(`${GREEN}+ ${afterLines[j]}${RESET}`);
      printed += 2;
      i++;
      j++;
    }
  }

  while (i < beforeLines.length && printed < maxLines) {
    console.log(`${RED}- ${beforeLines[i]}${RESET}`);
    i++;
    printed++;
  }

  while (j < afterLines.length && printed < maxLines) {
    console.log(`${GREEN}+ ${afterLines[j]}${RESET}`);
    j++;
    printed++;
  }

  const remaining = (beforeLines.length - i) + (afterLines.length - j);
  if (remaining > 0) {
    console.log(`${DIM}... ${remaining} more lines${RESET}`);
  }
}

function cmdRollback(selector: string, hard = false): void {
  const wsRoot = getWorkspaceRoot();
  const reader = new SessionReader(wsRoot);
  const tasks = reader.readAllTasks();
  const sorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt);

  const task = resolveTask(sorted, selector);
  if (!task) {
    console.error(`${RED}No task matching "${selector}"${RESET}`);
    process.exit(1);
  }

  const modeLabel = hard ? "Restore files" : "Cherry revert";
  console.log(`${BOLD}${modeLabel}:${RESET} ${truncate(task.prompt, 70)}`);

  let reverted = 0;
  let conflicts = 0;

  if (hard) {
    // Hard reset: restore files to exact state before this prompt
    const idx = sorted.indexOf(task);
    const snapshots = readSnapshots(wsRoot);
    const startTs = task.createdAt;
    const endTs = idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();
    let changes = getChangesInWindow(snapshots, startTs, endTs);
    const whitelist = (task as TaskWithEdits).toolEditedFiles;
    if (whitelist) {
      changes = changes.filter((c) => whitelist.has(c.relativePath));
    }

    if (changes.length === 0) {
      console.log(`${DIM}No snapshot data to rollback for this prompt.${RESET}`);
      return;
    }

    console.log(`${DIM}Restoring ${changes.length} file(s) to pre-prompt state...${RESET}\n`);

    for (const change of changes) {
      const absPath = path.join(wsRoot, change.relativePath);
      if (change.type === "added") {
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          console.log(`  ${RED}deleted${RESET} ${change.relativePath}`);
          reverted++;
        }
      } else {
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, change.before ?? "", "utf-8");
        console.log(`  ${YELLOW}restored${RESET} ${change.relativePath}`);
        reverted++;
      }
    }
  } else if (task.source === "claude" || task.source === "vscode") {
    const te = task as TaskWithEdits;

    // Revert writes (file creations)
    if (te.writes && te.writes.length > 0) {
      for (const write of te.writes) {
        const absPath = path.join(wsRoot, write.file);
        let currentContent: string | undefined;
        try { currentContent = fs.readFileSync(absPath, "utf-8"); } catch {}

        if (currentContent === undefined) continue;
        if (currentContent === write.content) {
          fs.unlinkSync(absPath);
          console.log(`  ${RED}deleted${RESET} ${write.file}`);
          reverted++;
        } else {
          console.log(`  ${YELLOW}CONFLICT${RESET} ${write.file} — created by this prompt but later modified`);
          conflicts++;
        }
      }
    }

    // Revert edits with exact string matching
    if (te.edits && te.edits.length > 0) {
      const byFile = new Map<string, Array<{ oldString: string; newString: string }>>();
      for (const edit of te.edits) {
        if (!byFile.has(edit.file)) byFile.set(edit.file, []);
        byFile.get(edit.file)!.push({ oldString: edit.oldString, newString: edit.newString });
      }

      for (const [file, edits] of byFile) {
        const absPath = path.join(wsRoot, file);
        let currentContent: string;
        try { currentContent = fs.readFileSync(absPath, "utf-8"); } catch {
          console.log(`  ${YELLOW}CONFLICT${RESET} ${file} — file no longer exists`);
          conflicts++;
          continue;
        }

        const result = revertStringEdits(currentContent, edits);
        if (result.applied > 0) {
          fs.writeFileSync(absPath, result.content, "utf-8");
          console.log(`  ${GREEN}reverted${RESET} ${file} (${result.applied} edit${result.applied === 1 ? "" : "s"})`);
          reverted++;
        }
        for (const c of result.conflicts) {
          console.log(`  ${YELLOW}CONFLICT${RESET} ${file} — ${c.description}`);
          conflicts++;
        }
      }
    }
  } else {
    // Cursor or other: use watcher snapshots
    const idx = sorted.indexOf(task);
    const snapshots = readSnapshots(wsRoot);
    const startTs = task.createdAt;
    const endTs = idx + 1 < sorted.length ? sorted[idx + 1].createdAt : Date.now();
    let changes = getChangesInWindow(snapshots, startTs, endTs);
    const whitelist = (task as TaskWithEdits).toolEditedFiles;
    if (whitelist) {
      changes = changes.filter((c) => whitelist.has(c.relativePath));
    }

    if (changes.length === 0) {
      console.log(`${DIM}No snapshot data to rollback for this prompt.${RESET}`);
      return;
    }

    console.log(`${DIM}Processing ${changes.length} file(s)...${RESET}\n`);

    for (const change of changes) {
      const absPath = path.join(wsRoot, change.relativePath);

      if (change.type === "added") {
        let currentContent: string | undefined;
        try { currentContent = fs.readFileSync(absPath, "utf-8"); } catch {}
        if (currentContent === undefined) continue;
        if (currentContent === change.after) {
          fs.unlinkSync(absPath);
          console.log(`  ${RED}deleted${RESET} ${change.relativePath}`);
          reverted++;
        } else {
          console.log(`  ${YELLOW}CONFLICT${RESET} ${change.relativePath} — created by this prompt but later modified`);
          conflicts++;
        }
        continue;
      }

      if (change.type === "deleted") {
        if (fs.existsSync(absPath)) {
          console.log(`  ${YELLOW}CONFLICT${RESET} ${change.relativePath} — deleted by this prompt but recreated since`);
          conflicts++;
        } else {
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(absPath, change.before ?? "", "utf-8");
          console.log(`  ${GREEN}recreated${RESET} ${change.relativePath}`);
          reverted++;
        }
        continue;
      }

      // Modified file — selective revert
      let currentContent: string;
      try { currentContent = fs.readFileSync(absPath, "utf-8"); } catch {
        console.log(`  ${YELLOW}CONFLICT${RESET} ${change.relativePath} — file no longer exists`);
        conflicts++;
        continue;
      }

      const result = selectiveRevert(change.before ?? "", change.after ?? "", currentContent);
      if (result.applied > 0) {
        fs.writeFileSync(absPath, result.content, "utf-8");
        console.log(`  ${GREEN}reverted${RESET} ${change.relativePath} (${result.applied} hunk${result.applied === 1 ? "" : "s"})`);
        reverted++;
      }
      for (const c of result.conflicts) {
        console.log(`  ${YELLOW}CONFLICT${RESET} ${change.relativePath} — ${c.description}`);
        conflicts++;
      }
    }
  }

  console.log();
  if (reverted > 0 && conflicts === 0) {
    console.log(`${GREEN}${modeLabel} complete — ${reverted} file(s) reverted.${RESET}`);
  } else if (reverted > 0 && conflicts > 0) {
    console.log(`${YELLOW}Partial revert — ${reverted} file(s) reverted, ${conflicts} conflict(s).${RESET}`);
  } else if (conflicts > 0) {
    console.log(`${RED}Could not revert — all ${conflicts} file(s) have conflicts with later edits.${RESET}`);
  } else {
    console.log(`${DIM}No changes to revert.${RESET}`);
  }
}

function cmdSessions(flags: Flags): void {
  const wsRoot = getWorkspaceRoot();
  const reader = new SessionReader(wsRoot);
  const tasks = reader.readAllTasks();
  const filtered = filterTasks(tasks, flags);

  const sessions = new Map<string, { source: string; count: number; model?: string; latest: number }>();
  for (const t of filtered) {
    const key = t.sessionId || t.id;
    const existing = sessions.get(key);
    if (!existing) {
      sessions.set(key, { source: t.source || "unknown", count: 1, model: t.model, latest: t.createdAt });
    } else {
      existing.count++;
      if (t.createdAt > existing.latest) existing.latest = t.createdAt;
    }
  }

  if (sessions.size === 0) {
    console.log(`${DIM}No sessions found${flags.source || flags.model ? " matching filters" : ""}.${RESET}`);
    return;
  }

  console.log(`${BOLD}Sessions:${RESET}\n`);
  for (const [id, info] of sessions) {
    const color = info.source === "cursor" ? BLUE : info.source === "vscode" ? GREEN : MAGENTA;
    const model = info.model ? `${DIM}[${info.model.replace("claude-", "").replace("-thinking", "")}]${RESET}` : "";
    console.log(`  ${color}${info.source}${RESET}  ${id.slice(0, 8)}  ${info.count} prompts  ${DIM}${timeAgo(info.latest)}${RESET} ${model}`);
  }
}

function resolveTask(sorted: Task[], selector: string): Task | undefined {
  const num = parseInt(selector, 10);
  if (!isNaN(num) && num >= 0 && num < sorted.length) {
    return sorted[num];
  }
  const lower = selector.toLowerCase();
  return sorted.find((t) => t.prompt.toLowerCase().includes(lower));
}

function cmdExport(flags: Flags): void {
  const wsRoot = getWorkspaceRoot();
  console.log(`${BOLD}Exporting sessions from:${RESET} ${wsRoot}\n`);

  const data = exportSessions(wsRoot);
  const summary = exportSummary(data);
  console.log(summary);

  const totalSessions = data.claude.sessions.length + data.cursor.sessions.length;
  if (totalSessions === 0) {
    console.log(`\n${DIM}Nothing to export.${RESET}`);
    return;
  }

  const outFile = flags.positional[0] || "promptrail-export.json";
  const outPath = path.resolve(outFile);
  fs.writeFileSync(outPath, JSON.stringify(data), "utf-8");

  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`\n${GREEN}Exported to ${outPath} (${sizeKb} KB)${RESET}`);
}

function cmdMigrate(flags: Flags): void {
  const sourcePath = flags.positional[0];
  if (!sourcePath) {
    console.error(`${RED}Usage: promptrail migrate <source-workspace-path>${RESET}`);
    console.error(`${DIM}Example: promptrail migrate /path/to/old-project${RESET}`);
    process.exit(1);
  }

  const sourceWs = path.resolve(sourcePath);
  if (!fs.existsSync(sourceWs)) {
    console.error(`${RED}Source workspace not found: ${sourceWs}${RESET}`);
    process.exit(1);
  }

  const targetWs = getWorkspaceRoot();

  if (sourceWs === targetWs) {
    console.error(`${RED}Source and target workspace are the same.${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}Migrate sessions${RESET}`);
  console.log(`  ${DIM}from${RESET} ${CYAN}${sourceWs}${RESET}`);
  console.log(`  ${DIM}to${RESET}   ${CYAN}${targetWs}${RESET}\n`);

  // Export from source
  console.log(`${DIM}Reading source workspace...${RESET}`);
  const data = exportSessions(sourceWs);
  const summary = exportSummary(data);

  const totalSessions = data.claude.sessions.length + data.cursor.sessions.length;
  if (totalSessions === 0) {
    console.log(`\n${YELLOW}No sessions found in source workspace.${RESET}`);
    return;
  }

  console.log(summary);

  // Import into target
  console.log(`\n${DIM}Importing into target workspace...${RESET}\n`);
  const result = importSessions(targetWs, data);
  console.log(importSummary(result));
  console.log(`\n${GREEN}Migration complete.${RESET}`);
}

function cmdImport(flags: Flags): void {
  const inFile = flags.positional[0];
  if (!inFile) {
    console.error(`${RED}Usage: promptrail import <export-file.json>${RESET}`);
    process.exit(1);
  }

  const inPath = path.resolve(inFile);
  if (!fs.existsSync(inPath)) {
    console.error(`${RED}File not found: ${inPath}${RESET}`);
    process.exit(1);
  }

  let data: ExportData;
  try {
    data = JSON.parse(fs.readFileSync(inPath, "utf-8"));
  } catch {
    console.error(`${RED}Invalid export file.${RESET}`);
    process.exit(1);
  }

  if (data.version !== 1) {
    console.error(`${RED}Unsupported export version: ${data.version}${RESET}`);
    process.exit(1);
  }

  const wsRoot = getWorkspaceRoot();
  console.log(`${BOLD}Importing into:${RESET} ${wsRoot}`);
  console.log(`${DIM}Source workspace: ${data.sourceWorkspace}${RESET}`);

  if (data.sourceWorkspace === wsRoot) {
    console.log(`\n${YELLOW}Warning: source and target workspace are the same.${RESET}`);
    console.log(`${DIM}Existing sessions will be skipped.${RESET}`);
  }

  const summary = exportSummary(data);
  console.log(`\n${BOLD}Export contents:${RESET}`);
  console.log(summary);

  console.log(`\n${BOLD}Importing...${RESET}\n`);
  const result = importSessions(wsRoot, data);
  console.log(importSummary(result));
  console.log(`\n${GREEN}Import complete.${RESET}`);
}

function printHelp(): void {
  console.log(`
${BOLD}Promptrail${RESET} — prompt-level version control for AI code editing

${BOLD}Usage:${RESET}
  promptrail timeline [--files]     Show all prompts with file change counts
  promptrail diff <n|text>          Show diff for prompt #n or matching text
  promptrail rollback <n|text>      Cherry revert (undo only this prompt's changes)
  promptrail rollback <n|text> --hard  Restore files (restore to pre-prompt state)
  promptrail sessions               List all sessions
  promptrail migrate <source-path>   Migrate all sessions from another workspace
  promptrail export [output.json]   Export all sessions to a portable file
  promptrail import <file.json>     Import sessions from an export file

${BOLD}Filters (work with timeline, sessions, diff):${RESET}
  --source, -s <claude|cursor>     Filter by source
  --model, -m <substring>          Filter by model (substring match)

${BOLD}Examples:${RESET}
  promptrail timeline               List all prompts
  promptrail timeline --files       Include file lists
  promptrail timeline -s claude     Only Claude Code prompts
  promptrail timeline -m sonnet     Only prompts using sonnet models
  promptrail timeline -s cursor -m gpt  Cursor prompts with gpt models
  promptrail diff 3                 Diff for prompt #3
  promptrail diff "refactor auth"   Diff for prompt matching text
  promptrail sessions -s claude     Only Claude Code sessions
  promptrail rollback 5             Cherry revert prompt #5
  promptrail rollback 5 --hard      Restore files for prompt #5 (overwrites later changes)
  promptrail migrate ../old-project  Migrate sessions from old workspace
  promptrail export                 Export to promptrail-export.json
  promptrail export my-backup.json  Export to custom file
  promptrail import backup.json     Import into current workspace

${DIM}Run from your project root directory.${RESET}
`);
}

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const flags = parseFlags(rawArgs.slice(1));

switch (command) {
  case "timeline":
  case "tl":
    cmdTimeline(flags);
    break;
  case "diff":
  case "d": {
    const selector = flags.positional[0];
    if (!selector) {
      console.error(`${RED}Usage: promptrail diff <prompt-number|text> [--source claude|cursor] [--model <name>]${RESET}`);
      process.exit(1);
    }
    cmdDiff(selector, flags);
    break;
  }
  case "rollback":
  case "rb":
    if (!flags.positional[0]) {
      console.error(`${RED}Usage: promptrail rollback <prompt-number|text> [--hard]${RESET}`);
      process.exit(1);
    }
    cmdRollback(flags.positional[0], flags.hard);
    break;
  case "sessions":
  case "s":
    cmdSessions(flags);
    break;
  case "migrate":
  case "mg":
    cmdMigrate(flags);
    break;
  case "export":
  case "e":
    cmdExport(flags);
    break;
  case "import":
  case "i":
    cmdImport(flags);
    break;
  case "--version":
  case "-v": {
    const pkg = require("../../package.json");
    console.log(pkg.version);
    break;
  }
  case "--help":
  case "-h":
  case undefined:
    printHelp();
    break;
  default:
    console.error(`${RED}Unknown command: ${command}${RESET}`);
    printHelp();
    process.exit(1);
}
