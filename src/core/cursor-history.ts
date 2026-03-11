import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface CursorFileInfo {
  uri: string;
  relativePath: string;
  isNewlyCreated: boolean;
  firstEditBubbleId?: string;
  originalContent?: string;
}

export interface ComposerSession {
  composerId: string;
  name: string;
  filesChanged: CursorFileInfo[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  createdAt: number;
  lastUpdatedAt: number;
  model?: string;
  mode?: string;
}

export function toEpochMs(val: unknown): number {
  if (typeof val === "number" && val > 0) return val;
  if (typeof val === "string") {
    const n = Number(val);
    if (!isNaN(n) && n > 0) return n;
    const d = new Date(val).getTime();
    if (!isNaN(d)) return d;
  }
  return 0;
}

function getCursorUserDir(): string {
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA ||
          path.join(os.homedir(), "AppData", "Roaming"),
        "Cursor",
        "User"
      );
    case "linux":
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "Cursor",
        "User"
      );
    default:
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Cursor",
        "User"
      );
  }
}

const CURSOR_SUPPORT_DIR = getCursorUserDir();

const GLOBAL_DB_PATH = path.join(
  CURSOR_SUPPORT_DIR,
  "globalStorage",
  "state.vscdb"
);

let DatabaseSync: any;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

const FILE_EDIT_TOOLS = new Set([
  "edit_file_v2",
  "write",
  "delete_file",
  "edit_file_v2_write",
  "edit_file_v2_search_replace",
  "edit_file",
  "search_replace",
  "apply_patch",
]);

interface SessionCache {
  data: any;
  session: ComposerSession;
  timestamps: number[];
  fileMapping: Map<string, number>;
  perPromptFiles: Map<number, Set<string>>;
  cachedAt: number;
}

