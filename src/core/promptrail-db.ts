import * as fs from "fs";
import * as path from "path";

let DatabaseSync: any;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
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

  CREATE TABLE IF NOT EXISTS session_files (
    composerId        TEXT NOT NULL,
    filePath          TEXT NOT NULL,
    firstEditBubbleId TEXT,
    isNewlyCreated    INTEGER DEFAULT 0,
    PRIMARY KEY (composerId, filePath)
  );
`;

export class PromptRailDB {
  private dbPath: string;
  private db: any;

  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceRoot, ".promptrail");
    fs.mkdirSync(dir, { recursive: true });
    this.dbPath = path.join(dir, "promptrail.db");

    if (!DatabaseSync) return;
    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(SCHEMA);
    } catch {
      this.db = undefined;
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
    }>
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

  dispose(): void {
    try {
      this.db?.close();
    } catch {}
  }
}
