import * as fs from "fs";
import * as path from "path";

let DatabaseSync: any;
try {
  const _ew = process.emitWarning;
  process.emitWarning = (() => {}) as any;
  DatabaseSync = require("node:sqlite").DatabaseSync;
  process.emitWarning = _ew;
} catch {
  DatabaseSync = undefined;
}

export interface UserBubbleRow {
  userIndex: number;
  bubbleId: string;
  text: string;
  createdAt: number;
  checkpointId: string;
}

export interface ToolCallRow {
  bubbleIndex: number;
  userIndex: number;
  toolName: string;
  filePath: string;
  createdAt: number;
}

export interface AssistantBubbleRow {
  bubbleIndex: number;
  userIndex: number;
  bubbleId: string;
  text: string;
  createdAt: number;
  toolName: string;
  toolCallId: string;
  toolStatus: string;
}

export interface PromptFileRow {
  userIndex: number;
  filePath: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    composerId    TEXT PRIMARY KEY,
    name          TEXT,
    model         TEXT,
    mode          TEXT,
    createdAt     REAL,
    lastUpdatedAt REAL,
    cachedAt      REAL
  );

  CREATE TABLE IF NOT EXISTS user_bubbles (
    composerId   TEXT NOT NULL,
    userIndex    INTEGER NOT NULL,
    bubbleId     TEXT NOT NULL,
    text         TEXT,
    createdAt    REAL,
    checkpointId TEXT,
    PRIMARY KEY (composerId, userIndex)
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    composerId  TEXT NOT NULL,
    bubbleIndex INTEGER NOT NULL,
    userIndex   INTEGER NOT NULL,
    toolName    TEXT NOT NULL,
    filePath    TEXT,
    createdAt   REAL,
    PRIMARY KEY (composerId, bubbleIndex)
  );

  CREATE TABLE IF NOT EXISTS prompt_files (
    composerId TEXT NOT NULL,
    userIndex  INTEGER NOT NULL,
    filePath   TEXT NOT NULL,
    PRIMARY KEY (composerId, userIndex, filePath)
  );

  CREATE TABLE IF NOT EXISTS assistant_bubbles (
    composerId     TEXT NOT NULL,
    bubbleIndex    INTEGER NOT NULL,
    userIndex      INTEGER NOT NULL,
    bubbleId       TEXT NOT NULL,
    text           TEXT,
    createdAt      REAL,
    toolName       TEXT,
    toolCallId     TEXT,
    toolStatus     TEXT,
    PRIMARY KEY (composerId, bubbleIndex)
  );

  CREATE TABLE IF NOT EXISTS session_files (
    composerId        TEXT NOT NULL,
    filePath          TEXT NOT NULL,
    firstEditBubbleId TEXT,
    isNewlyCreated    INTEGER DEFAULT 0,
    PRIMARY KEY (composerId, filePath)
  );

  CREATE TABLE IF NOT EXISTS file_changes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    relPath   TEXT NOT NULL,
    before    TEXT,
    after     TEXT,
    timestamp REAL NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_fc_timestamp ON file_changes(timestamp);

  CREATE TABLE IF NOT EXISTS hook_prompts (
    conversationId TEXT NOT NULL,
    generationId   TEXT NOT NULL,
    promptText     TEXT NOT NULL,
    model          TEXT,
    timestamp      REAL NOT NULL,
    PRIMARY KEY (conversationId, generationId)
  );

  CREATE TABLE IF NOT EXISTS hook_edits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversationId  TEXT NOT NULL,
    generationId    TEXT NOT NULL,
    filePath        TEXT NOT NULL,
    oldString       TEXT,
    newString       TEXT,
    timestamp       REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hook_edits_gen
    ON hook_edits(conversationId, generationId);

  CREATE TABLE IF NOT EXISTS hook_responses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversationId  TEXT NOT NULL,
    generationId    TEXT NOT NULL,
    responseText    TEXT NOT NULL,
    model           TEXT,
    timestamp       REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hook_responses_gen
    ON hook_responses(conversationId, generationId);
