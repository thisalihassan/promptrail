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
  revertStringEdits,
} from "../core/selective-revert";
import { ensureCursorHooks } from "../core/ensure-hooks";
import { ensureSkillAndRule } from "../core/ensure-skill-rule";

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
  last?: number;
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
    } else if ((args[i] === "--last" || args[i] === "-n") && args[i + 1]) {
      flags.last = parseInt(args[++i], 10) || undefined;
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

function cmdTimeline(flags: Flags): void {
  const wsRoot = getWorkspaceRoot();
  const reader = new SessionReader(wsRoot);
  const tasks = reader.readAllTasks();

  const filtered = filterTasks(tasks, flags);
  if (filtered.length === 0) {
    console.log(`${DIM}No sessions found${flags.source || flags.model ? " matching filters" : " for this workspace"}.${RESET}`);
    return;
  }

  const chronological = [...filtered].sort((a, b) => a.createdAt - b.createdAt);
  const allSorted = [...chronological].reverse();
  const limited = flags.last ? allSorted.slice(0, flags.last) : allSorted;
  const sorted = limited;

  console.log();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const chronIdx = chronological.indexOf(t);
    const src = t.source || "unknown";
    const srcLabel = src === "cursor" ? `${BLUE}cursor${RESET}` : src === "claude" ? `${MAGENTA}claude${RESET}` : src === "vscode" ? `${GREEN}vscode${RESET}` : `${DIM}${src}${RESET}`;

    const files = t.filesChanged;
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

  const total = allSorted.length;
  if (flags.last && total > sorted.length) {
    console.log(`\n${DIM}Showing ${sorted.length} of ${total} prompts (drop -n to see all)${RESET}`);
  } else {
    console.log(`\n${DIM}${total} prompts total${RESET}`);
  }
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

  let changes: FileChange[] = [];

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

function cmdRollback(selector: string): void {
  const wsRoot = getWorkspaceRoot();
  const reader = new SessionReader(wsRoot);
  const tasks = reader.readAllTasks();
  const sorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt);

  const task = resolveTask(sorted, selector);
  if (!task) {
    console.error(`${RED}No task matching "${selector}"${RESET}`);
    process.exit(1);
  }

  console.log(`${BOLD}Cherry revert:${RESET} ${truncate(task.prompt, 70)}`);

  let reverted = 0;
  let conflicts = 0;

  const te = task as TaskWithEdits;
  const hasEdits = (te.edits && te.edits.length > 0) || (te.writes && te.writes.length > 0);

  if (!hasEdits) {
    console.log(`${DIM}No edit data available for this prompt. Rollback requires Cursor hooks or Claude/VS Code edit records.${RESET}`);
    if (task.source === "cursor") {
      console.log(`${DIM}Run \`promptrail init\` to install hooks for future sessions.${RESET}`);
    }
    return;
  }

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

  console.log();
  if (reverted > 0 && conflicts === 0) {
    console.log(`${GREEN}Cherry revert complete — ${reverted} file(s) reverted.${RESET}`);
  } else if (reverted > 0 && conflicts > 0) {
    console.log(`${YELLOW}Partial revert — ${reverted} file(s) reverted, ${conflicts} conflict(s).${RESET}`);
  } else if (conflicts > 0) {
    console.log(`${RED}Could not revert — all ${conflicts} file(s) have conflicts with later edits.${RESET}`);
  } else {
    console.log(`${DIM}No changes to revert.${RESET}`);
  }
}

function cmdResponse(selector: string, flags: Flags = { positional: [] }): void {
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

  if (task.source === "cursor") {
    const parts = task.id.split("-");
    const userIndex = parseInt(parts[parts.length - 1], 10);
    const shortId = parts.slice(1, -1).join("-");

    const db = reader.getPromptRailDB();
    const fullComposerId = db.findComposerIdByPrefix(shortId);
    if (!fullComposerId) {
      console.log(`${DIM}No response data available for this prompt.${RESET}`);
      return;
    }

    // Try hook responses first (from Cursor hooks)
    const te = task as TaskWithEdits;
    let hookResp: string | undefined;
    if (te.generationId) {
      hookResp = reader.getHookResponse(fullComposerId, te.generationId);
    } else {
      const genId = reader.getHookGenerationId(fullComposerId, userIndex);
      if (genId) {
        hookResp = reader.getHookResponse(fullComposerId, genId);
      }
    }

    if (hookResp) {
      console.log(`${BOLD}Response for #${idx}:${RESET} ${truncate(task.prompt, 70)}`);
      console.log(`${DIM}${timeAgo(task.createdAt)} | ${task.source}${RESET}\n`);
      console.log(hookResp);
      return;
    }

    // Fall back to shadow DB assistant bubbles
    const bubbles = db.getAssistantBubbles(fullComposerId);
    const forPrompt = bubbles.filter((b: any) => b.userIndex === userIndex);

    if (forPrompt.length === 0) {
      console.log(`${DIM}No response data available for this prompt.${RESET}`);
      console.log(`${DIM}The shadow DB must snapshot the session while Cursor still has the bubble data.${RESET}`);
      return;
    }

    console.log(`${BOLD}Response for #${idx}:${RESET} ${truncate(task.prompt, 70)}`);
    console.log(`${DIM}${timeAgo(task.createdAt)} | ${task.source} | ${forPrompt.length} bubble(s)${RESET}\n`);

    for (const b of forPrompt) {
      if (b.toolName) {
        console.log(`  ${CYAN}[${b.toolName}]${RESET} ${DIM}${b.toolStatus || ""}${RESET}`);
      }
      if (b.text) {
        console.log(`${b.text}\n`);
      }
    }
    return;
  }

  if (task.source === "claude") {
    const parts = task.id.split("-");
    const promptIndex = parseInt(parts[parts.length - 1], 10);
    const sessionId = task.sessionId || parts.slice(1, -1).join("-");

    const responseText = reader.getClaudeResponse(sessionId, promptIndex);
    if (!responseText) {
      console.log(`${DIM}No response data available for this prompt.${RESET}`);
      return;
    }

    console.log(`${BOLD}Response for #${idx}:${RESET} ${truncate(task.prompt, 70)}`);
    console.log(`${DIM}${timeAgo(task.createdAt)} | ${task.source}${RESET}\n`);
    console.log(responseText);
    return;
  }

  console.log(`${DIM}Response viewing is not yet supported for ${task.source} sessions.${RESET}`);
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

function cmdSearch(query: string, flags: Flags): void {
  const wsRoot = getWorkspaceRoot();
  const reader = new SessionReader(wsRoot);
  const allTasks = reader.readAllTasks();
  const filtered = filterTasks(allTasks, flags);

  // Build chronological index so we can show #N for each hit
  const chronological = [...allTasks].sort((a, b) => a.createdAt - b.createdAt);
  const idToChronIdx = new Map<string, number>();
  for (let i = 0; i < chronological.length; i++) {
    idToChronIdx.set(chronological[i].id, i);
  }

  interface SearchHit {
    chronIdx?: number;
    source: string;
    promptText: string;
    model: string;
    createdAt: number;
    filesCount: number;
    promptSnippet?: string;
    responseSnippet?: string;
    fileSnippet?: string;
  }

  const hits: SearchHit[] = [];

  // FTS5 search for Cursor sessions (indexed in shadow DB)
  const db = reader.getPromptRailDB();
  if (db.isFtsAvailable() && (!flags.source || flags.source === "cursor")) {
    const results = db.search(query, { source: flags.source, model: flags.model });
    const seen = new Set<string>();
    for (const r of results) {
      const key = `${r.composerId}:${r.userIndex}`;
      const existing = hits.find((h) => h.promptText === r.promptText && h.createdAt === r.createdAt);
      if (existing) {
        if (r.type === "prompt") existing.promptSnippet = r.snippet;
        else existing.responseSnippet = r.snippet;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const taskId = `cur-${r.composerId.slice(0, 8)}-${r.userIndex}`;
      const idx = idToChronIdx.get(taskId);
      const task = idx !== undefined ? chronological[idx] : undefined;
      hits.push({
        chronIdx: idx,
        source: "cursor",
        promptText: r.promptText,
        model: r.model,
        createdAt: r.createdAt,
        filesCount: task?.filesChanged.length || 0,
        promptSnippet: r.type === "prompt" ? r.snippet : undefined,
        responseSnippet: r.type === "response" ? r.snippet : undefined,
      });
    }
  }

  // Direct text + file search for all tasks
  const lower = query.toLowerCase();
  const hitIds = new Set(hits.map((h) => `${h.createdAt}:${h.source}`));

  for (const t of filtered) {
    const chronIdx = idToChronIdx.get(t.id);
    const alreadyHit = hitIds.has(`${t.createdAt}:${t.source || "unknown"}`);

    const promptMatch = t.prompt.toLowerCase().includes(lower);
    const matchedFiles = t.filesChanged.filter((f) => f.toLowerCase().includes(lower));
    const fileMatch = matchedFiles.length > 0;

    if (!promptMatch && !fileMatch) continue;
    if (alreadyHit && !fileMatch) continue;

    // If already in hits from FTS but also matched files, add file snippet
    if (alreadyHit && fileMatch) {
      const existing = hits.find((h) => h.chronIdx === chronIdx);
      if (existing) {
        existing.fileSnippet = matchedFiles.join(", ");
      }
      continue;
    }

    let promptSnippet: string | undefined;
    if (promptMatch) {
      const matchIdx = t.prompt.toLowerCase().indexOf(lower);
      const start = Math.max(0, matchIdx - 30);
      const end = Math.min(t.prompt.length, matchIdx + query.length + 30);
      promptSnippet =
        (start > 0 ? "..." : "") +
        t.prompt.slice(start, matchIdx) +
        ">>>" + t.prompt.slice(matchIdx, matchIdx + query.length) + "<<<" +
        t.prompt.slice(matchIdx + query.length, end) +
        (end < t.prompt.length ? "..." : "");
    }

    hits.push({
      chronIdx,
      source: t.source || "unknown",
      promptText: t.prompt,
      model: t.model || "",
      createdAt: t.createdAt,
      filesCount: t.filesChanged.length,
      promptSnippet,
      fileSnippet: fileMatch ? matchedFiles.join(", ") : undefined,
    });
  }

  if (hits.length === 0) {
    console.log(`${DIM}No results for "${query}"${flags.source || flags.model ? " with current filters" : ""}.${RESET}`);
    return;
  }

  hits.sort((a, b) => b.createdAt - a.createdAt);

  console.log(`\n${BOLD}Search: "${query}"${RESET}  ${DIM}${hits.length} result(s)${RESET}\n`);

  for (const g of hits) {
    const srcLabel = g.source === "cursor" ? `${BLUE}cursor${RESET}` : g.source === "claude" ? `${MAGENTA}claude${RESET}` : g.source === "vscode" ? `${GREEN}vscode${RESET}` : `${DIM}${g.source}${RESET}`;
    const model = g.model ? `${DIM}[${g.model.replace("claude-", "").replace("-thinking", "")}]${RESET}` : "";
    const time = `${DIM}${timeAgo(g.createdAt)}${RESET}`;
    const prompt = truncate(g.promptText, 60);
    const idx = g.chronIdx !== undefined ? `${DIM}#${g.chronIdx}${RESET}` : `${DIM}#?${RESET}`;
    const fileCount = g.filesCount > 0
      ? `${GREEN}${g.filesCount} file${g.filesCount === 1 ? "" : "s"}${RESET}`
      : `${DIM}no changes${RESET}`;

    console.log(`  ${idx} ${srcLabel} ${prompt}  ${fileCount}  ${time} ${model}`);

    if (g.promptSnippet) {
      const highlighted = g.promptSnippet
        .replace(/>>>/g, YELLOW).replace(/<<</g, RESET)
        .replace(/\n/g, " ");
      console.log(`    ${DIM}prompt:${RESET} ${highlighted}`);
    }
    if (g.responseSnippet) {
      const highlighted = g.responseSnippet
        .replace(/>>>/g, YELLOW).replace(/<<</g, RESET)
        .replace(/\n/g, " ");
      console.log(`    ${DIM}response:${RESET} ${highlighted}`);
    }
    if (g.fileSnippet) {
      console.log(`    ${DIM}files:${RESET} ${CYAN}${g.fileSnippet}${RESET}`);
    }
  }

  console.log(`\n${DIM}Use: promptrail diff <#>  or  promptrail rollback <#>${RESET}`);
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

function cmdInit(): void {
  const wsRoot = getWorkspaceRoot();
  const hooksCreated = ensureCursorHooks(wsRoot);
  if (hooksCreated) {
    console.log(`${GREEN}Cursor hooks installed:${RESET}`);
    console.log(`  ${DIM}.cursor/hooks/promptrail-hook.js${RESET}`);
    console.log(`  ${DIM}.cursor/hooks.json${RESET}`);
    console.log(`\n${DIM}Hook events: afterFileEdit, beforeSubmitPrompt, afterAgentResponse, stop${RESET}`);
    console.log(`${DIM}Edit data will be captured per-prompt for rollback + diff.${RESET}`);
  } else {
    console.log(`${DIM}Cursor hooks already configured.${RESET}`);
  }

  const sr = ensureSkillAndRule(wsRoot);
  if (sr.globalSkillCreated) {
    console.log(`\n${GREEN}Global agent skill installed:${RESET}`);
    console.log(`  ${DIM}~/.cursor/skills/promptrail/SKILL.md${RESET}`);
  }
  if (sr.projectRuleCreated) {
    console.log(`${GREEN}Project rule installed:${RESET}`);
    console.log(`  ${DIM}.cursor/rules/use-promptrail.mdc${RESET}`);
  }
  if (!sr.globalSkillCreated && !sr.projectRuleCreated) {
    console.log(`${DIM}Agent skill and rule already configured.${RESET}`);
  }
}

function printHelp(): void {
  console.log(`
${BOLD}Promptrail${RESET} — prompt-level version control for AI code editing

${BOLD}Usage:${RESET}
  promptrail init                    Install Cursor hooks for per-prompt tracking
  promptrail timeline [--files]     Show all prompts with file change counts
  promptrail timeline -n 20         Show only the last 20 prompts
  promptrail diff <n|text>          Show diff for prompt #n or matching text
  promptrail response <n|text>      Show AI response for prompt #n or matching text
  promptrail rollback <n|text>      Cherry revert (undo only this prompt's changes)
  promptrail rollback <n|text>         Cherry revert using edit data (hooks/Claude/VSCode)
  promptrail search <query>          Search prompts and responses (FTS5)
  promptrail sessions               List all sessions
  promptrail migrate <source-path>   Migrate all sessions from another workspace
  promptrail export [output.json]   Export all sessions to a portable file
  promptrail import <file.json>     Import sessions from an export file

${BOLD}Filters (work with timeline, sessions, diff):${RESET}
  --source, -s <claude|cursor>     Filter by source
  --model, -m <substring>          Filter by model (substring match)
  --last, -n <count>               Show only the last N prompts

${BOLD}Examples:${RESET}
  promptrail init                    Install Cursor hooks (auto-runs on first use)
  promptrail timeline               List all prompts
  promptrail timeline -n 10         Last 10 prompts
  promptrail timeline --files       Include file lists
  promptrail timeline -s claude     Only Claude Code prompts
  promptrail timeline -m sonnet     Only prompts using sonnet models
  promptrail timeline -s cursor -m gpt  Cursor prompts with gpt models
  promptrail diff 3                 Diff for prompt #3
  promptrail diff "refactor auth"   Diff for prompt matching text
  promptrail response 3             Show AI response for prompt #3
  promptrail search "shadow DB"     Search prompts and responses
  promptrail search "auth" -m sonnet  Search with model filter
  promptrail sessions -s claude     Only Claude Code sessions
  promptrail rollback 5             Cherry revert prompt #5
  promptrail rollback 5             Cherry revert prompt #5 using exact edit reversal
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

// Auto-provision Cursor hooks, global skill, and project rule on first use (silent, non-blocking)
if (command && command !== "init" && command !== "--help" && command !== "-h" && command !== "--version" && command !== "-v") {
  try { ensureCursorHooks(getWorkspaceRoot()); } catch {}
  try { ensureSkillAndRule(getWorkspaceRoot()); } catch {}
}

switch (command) {
  case "init":
    cmdInit();
    break;
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
  case "response":
  case "r": {
    const sel = flags.positional[0];
    if (!sel) {
      console.error(`${RED}Usage: promptrail response <prompt-number|text> [--source cursor] [--model <name>]${RESET}`);
      process.exit(1);
    }
    cmdResponse(sel, flags);
    break;
  }
  case "search": {
    const q = flags.positional.join(" ");
    if (!q) {
      console.error(`${RED}Usage: promptrail search <query> [--source cursor] [--model <name>]${RESET}`);
      process.exit(1);
    }
    cmdSearch(q, flags);
    break;
  }
  case "rollback":
  case "rb":
    if (!flags.positional[0]) {
      console.error(`${RED}Usage: promptrail rollback <prompt-number|text>${RESET}`);
      process.exit(1);
    }
    cmdRollback(flags.positional[0]);
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