export class CursorHistory {
  private workspaceRoot: string;
  private cache = new Map<string, SessionCache>();
  private cacheTtl = 10_000;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private withDb<T>(fn: (db: any) => T): T | undefined {
    if (!DatabaseSync || !fs.existsSync(GLOBAL_DB_PATH)) return undefined;
    let db: any;
    try {
      db = new DatabaseSync(GLOBAL_DB_PATH, { open: true, readOnly: true });
      return fn(db);
    } catch {
      return undefined;
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  private getOrLoadSession(composerId: string): SessionCache | undefined {
    const existing = this.cache.get(composerId);
    if (existing && Date.now() - existing.cachedAt < this.cacheTtl) {
      return existing;
    }

    return this.withDb((db) => {
      const row = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${composerId}`);
      if (!row) return undefined;

      const data = JSON.parse(row.value);

      const files: CursorFileInfo[] = [];
      const ofs = data.originalFileStates || {};
      for (const [uri, state] of Object.entries(ofs)) {
        const s = state as any;
        files.push({
          uri,
          relativePath: this.uriToRelPath(uri),
          isNewlyCreated: s.isNewlyCreated || false,
          firstEditBubbleId: s.firstEditBubbleId,
          originalContent:
            typeof s.content === "string" ? s.content : undefined,
        });
      }

      for (const nf of data.newlyCreatedFiles || []) {
        const uri = nf?.uri?.external || nf?.uri?.path || "";
        if (!uri) continue;
        const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;
        if (files.some((f) => f.uri === fileUri)) continue;
        files.push({
          uri: fileUri,
          relativePath: this.uriToRelPath(fileUri),
          isNewlyCreated: true,
        });
      }

      const session: ComposerSession = {
        composerId: data.composerId || composerId,
        name: data.name || "",
        filesChanged: files,
        totalLinesAdded: data.totalLinesAdded || 0,
        totalLinesRemoved: data.totalLinesRemoved || 0,
        createdAt: toEpochMs(data.createdAt),
        lastUpdatedAt: toEpochMs(data.lastUpdatedAt),
        model: data.modelConfig?.modelName,
        mode: data.unifiedMode || data.forceMode,
      };

      const bubbles: { bubbleId: string; type: number }[] =
        data.fullConversationHeadersOnly || [];
      const userBubbleIds = bubbles
        .filter((b) => b.type === 1)
        .map((b) => b.bubbleId);

      const timestamps: number[] = [];
      if (userBubbleIds.length > 0) {
        const stmt = db.prepare(
          "SELECT value FROM cursorDiskKV WHERE key = ?"
        );
        for (const bid of userBubbleIds) {
          try {
            const bRow = stmt.get(`bubbleId:${composerId}:${bid}`);
            const raw = bRow ? JSON.parse(bRow.value).createdAt : 0;
            timestamps.push(toEpochMs(raw));
          } catch {
            timestamps.push(0);
          }
        }
      }

      const userBubbleIndices: number[] = [];
      for (let i = 0; i < bubbles.length; i++) {
        if (bubbles[i].type === 1) userBubbleIndices.push(i);
      }
      const bubbleIdToIndex = new Map<string, number>();
      for (let i = 0; i < bubbles.length; i++) {
        bubbleIdToIndex.set(bubbles[i].bubbleId, i);
      }

      const fileMapping = new Map<string, number>();
      for (const [uri, state] of Object.entries(ofs)) {
        const relPath = this.uriToRelPath(uri);
        const editBubbleId: string | undefined = (state as any)
          .firstEditBubbleId;
        if (!editBubbleId) continue;
        const editIdx = bubbleIdToIndex.get(editBubbleId);
        if (editIdx === undefined) continue;

        let promptIdx = 0;
        for (let u = userBubbleIndices.length - 1; u >= 0; u--) {
          if (userBubbleIndices[u] <= editIdx) {
            promptIdx = u;
            break;
          }
        }
        fileMapping.set(relPath, promptIdx);
      }

      // Per-prompt file whitelist from toolFormerData
      const perPromptFiles = new Map<number, Set<string>>();
      const stmt2 = db.prepare(
        "SELECT value FROM cursorDiskKV WHERE key = ?"
      );
      for (let u = 0; u < userBubbleIndices.length; u++) {
        const startIdx = userBubbleIndices[u];
        const endIdx =
          u + 1 < userBubbleIndices.length
            ? userBubbleIndices[u + 1]
            : bubbles.length;

        const files = new Set<string>();
        for (let bi = startIdx; bi < endIdx; bi++) {
          if (bubbles[bi].type !== 2) continue;
          try {
            const bRow = stmt2.get(
              `bubbleId:${composerId}:${bubbles[bi].bubbleId}`
            );
            if (!bRow) continue;
            const bData = JSON.parse(bRow.value);
            const tfd = bData.toolFormerData;
            if (!tfd || !FILE_EDIT_TOOLS.has(tfd.name)) continue;

            const params = tfd.params
              ? JSON.parse(tfd.params)
              : {};
            const fp: string =
              params.relativeWorkspacePath || "";
            if (!fp) continue;
            const rel = this.uriToRelPath(fp);
            if (rel) files.add(rel);
          } catch {}
        }
        if (files.size > 0) {
          perPromptFiles.set(u, files);
        }
      }

      const cached: SessionCache = {
        data,
        session,
        timestamps,
        fileMapping,
        perPromptFiles,
        cachedAt: Date.now(),
      };

      this.cache.set(composerId, cached);
      return cached;
    });
  }

  getComposerSession(composerId: string): ComposerSession | undefined {
    return this.getOrLoadSession(composerId)?.session;
  }

  getFilePromptMapping(composerId: string): Map<string, number> | undefined {
    const cached = this.getOrLoadSession(composerId);
    return cached?.fileMapping.size ? cached.fileMapping : undefined;
  }

  getUserBubbleTimestamps(composerId: string): number[] | undefined {
    const cached = this.getOrLoadSession(composerId);
    return cached?.timestamps.length ? cached.timestamps : undefined;
  }

  getPerPromptFiles(
    composerId: string
  ): Map<number, Set<string>> | undefined {
    const cached = this.getOrLoadSession(composerId);
    return cached?.perPromptFiles.size ? cached.perPromptFiles : undefined;
  }

  getV0Content(composerId: string, relPath: string): string | undefined {
    const cached = this.getOrLoadSession(composerId);
    if (!cached) return undefined;

    const file = cached.session.filesChanged.find(
      (f) => f.relativePath === relPath
    );
    return file?.originalContent;
  }

  invalidateCache(composerId?: string): void {
    if (composerId) {
      this.cache.delete(composerId);
    } else {
      this.cache.clear();
    }
  }

  private uriToRelPath(uri: string): string {
    let fsPath = uri;
    if (fsPath.startsWith("file:///")) {
      fsPath = fsPath.slice(7);
    } else if (fsPath.startsWith("file://")) {
      fsPath = fsPath.slice(7);
    }

    fsPath = decodeURIComponent(fsPath);

    if (fsPath.startsWith(this.workspaceRoot + "/")) {
      let rel = fsPath.slice(this.workspaceRoot.length + 1);
      const wsName = path.basename(this.workspaceRoot);
      if (rel.startsWith(wsName + "/")) {
        rel = rel.slice(wsName.length + 1);
      }
      return rel;
    }
    return fsPath;
  }
}