`;

export interface SearchResult {
  composerId: string;
  userIndex: number;
  type: "prompt" | "response";
  snippet: string;
  promptText: string;
  model: string;
  createdAt: number;
  rank: number;
}

export class PromptRailDB {
  private dbPath: string;
  private db: any;
  private ftsAvailable = false;
  private ftsIndexedCount = 0;

  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceRoot, ".promptrail");
    fs.mkdirSync(dir, { recursive: true });
    this.dbPath = path.join(dir, "promptrail.db");

    if (!DatabaseSync) return;
    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec(SCHEMA);
      this.initFts();
    } catch {
      this.db = undefined;
    }
  }

  private initFts(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
          text,
          composerId UNINDEXED,
          userIndex UNINDEXED,
          type UNINDEXED
        )
      `);
      this.ftsAvailable = true;
      const row = this.db
        .prepare("SELECT COUNT(*) as cnt FROM search_index")
        .get();
      this.ftsIndexedCount = row?.cnt || 0;
    } catch {
      this.ftsAvailable = false;
    }
  }

  getCachedBubbleCount(composerId: string): number {
    if (!this.db) return 0;
    try {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM user_bubbles WHERE composerId = ?"
        )
        .get(composerId);
      return row?.cnt || 0;
    } catch {
      return 0;
    }
  }

  getCachedAssistantBubbleCount(composerId: string): number {
    if (!this.db) return 0;
    try {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM assistant_bubbles WHERE composerId = ?"
        )
        .get(composerId);
      return row?.cnt || 0;
    } catch {
      return 0;
    }
  }

  snapshotSession(
    composerId: string,
    meta: {
      name: string;
      model?: string;
      mode?: string;
      createdAt: number;
      lastUpdatedAt: number;
    },
    userBubbles: UserBubbleRow[],
    toolCalls: ToolCallRow[],
    promptFiles: Map<number, Set<string>>,
    sessionFiles: Array<{
      filePath: string;
      firstEditBubbleId?: string;
      isNewlyCreated: boolean;
    }>,
    assistantBubbles?: AssistantBubbleRow[]
  ): void {
    if (!this.db) return;
    try {
      this.db.exec("BEGIN TRANSACTION");

      // Session metadata: always update (lastUpdatedAt changes)
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sessions
           (composerId, name, model, mode, createdAt, lastUpdatedAt, cachedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          composerId,
          meta.name,
          meta.model || null,
          meta.mode || null,
          meta.createdAt,
          meta.lastUpdatedAt,
          Date.now()
        );

      // Append-only: IGNORE existing rows so old data survives
      // pruning and checkpoint restores.
      const bubbleStmt = this.db.prepare(
        `INSERT OR IGNORE INTO user_bubbles
         (composerId, userIndex, bubbleId, text, createdAt, checkpointId)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const b of userBubbles) {
        bubbleStmt.run(
          composerId,
          b.userIndex,
          b.bubbleId,
          b.text,
          b.createdAt,
          b.checkpointId
        );
      }

      const toolStmt = this.db.prepare(
        `INSERT OR IGNORE INTO tool_calls
         (composerId, bubbleIndex, userIndex, toolName, filePath, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const tc of toolCalls) {
        toolStmt.run(
          composerId,
          tc.bubbleIndex,
          tc.userIndex,
          tc.toolName,
          tc.filePath || null,
          tc.createdAt
        );
      }

      const pfStmt = this.db.prepare(
        `INSERT OR IGNORE INTO prompt_files
         (composerId, userIndex, filePath)
         VALUES (?, ?, ?)`
      );
      for (const [idx, files] of promptFiles) {
        for (const fp of files) {
          pfStmt.run(composerId, idx, fp);
        }
      }

      const sfStmt = this.db.prepare(
        `INSERT OR IGNORE INTO session_files
         (composerId, filePath, firstEditBubbleId, isNewlyCreated)
         VALUES (?, ?, ?, ?)`
      );
      for (const sf of sessionFiles) {
        sfStmt.run(
          composerId,
          sf.filePath,
          sf.firstEditBubbleId || null,
          sf.isNewlyCreated ? 1 : 0
        );
      }

      if (assistantBubbles) {
        const abStmt = this.db.prepare(
          `INSERT OR IGNORE INTO assistant_bubbles
           (composerId, bubbleIndex, userIndex, bubbleId, text, createdAt,
            toolName, toolCallId, toolStatus)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const ab of assistantBubbles) {
          abStmt.run(
            composerId,
            ab.bubbleIndex,
            ab.userIndex,
            ab.bubbleId,
            ab.text || null,
            ab.createdAt,
            ab.toolName || null,
            ab.toolCallId || null,
            ab.toolStatus || null
          );
        }
      }

      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
    }
  }

  getUserBubbles(composerId: string): UserBubbleRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT userIndex, bubbleId, text, createdAt, checkpointId
           FROM user_bubbles WHERE composerId = ?
           ORDER BY userIndex`
        )
        .all(composerId);
    } catch {
      return [];
    }
  }

  getPromptFiles(
    composerId: string
  ): Map<number, Set<string>> | undefined {
    if (!this.db) return undefined;
    try {
      const rows = this.db
        .prepare(
          `SELECT userIndex, filePath FROM prompt_files
           WHERE composerId = ? ORDER BY userIndex`
        )
        .all(composerId);
      if (rows.length === 0) return undefined;
      const map = new Map<number, Set<string>>();
      for (const r of rows) {
        if (!map.has(r.userIndex)) map.set(r.userIndex, new Set());
        map.get(r.userIndex)!.add(r.filePath);
      }
      return map;
    } catch {
      return undefined;
    }
  }

  findComposerIdByPrefix(prefix: string): string | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db
        .prepare(
          "SELECT composerId FROM sessions WHERE composerId LIKE ? LIMIT 1"
        )
        .get(prefix + "%");
      return row?.composerId;
    } catch {
      return undefined;
    }
  }

  getAssistantBubbles(composerId: string): AssistantBubbleRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT bubbleIndex, userIndex, bubbleId, text, createdAt,
                  toolName, toolCallId, toolStatus
           FROM assistant_bubbles WHERE composerId = ?
           ORDER BY bubbleIndex`
        )
        .all(composerId);
    } catch {
      return [];
    }
  }

  getSessionTimestamps(
    composerId: string
  ): { createdAt: number; lastUpdatedAt: number } | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db
        .prepare(
          "SELECT createdAt, lastUpdatedAt FROM sessions WHERE composerId = ?"
        )
        .get(composerId);
      return row || undefined;
    } catch {
      return undefined;
    }
  }

  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  rebuildSearchIndex(): void {
    if (!this.db || !this.ftsAvailable) return;
    try {
      this.db.exec("DELETE FROM search_index");

      const prompts = this.db
        .prepare(
          "SELECT composerId, userIndex, text FROM user_bubbles WHERE text IS NOT NULL AND text != ''"
        )
        .all();
      const insertStmt = this.db.prepare(
        "INSERT INTO search_index (text, composerId, userIndex, type) VALUES (?, ?, ?, ?)"
      );
      for (const p of prompts) {
        insertStmt.run(p.text, p.composerId, p.userIndex, "prompt");
      }

      const sessions = this.db
        .prepare("SELECT DISTINCT composerId FROM assistant_bubbles")
        .all();
      for (const s of sessions) {
        const bubbles = this.db
          .prepare(
            `SELECT userIndex, text FROM assistant_bubbles
             WHERE composerId = ? AND text IS NOT NULL AND text != ''
             ORDER BY bubbleIndex`
          )
          .all(s.composerId);
        const byUser = new Map<number, string[]>();
        for (const b of bubbles) {
          if (!byUser.has(b.userIndex)) byUser.set(b.userIndex, []);
          byUser.get(b.userIndex)!.push(b.text);
        }
        for (const [ui, texts] of byUser) {
          insertStmt.run(texts.join("\n"), s.composerId, ui, "response");
        }
      }

      const cnt = this.db
        .prepare("SELECT COUNT(*) as cnt FROM search_index")
        .get();
      this.ftsIndexedCount = cnt?.cnt || 0;
    } catch {}
  }

  private ensureSearchIndex(): void {
    if (!this.db || !this.ftsAvailable) return;
    const totalRows = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM user_bubbles WHERE text IS NOT NULL AND text != '') +
           (SELECT COUNT(DISTINCT composerId || '-' || userIndex) FROM assistant_bubbles WHERE text IS NOT NULL AND text != '')
         as total`
      )
      .get();
    const expected = totalRows?.total || 0;
    if (this.ftsIndexedCount < expected) {
      this.rebuildSearchIndex();
    }
  }

  search(
    query: string,
    filters?: { source?: string; model?: string }
  ): SearchResult[] {
    if (!this.db || !this.ftsAvailable) return [];
    try {
      this.ensureSearchIndex();

      const ftsQuery = query
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map((w) => `"${w.replace(/"/g, "")}"`)
        .join(" ");
      if (!ftsQuery) return [];

      let sql = `
        SELECT
          si.text, si.composerId, si.userIndex, si.type, si.rank,
          snippet(search_index, 0, '>>>', '<<<', '...', 40) as snippet,
          s.model, s.createdAt
        FROM search_index si
        JOIN sessions s ON si.composerId = s.composerId
        WHERE search_index MATCH ?
      `;
      const params: any[] = [ftsQuery];

      if (filters?.model) {
        sql += " AND s.model LIKE '%' || ? || '%'";
        params.push(filters.model);
      }

      sql += " ORDER BY si.rank LIMIT 50";

      const rows = this.db.prepare(sql).all(...params);

      return rows.map((r: any) => {
        let promptText = "";
        if (r.type === "prompt") {
          promptText = r.text;
        } else {
          const ub = this.db
            .prepare(
              "SELECT text FROM user_bubbles WHERE composerId = ? AND userIndex = ?"
            )
            .get(r.composerId, r.userIndex);
          promptText = ub?.text || "";
        }
        return {
          composerId: r.composerId,
          userIndex: r.userIndex,
          type: r.type as "prompt" | "response",
          snippet: r.snippet || r.text?.slice(0, 120) || "",
          promptText,
          model: r.model || "",
          createdAt: r.createdAt || 0,
          rank: r.rank || 0,
        };
      });
    } catch {
      return [];
    }
  }

  insertFileChange(
    relPath: string,
    before: string,
    after: string,
    timestamp: number
  ): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          "INSERT INTO file_changes (relPath, before, after, timestamp) VALUES (?, ?, ?, ?)"
        )
        .run(relPath, before, after, timestamp);
    } catch {}
  }

  insertFileChangesBatch(
    changes: Array<{
      relPath: string;
      before: string;
      after: string;
      timestamp: number;
    }>
  ): void {
    if (!this.db || changes.length === 0) return;
    try {
      this.db.exec("BEGIN TRANSACTION");
      const stmt = this.db.prepare(
        "INSERT INTO file_changes (relPath, before, after, timestamp) VALUES (?, ?, ?, ?)"
      );
      for (const c of changes) {
        stmt.run(c.relPath, c.before, c.after, c.timestamp);
      }
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
    }
  }

  getChangesInRange(
    startTs: number,
    endTs: number
  ): Array<{
    relPath: string;
    before: string;
    after: string;
    timestamp: number;
  }> {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          "SELECT relPath, before, after, timestamp FROM file_changes WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp"
        )
        .all(startTs, endTs);
    } catch {
      return [];
    }
  }

  getAllFileChanges(): Array<{
    relPath: string;
    before: string;
    after: string;
    timestamp: number;
  }> {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          "SELECT relPath, before, after, timestamp FROM file_changes ORDER BY timestamp"
        )
        .all();
    } catch {
      return [];
    }
  }

  pruneOldChanges(cutoffTs: number): number {
    if (!this.db) return 0;
    try {
      const result = this.db
        .prepare("DELETE FROM file_changes WHERE timestamp < ?")
        .run(cutoffTs);
      return result.changes || 0;
    } catch {
      return 0;
    }
  }

  getFileChangeCount(): number {
    if (!this.db) return 0;
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) as cnt FROM file_changes")
        .get();
      return row?.cnt || 0;
    } catch {
      return 0;
    }
  }

  // ── Hook table queries ──────────────────────────────────

  getHookConversationIds(): string[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare("SELECT DISTINCT conversationId FROM hook_prompts")
        .all();
      return rows.map((r: any) => r.conversationId);
    } catch {
      return [];
    }
  }

  getHookPrompts(
    conversationId: string
  ): Array<{
    generationId: string;
    promptText: string;
    model: string | null;
    timestamp: number;
  }> {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT generationId, promptText, model, timestamp
           FROM hook_prompts WHERE conversationId = ?
           ORDER BY timestamp`
        )
        .all(conversationId);
    } catch {
      return [];
    }
  }

  getHookEdits(
    conversationId: string
  ): Array<{
    generationId: string;
    filePath: string;
    oldString: string | null;
    newString: string | null;
    timestamp: number;
  }> {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT generationId, filePath, oldString, newString, timestamp
           FROM hook_edits WHERE conversationId = ?
           ORDER BY timestamp`
        )
        .all(conversationId);
    } catch {
      return [];
    }
  }

  getHookResponses(
    conversationId: string
  ): Array<{
    generationId: string;
    responseText: string;
    model: string | null;
    timestamp: number;
  }> {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT generationId, responseText, model, timestamp
           FROM hook_responses WHERE conversationId = ?
           ORDER BY timestamp`
        )
        .all(conversationId);
    } catch {
      return [];
    }
  }

  getHookResponseForGeneration(
    conversationId: string,
    generationId: string
  ): string | undefined {
    if (!this.db) return undefined;
    try {
      const rows = this.db
        .prepare(
          `SELECT responseText FROM hook_responses
           WHERE conversationId = ? AND generationId = ?
           ORDER BY timestamp`
        )
        .all(conversationId, generationId);
      if (rows.length === 0) return undefined;
      return rows.map((r: any) => r.responseText).join("\n\n");
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    try {
      this.db?.close();
    } catch {}
  }
}
