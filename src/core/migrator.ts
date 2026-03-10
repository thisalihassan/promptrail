/**
 * Export/Import session data between workspaces.
 *
 * Handles:
 *   Claude Code  – JSONL session files + subagent directories
 *   Cursor       – JSONL transcripts + SQLite metadata (composerData, bubbles, checkpoints, codeBlocks)
 *   Snapshots    – .promptrail/snapshots/changes.json
 *
 * On import, all embedded workspace paths are rewritten from source → target.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Types ─────────────────────────────────────────────────────

export interface ExportData {
  version: 1;
  exportedAt: number;
  sourceWorkspace: string;
  claude: {
    sessions: ClaudeSessionExport[];
  };
  cursor: {
    sessions: CursorSessionExport[];
  };
  snapshots: {
    changes: any[] | null;
  };
}

interface ClaudeSessionExport {
  id: string;
  jsonl: string;
  subagents: Record<string, string>; // relative path → content
}

interface CursorSessionExport {
  composerId: string;
  transcript: string;
  subagents: Record<string, string>;
  sqlite: {
    composerData: any | null;
    bubbles: KVEntry[];
    checkpoints: KVEntry[];
    codeBlocks: KVEntry[];
  };
}

interface KVEntry {
  key: string;
  value: string; // raw JSON string
}

// ── Paths ─────────────────────────────────────────────────────

function getClaudeProjectDir(wsRoot: string): string | undefined {
  const encoded = wsRoot.replace(/\//g, "-");
  const base = path.join(os.homedir(), ".claude", "projects");
  for (const variant of [encoded, encoded.replace(/^-/, "")]) {
    const dir = path.join(base, variant);
    if (fs.existsSync(dir)) return dir;
  }
  return undefined;
}

function getClaudeTargetDir(wsRoot: string): string {
  const encoded = wsRoot.replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded);
}

function getCursorTranscriptsDir(wsRoot: string): string | undefined {
  const encoded = wsRoot.replace(/\//g, "-").replace(/^-/, "");
  const base = path.join(os.homedir(), ".cursor", "projects");
  const dir = path.join(base, encoded, "agent-transcripts");
  if (fs.existsSync(dir)) return dir;

  if (!fs.existsSync(base)) return undefined;
  for (const entry of fs.readdirSync(base)) {
    if (entry.toLowerCase() === encoded.toLowerCase()) {
      const d = path.join(base, entry, "agent-transcripts");
      if (fs.existsSync(d)) return d;
    }
  }
  return undefined;
}

function getCursorTargetDir(wsRoot: string): string {
  const encoded = wsRoot.replace(/\//g, "-").replace(/^-/, "");
  return path.join(
    os.homedir(),
    ".cursor",
    "projects",
    encoded,
    "agent-transcripts"
  );
}

function getCursorDbPath(): string {
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA ||
          path.join(os.homedir(), "AppData", "Roaming"),
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      );
    case "linux":
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      );
    default:
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      );
  }
}

// ── SQLite helpers ────────────────────────────────────────────

let DatabaseSync: any;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

function withDbRead<T>(fn: (db: any) => T): T | undefined {
  const dbPath = getCursorDbPath();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return undefined;
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    return fn(db);
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch {}
  }
}

function withDbWrite<T>(fn: (db: any) => T): T | undefined {
  const dbPath = getCursorDbPath();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return undefined;
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { open: true });
    return fn(db);
  } catch (e: any) {
    console.error(`  SQLite error: ${e?.message || e}`);
    return undefined;
  } finally {
    try { db?.close(); } catch {}
  }
}

// ── Export ─────────────────────────────────────────────────────

export function exportSessions(wsRoot: string): ExportData {
  const data: ExportData = {
    version: 1,
    exportedAt: Date.now(),
    sourceWorkspace: wsRoot,
    claude: { sessions: [] },
    cursor: { sessions: [] },
    snapshots: { changes: null },
  };

  // Claude sessions
  const claudeDir = getClaudeProjectDir(wsRoot);
  if (claudeDir) {
    const files = fs.readdirSync(claudeDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const jsonl = fs.readFileSync(path.join(claudeDir, file), "utf-8");
      const subagents: Record<string, string> = {};

      const subDir = path.join(claudeDir, sessionId, "subagents");
      if (fs.existsSync(subDir)) {
        for (const sf of fs.readdirSync(subDir)) {
          subagents[sf] = fs.readFileSync(path.join(subDir, sf), "utf-8");
        }
      }

      // Also grab tool-results if present
      const toolDir = path.join(claudeDir, sessionId, "tool-results");
      if (fs.existsSync(toolDir)) {
        for (const tf of fs.readdirSync(toolDir)) {
          subagents[`tool-results/${tf}`] = fs.readFileSync(
            path.join(toolDir, tf),
            "utf-8"
          );
        }
      }

      data.claude.sessions.push({ id: sessionId, jsonl, subagents });
    }
  }

  // Cursor sessions
  const cursorDir = getCursorTranscriptsDir(wsRoot);
  if (cursorDir) {
    for (const entry of fs.readdirSync(cursorDir)) {
      const transcriptDir = path.join(cursorDir, entry);
      try {
        if (!fs.statSync(transcriptDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const jsonlFile = path.join(transcriptDir, `${entry}.jsonl`);
      if (!fs.existsSync(jsonlFile)) continue;

      const composerId = entry;
      const transcript = fs.readFileSync(jsonlFile, "utf-8");
      const subagents: Record<string, string> = {};

      const subDir = path.join(transcriptDir, "subagents");
      if (fs.existsSync(subDir)) {
        for (const sf of fs.readdirSync(subDir)) {
          subagents[sf] = fs.readFileSync(path.join(subDir, sf), "utf-8");
        }
      }

      // Read SQLite data
      const sqlite = readCursorSqliteData(composerId);

      data.cursor.sessions.push({
        composerId,
        transcript,
        subagents,
        sqlite,
      });
    }
  }

  // Snapshots
  const changesFile = path.join(wsRoot, ".promptrail", "snapshots", "changes.json");
  if (fs.existsSync(changesFile)) {
    try {
      data.snapshots.changes = JSON.parse(
        fs.readFileSync(changesFile, "utf-8")
      );
    } catch {}
  }

  return data;
}

function readCursorSqliteData(
  composerId: string
): CursorSessionExport["sqlite"] {
  const empty: CursorSessionExport["sqlite"] = {
    composerData: null,
    bubbles: [],
    checkpoints: [],
    codeBlocks: [],
  };

  return (
    withDbRead((db) => {
      const result = { ...empty };

      // composerData
      const cdRow = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${composerId}`);
      if (cdRow) {
        result.composerData = JSON.parse(cdRow.value);
      }

      // bubbles
      const bubbleRows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
        .all(`bubbleId:${composerId}:%`);
      for (const row of bubbleRows) {
        result.bubbles.push({ key: row.key, value: row.value });
      }

      // checkpoints
      const ckptRows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
        .all(`checkpointId:${composerId}:%`);
      for (const row of ckptRows) {
        result.checkpoints.push({ key: row.key, value: row.value });
      }

      // codeBlocks
      const cbRows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
        .all(`codeBlockPartialInlineDiffFates:${composerId}:%`);
      for (const row of cbRows) {
        result.codeBlocks.push({ key: row.key, value: row.value });
      }

      return result;
    }) ?? empty
  );
}

// ── Import ────────────────────────────────────────────────────

export interface ImportResult {
  claude: { imported: number; skipped: number };
  cursor: {
    transcripts: { imported: number; skipped: number };
    sqliteEntries: { written: number; skipped: number; failed: boolean };
  };
  snapshots: { imported: boolean };
}

export function importSessions(
  wsRoot: string,
  data: ExportData
): ImportResult {
  const sourceWs = data.sourceWorkspace;
  const result: ImportResult = {
    claude: { imported: 0, skipped: 0 },
    cursor: {
      transcripts: { imported: 0, skipped: 0 },
      sqliteEntries: { written: 0, skipped: 0, failed: false },
    },
    snapshots: { imported: false },
  };

  // ── Claude ──
  const claudeTarget = getClaudeTargetDir(wsRoot);
  fs.mkdirSync(claudeTarget, { recursive: true });

  for (const session of data.claude.sessions) {
    const targetFile = path.join(claudeTarget, `${session.id}.jsonl`);

    if (fs.existsSync(targetFile)) {
      result.claude.skipped++;
      continue;
    }

    // Rewrite workspace paths in JSONL content
    const rewritten = rewritePaths(session.jsonl, sourceWs, wsRoot);
    fs.writeFileSync(targetFile, rewritten, "utf-8");

    // Write subagents/tool-results
    for (const [relPath, content] of Object.entries(session.subagents)) {
      const targetPath = path.join(claudeTarget, session.id, relPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(
        targetPath,
        rewritePaths(content, sourceWs, wsRoot),
        "utf-8"
      );
    }

    result.claude.imported++;
  }

  // ── Cursor transcripts + SQLite ──
  // Each imported session gets a NEW composer ID so it exists independently
  // in the target workspace without conflicting with the original.
  const cursorTarget = getCursorTargetDir(wsRoot);
  fs.mkdirSync(cursorTarget, { recursive: true });

  for (const session of data.cursor.sessions) {
    const oldId = session.composerId;
    const newId = crypto.randomUUID();

    // Write transcript with new ID
    const targetDir = path.join(cursorTarget, newId);
    const targetFile = path.join(targetDir, `${newId}.jsonl`);

    fs.mkdirSync(targetDir, { recursive: true });
    let rewritten = rewritePaths(session.transcript, sourceWs, wsRoot);
    rewritten = rewritten.split(oldId).join(newId);
    fs.writeFileSync(targetFile, rewritten, "utf-8");

    for (const [relPath, content] of Object.entries(session.subagents)) {
      const subPath = path.join(targetDir, "subagents", relPath);
      fs.mkdirSync(path.dirname(subPath), { recursive: true });
      let subContent = rewritePaths(content, sourceWs, wsRoot);
      subContent = subContent.split(oldId).join(newId);
      fs.writeFileSync(subPath, subContent, "utf-8");
    }

    result.cursor.transcripts.imported++;

    // Write SQLite data with remapped composer ID
    if (session.sqlite.composerData) {
      const sqlResult = writeCursorSqliteData(
        session,
        oldId,
        newId,
        sourceWs,
        wsRoot
      );
      result.cursor.sqliteEntries.written += sqlResult.written;
      result.cursor.sqliteEntries.skipped += sqlResult.skipped;
      if (sqlResult.failed) result.cursor.sqliteEntries.failed = true;

      // Register in workspace-level composer list so Cursor shows the chat
      if (!sqlResult.failed) {
        registerComposerInWorkspace(wsRoot, newId, session.sqlite.composerData);
      }
    }
  }

  // ── Snapshots ──
  if (data.snapshots.changes && data.snapshots.changes.length > 0) {
    const snapshotsDir = path.join(wsRoot, ".promptrail", "snapshots");
    const changesFile = path.join(snapshotsDir, "changes.json");

    let existing: any[] = [];
    if (fs.existsSync(changesFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(changesFile, "utf-8"));
      } catch {}
    }

    // Merge: add only changes not already present (by timestamp dedup)
    const existingTimestamps = new Set(existing.map((c: any) => c.timestamp));
    const newChanges = data.snapshots.changes.filter(
      (c: any) => !existingTimestamps.has(c.timestamp)
    );

    if (newChanges.length > 0) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
      const merged = [...existing, ...newChanges].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      fs.writeFileSync(changesFile, JSON.stringify(merged), "utf-8");
      result.snapshots.imported = true;
    }
  }

  return result;
}

function writeCursorSqliteData(
  session: CursorSessionExport,
  oldId: string,
  newId: string,
  sourceWs: string,
  targetWs: string
): { written: number; skipped: number; failed: boolean } {
  const stats = { written: 0, skipped: 0, failed: false };

  function remapKey(key: string): string {
    return key.split(oldId).join(newId);
  }

  function remapValue(value: string): string {
    let v = rewritePaths(value, sourceWs, targetWs);
    v = v.split(oldId).join(newId);
    return v;
  }

  const dbResult = withDbWrite((db) => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO cursorDiskKV (key, value) VALUES (?, ?)"
    );

    // composerData — rewrite paths + composer ID
    const cdKey = `composerData:${newId}`;
    const cdValue = remapValue(JSON.stringify(session.sqlite.composerData));
    insert.run(cdKey, cdValue);
    stats.written++;

    // bubbles — remap keys and rewrite paths
    for (const entry of session.sqlite.bubbles) {
      const newKey = remapKey(entry.key);
      const newValue = remapValue(entry.value);
      insert.run(newKey, newValue);
      stats.written++;
    }

    // checkpoints — remap keys only
    for (const entry of session.sqlite.checkpoints) {
      const newKey = remapKey(entry.key);
      insert.run(newKey, entry.value);
      stats.written++;
    }

    // codeBlocks — remap keys only
    for (const entry of session.sqlite.codeBlocks) {
      const newKey = remapKey(entry.key);
      insert.run(newKey, entry.value);
      stats.written++;
    }

    return true;
  });

  if (dbResult === undefined) {
    stats.failed = true;
  }

  return stats;
}

// ── Workspace-level composer registration ─────────────────────

function getWorkspaceStorageDir(wsRoot: string): string | undefined {
  const base = (() => {
    switch (process.platform) {
      case "win32":
        return path.join(
          process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "Cursor",
          "User",
          "workspaceStorage"
        );
      case "linux":
        return path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "Cursor",
          "User",
          "workspaceStorage"
        );
      default:
        return path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Cursor",
          "User",
          "workspaceStorage"
        );
    }
  })();

  if (!fs.existsSync(base)) return undefined;

  const targetUri = `file://${wsRoot}`;

  for (const entry of fs.readdirSync(base)) {
    const wsJson = path.join(base, entry, "workspace.json");
    try {
      const data = JSON.parse(fs.readFileSync(wsJson, "utf-8"));
      if (data.folder === targetUri) {
        return path.join(base, entry);
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function registerComposerInWorkspace(
  wsRoot: string,
  newComposerId: string,
  composerData: any
): void {
  const wsDir = getWorkspaceStorageDir(wsRoot);
  if (!wsDir) return;

  const dbPath = path.join(wsDir, "state.vscdb");
  if (!DatabaseSync || !fs.existsSync(dbPath)) return;

  let db: any;
  try {
    db = new DatabaseSync(dbPath, { open: true });

    // Read existing composer.composerData
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("composer.composerData");

    let wsData: any = {
      allComposers: [],
      selectedComposerIds: [],
      lastFocusedComposerIds: [],
      hasMigratedComposerData: true,
      hasMigratedMultipleComposers: true,
    };

    if (row) {
      wsData = JSON.parse(row.value);
    }

    // Check if already registered
    const existing = wsData.allComposers || [];
    if (existing.some((c: any) => c.composerId === newComposerId)) return;

    // Build a minimal composer entry for the list
    const entry = {
      type: "head",
      composerId: newComposerId,
      name: composerData.name || "",
      lastUpdatedAt: composerData.lastUpdatedAt || Date.now(),
      createdAt: composerData.createdAt || Date.now(),
      unifiedMode: composerData.unifiedMode || "agent",
      forceMode: composerData.forceMode || "",
      hasUnreadMessages: false,
      contextUsagePercent: composerData.contextUsagePercent || 0,
      totalLinesAdded: composerData.totalLinesAdded || 0,
      totalLinesRemoved: composerData.totalLinesRemoved || 0,
      filesChangedCount: composerData.filesChangedCount || 0,
      subtitle: composerData.subtitle || "",
      isArchived: false,
      isDraft: false,
      isProject: false,
      isSpec: false,
      isBestOfNSubcomposer: false,
      isWorktree: false,
      worktreeStartedReadOnly: false,
      hasBlockingPendingActions: false,
      numSubComposers: 0,
      branches: [],
      referencedPlans: [],
    };

    wsData.allComposers.push(entry);

    // Write back
    if (row) {
      db
        .prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
        .run(JSON.stringify(wsData), "composer.composerData");
    } else {
      db
        .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
        .run("composer.composerData", JSON.stringify(wsData));
    }
  } catch (e: any) {
    // Non-fatal — chat data is still in global DB, just won't show in sidebar
  } finally {
    try { db?.close(); } catch {}
  }
}

// ── Path rewriting ────────────────────────────────────────────

function rewritePaths(
  content: string,
  sourceWs: string,
  targetWs: string
): string {
  if (sourceWs === targetWs) return content;

  // Replace file:// URIs
  const sourceUri = `file://${sourceWs}`;
  const targetUri = `file://${targetWs}`;

  // Replace both URI-encoded and plain paths
  let result = content;
  result = result.split(sourceUri).join(targetUri);
  result = result.split(sourceWs).join(targetWs);

  // Handle URI-encoded paths (spaces → %20, etc.)
  const sourceEncoded = sourceWs.replace(/ /g, "%20");
  const targetEncoded = targetWs.replace(/ /g, "%20");
  if (sourceEncoded !== sourceWs) {
    result = result.split(sourceEncoded).join(targetEncoded);
  }

  return result;
}

// ── Summary helpers ───────────────────────────────────────────

export function exportSummary(data: ExportData): string {
  const lines: string[] = [];
  lines.push(`Source: ${data.sourceWorkspace}`);
  lines.push(`Claude sessions: ${data.claude.sessions.length}`);
  for (const s of data.claude.sessions) {
    const subs = Object.keys(s.subagents).length;
    const size = (s.jsonl.length / 1024).toFixed(0);
    lines.push(`  ${s.id.slice(0, 8)}  ${size} KB${subs > 0 ? `  +${subs} subagent files` : ""}`);
  }
  lines.push(`Cursor sessions: ${data.cursor.sessions.length}`);
  for (const s of data.cursor.sessions) {
    const bubbles = s.sqlite.bubbles.length;
    const size = (s.transcript.length / 1024).toFixed(0);
    lines.push(
      `  ${s.composerId.slice(0, 8)}  ${size} KB transcript  ${bubbles} bubbles`
    );
  }
  lines.push(
    `Snapshots: ${data.snapshots.changes ? data.snapshots.changes.length + " changes" : "none"}`
  );
  return lines.join("\n");
}

export function importSummary(result: ImportResult): string {
  const lines: string[] = [];
  lines.push(
    `Claude: ${result.claude.imported} imported, ${result.claude.skipped} skipped (already exist)`
  );
  lines.push(
    `Cursor transcripts: ${result.cursor.transcripts.imported} imported, ${result.cursor.transcripts.skipped} skipped`
  );
  if (result.cursor.sqliteEntries.failed) {
    lines.push(
      `Cursor SQLite: FAILED (node:sqlite not available or DB locked — Cursor chat panel won't show imported chats, but Promptrail timeline will still work)`
    );
  } else {
    lines.push(
      `Cursor SQLite: ${result.cursor.sqliteEntries.written} entries written, ${result.cursor.sqliteEntries.skipped} skipped`
    );
  }
  lines.push(`Snapshots: ${result.snapshots.imported ? "merged" : "nothing to import"}`);
  return lines.join("\n");
}
