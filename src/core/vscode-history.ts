import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface VSCodeRequest {
  requestId: string;
  timestamp: number;
  messageText: string;
  toolInvocations: { toolId: string; message: string }[];
  filesEdited: string[];
}

export interface VSCodeSession {
  sessionId: string;
  title: string;
  creationDate: number;
  model?: string;
  mode?: string;
  requests: VSCodeRequest[];
}

export interface VSCodeEditOp {
  type: "create" | "textEdit" | "delete";
  filePath: string;
  requestId: string;
  epoch: number;
}

export interface VSCodeFileDiff {
  relativePath: string;
  before: string;
  after: string;
  type: "added" | "modified" | "deleted";
}

function getVSCodeUserDir(): string {
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA ||
          path.join(os.homedir(), "AppData", "Roaming"),
        "Code",
        "User"
      );
    case "linux":
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "Code",
        "User"
      );
    default:
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Code",
        "User"
      );
  }
}

export class VSCodeHistory {
  private workspaceRoot: string;
  private storageDir: string | undefined;
  private storageDirChecked = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Finds the VS Code workspace storage directory by scanning
   * workspaceStorage/{hash}/workspace.json and matching the folder URI.
   */
  private findStorageDir(): string | undefined {
    if (this.storageDirChecked) return this.storageDir;
    this.storageDirChecked = true;

    const base = path.join(getVSCodeUserDir(), "workspaceStorage");
    if (!fs.existsSync(base)) return undefined;

    const targetUri = process.platform === "win32"
      ? `file:///${this.workspaceRoot.replace(/\\/g, "/")}`
      : `file://${this.workspaceRoot}`;

    for (const entry of fs.readdirSync(base)) {
      const wsJsonPath = path.join(base, entry, "workspace.json");
      try {
        if (!fs.existsSync(wsJsonPath)) continue;
        const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, "utf-8"));
        const folder: string = wsJson.folder || "";
        if (folder === targetUri || decodeURIComponent(folder) === targetUri) {
          this.storageDir = path.join(base, entry);
          return this.storageDir;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  getChatSessionsDir(): string | undefined {
    const dir = this.findStorageDir();
    if (!dir) return undefined;
    const chatDir = path.join(dir, "chatSessions");
    return fs.existsSync(chatDir) ? chatDir : undefined;
  }

  getEditingSessionsDir(): string | undefined {
    const dir = this.findStorageDir();
    if (!dir) return undefined;
    const editDir = path.join(dir, "chatEditingSessions");
    return fs.existsSync(editDir) ? editDir : undefined;
  }

  /**
   * Reads all chat sessions from JSONL files.
   */
  readAllSessions(): VSCodeSession[] {
    const chatDir = this.getChatSessionsDir();
    if (!chatDir) return [];

    const sessions: VSCodeSession[] = [];
    for (const file of fs.readdirSync(chatDir)) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const session = this.parseSessionJsonl(path.join(chatDir, file));
        if (session && session.requests.length > 0) {
          sessions.push(session);
        }
      } catch {
        continue;
      }
    }
    return sessions;
  }

  /**
   * Replays a VS Code chat session JSONL to reconstruct the full session state.
   * JSONL operations:
   * - kind=0: Initialize session
   * - kind=1: SET a value at path k
   * - kind=2: ARRAY_REPLACE at path k, optionally at index i
   */
  private parseSessionJsonl(filePath: string): VSCodeSession | undefined {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return undefined;

    let sessionId = "";
    let title = "";
    let creationDate = 0;
    let model: string | undefined;
    let mode: string | undefined;
    const requestsMap = new Map<number, any>();

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const kind = obj.kind;

      if (kind === 0) {
        const v = obj.v;
        sessionId = v.sessionId || "";
        creationDate = v.creationDate || 0;
        title = v.customTitle || "";
        mode = v.inputState?.mode?.id;
        if (v.inputState?.selectedModel) {
          model = this.extractModelName(v.inputState.selectedModel);
        }
        // Initialize requests from kind=0 if present
        if (Array.isArray(v.requests)) {
          for (let i = 0; i < v.requests.length; i++) {
            requestsMap.set(i, v.requests[i]);
          }
        }
      } else if (kind === 1) {
        const k: (string | number)[] = obj.k || [];
        const v = obj.v;

        if (k.length === 1 && k[0] === "customTitle") {
          title = v || "";
        } else if (
          k.length === 2 &&
          k[0] === "inputState" &&
          k[1] === "selectedModel"
        ) {
          model = this.extractModelName(v);
        } else if (
          k.length === 2 &&
          k[0] === "inputState" &&
          k[1] === "mode"
        ) {
          mode = v?.id || v?.kind;
        } else if (
          k.length === 3 &&
          k[0] === "requests" &&
          typeof k[1] === "number"
        ) {
          // SET on requests[N].field
          const idx = k[1] as number;
          const field = k[2] as string;
          const existing = requestsMap.get(idx) || {};
          existing[field] = v;
          requestsMap.set(idx, existing);
        }
      } else if (kind === 2) {
        const k: (string | number)[] = obj.k || [];
        const i = obj.i;
        const v = obj.v;

        if (k.length === 1 && k[0] === "requests") {
          if (typeof i === "number") {
            // Replace request at index i: v is the new request (may be an array with one element)
            if (Array.isArray(v) && v.length === 1) {
              requestsMap.set(i, v[0]);
            } else if (Array.isArray(v)) {
              // Replace from index i onwards
              for (let j = 0; j < v.length; j++) {
                requestsMap.set(i + j, v[j]);
              }
            } else {
              requestsMap.set(i, v);
            }
          } else if (i == null && Array.isArray(v)) {
            // Replace entire requests array
            requestsMap.clear();
            for (let j = 0; j < v.length; j++) {
              requestsMap.set(j, v[j]);
            }
          }
        } else if (
          k.length === 3 &&
          k[0] === "requests" &&
          typeof k[1] === "number" &&
          k[2] === "response"
        ) {
          const idx = k[1] as number;
          const existing = requestsMap.get(idx) || {};
          if (typeof i === "number") {
            // Replace response items starting at index i
            const existingResponse: any[] = existing.response || [];
            if (Array.isArray(v)) {
              // Ensure array is big enough
              while (existingResponse.length < i + v.length) {
                existingResponse.push(null);
              }
              for (let j = 0; j < v.length; j++) {
                existingResponse[i + j] = v[j];
              }
            }
            existing.response = existingResponse;
          } else if (Array.isArray(v)) {
            existing.response = v;
          }
          requestsMap.set(idx, existing);
        }
      }
    }

    if (!sessionId) return undefined;

    // Convert requestsMap to VSCodeRequest[]
    const requests: VSCodeRequest[] = [];
    const sortedIndices = [...requestsMap.keys()].sort((a, b) => a - b);

    for (const idx of sortedIndices) {
      const req = requestsMap.get(idx);
      if (!req || typeof req !== "object") continue;

      const requestId = req.requestId || "";
      const timestamp = req.timestamp || 0;
      const messageText = req.message?.text || "";

      if (!messageText && !requestId) continue;

      // Extract tool invocations and file references from response
      const toolInvocations: { toolId: string; message: string }[] = [];
      const filesFromResponse = new Set<string>();

      const response = req.response || [];
      if (Array.isArray(response)) {
        for (const item of response) {
          if (!item || typeof item !== "object") continue;
          if (item.kind === "toolInvocationSerialized") {
            const toolId = item.toolId || "";
            const invMsg = item.invocationMessage?.value || "";
            toolInvocations.push({ toolId, message: invMsg });

            // Extract file paths from tool invocations
            if (
              toolId === "copilot_createFile" ||
              toolId === "insert_edit_into_file" ||
              toolId === "replace_string_in_file"
            ) {
              const filePath = this.extractFileFromToolMsg(invMsg);
              if (filePath) filesFromResponse.add(filePath);
            }
          } else if (item.kind === "textEditGroup") {
            const uri = item.uri;
            if (uri) {
              const fp = this.uriToRelPath(uri);
              if (fp) filesFromResponse.add(fp);
            }
          }
        }
      }

      requests.push({
        requestId,
        timestamp,
        messageText: messageText.slice(0, 2000),
        toolInvocations,
        filesEdited: [...filesFromResponse],
      });
    }

    return {
      sessionId,
      title,
      creationDate,
      model,
      mode,
      requests,
    };
  }

  /**
   * Reads the chatEditingSessions state.json for a given session ID
   * and returns per-request file operations.
   */
  getEditingOps(
    sessionId: string
  ): Map<string, string[]> | undefined {
    const editDir = this.getEditingSessionsDir();
    if (!editDir) return undefined;

    const statePath = path.join(editDir, sessionId, "state.json");
    if (!fs.existsSync(statePath)) return undefined;

    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      const timeline = state.timeline || {};
      const operations: any[] = timeline.operations || [];

      // Group files by requestId
      const byRequest = new Map<string, Set<string>>();

      for (const op of operations) {
        const requestId = op.requestId || "";
        if (!requestId) continue;

        const uri = op.uri;
        if (!uri) continue;

        const fp = this.uriToRelPath(uri);
        if (!fp) continue;

        if (!byRequest.has(requestId)) {
          byRequest.set(requestId, new Set());
        }
        byRequest.get(requestId)!.add(fp);
      }

      // Convert to Map<string, string[]>
      const result = new Map<string, string[]>();
      for (const [reqId, files] of byRequest) {
        result.set(reqId, [...files]);
      }
      return result;
    } catch {
      return undefined;
    }
  }

  private extractModelName(selectedModel: any): string | undefined {
    if (!selectedModel) return undefined;
    const meta = selectedModel.metadata;
    if (meta?.name) return meta.name;
    const id = selectedModel.identifier || "";
    // e.g. "anthropic/Opus/claude-opus-4-6" -> "claude-opus-4-6"
    const parts = id.split("/");
    return parts.length > 0 ? parts[parts.length - 1] : id;
  }

  private extractFileFromToolMsg(msg: string): string | undefined {
    // Extract file:// URIs from tool invocation messages
    const match = msg.match(/file:\/\/([^\s)\]]+)/);
    if (!match) return undefined;
    return this.uriToRelPath(match[1]);
  }

  uriToRelPath(uri: any): string {
    let fsPath: string;

    if (typeof uri === "object" && uri !== null) {
      fsPath = uri.path || uri.fsPath || "";
    } else if (typeof uri === "string") {
      fsPath = uri;
    } else {
      return "";
    }

    if (fsPath.startsWith("file:///")) {
      fsPath = fsPath.slice(7);
    } else if (fsPath.startsWith("file://")) {
      fsPath = fsPath.slice(7);
    }

    fsPath = decodeURIComponent(fsPath);

    // On Windows, file URIs produce /C:/path — strip the leading slash
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(fsPath)) {
      fsPath = fsPath.slice(1);
    }

    // Normalize to OS path separators for comparison
    const normalizedFs = fsPath.replace(/[\\/]/g, path.sep);
    const normalizedRoot = this.workspaceRoot.replace(/[\\/]/g, path.sep);

    if (normalizedFs.startsWith(normalizedRoot + path.sep)) {
      // Always return forward slashes in relative paths
      return normalizedFs.slice(normalizedRoot.length + 1).replace(/\\/g, "/");
    }
    return "";
  }

  /**
   * Gets before/after file diffs for a specific request in a session
   * by replaying textEdit operations from chatEditingSessions.
   */
  getDiffsForRequest(
    sessionId: string,
    requestId: string
  ): VSCodeFileDiff[] | undefined {
    const editDir = this.getEditingSessionsDir();
    if (!editDir) return undefined;

    const sessionDir = path.join(editDir, sessionId);
    const statePath = path.join(sessionDir, "state.json");
    if (!fs.existsSync(statePath)) return undefined;

    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      const contentsDir = path.join(sessionDir, "contents");
      const initialFileContents: [string, string][] =
        state.initialFileContents || [];
      const operations: any[] = state.timeline?.operations || [];

      // Build initial content map: relPath -> content
      const fileContents = new Map<string, string>();
      for (const [uri, hash] of initialFileContents) {
        const relPath = this.uriToRelPath(uri);
        if (!relPath) continue;
        const contentPath = path.join(contentsDir, hash);
        try {
          fileContents.set(relPath, fs.readFileSync(contentPath, "utf-8"));
        } catch {
          fileContents.set(relPath, "");
        }
      }

      // Sort operations by epoch
      const sorted = [...operations].sort(
        (a: any, b: any) => (a.epoch || 0) - (b.epoch || 0)
      );

      // Collect request IDs in order of first appearance
      const requestOrder: string[] = [];
      const seen = new Set<string>();
      for (const op of sorted) {
        const rid = op.requestId || "";
        if (rid && !seen.has(rid)) {
          seen.add(rid);
          requestOrder.push(rid);
        }
      }

      // Replay operations up to and including the target request.
      // Snapshot "before" state at the start of the target request,
      // "after" state at the end.
      const targetFiles = new Set<string>();
      const beforeState = new Map<string, string>();
      let pastTarget = false;

      for (const op of sorted) {
        const opReq = op.requestId || "";
        if (pastTarget) break;

        const relPath = this.uriToRelPath(op.uri);
        if (!relPath) continue;

        // When we first hit target request, snapshot "before"
        if (opReq === requestId && !beforeState.has(relPath)) {
          beforeState.set(relPath, fileContents.get(relPath) ?? "");
          targetFiles.add(relPath);
        }

        // Apply operation
        if (op.type === "create") {
          fileContents.set(relPath, op.initialContent || "");
          if (opReq === requestId) targetFiles.add(relPath);
        } else if (op.type === "textEdit") {
          const current = fileContents.get(relPath) ?? "";
          const edited = this.applyTextEdits(current, op.edits || []);
          fileContents.set(relPath, edited);
          if (opReq === requestId) targetFiles.add(relPath);
        } else if (op.type === "delete") {
          fileContents.set(relPath, "");
          if (opReq === requestId) targetFiles.add(relPath);
        }

        // Check if we've finished processing target request ops
        if (opReq === requestId) {
          // Look ahead: if next op is different request, we're done
          const idx = sorted.indexOf(op);
          if (
            idx === sorted.length - 1 ||
            sorted[idx + 1].requestId !== requestId
          ) {
            pastTarget = true;
          }
        }
      }

      // Build diffs
      const diffs: VSCodeFileDiff[] = [];
      for (const relPath of targetFiles) {
        const before = beforeState.get(relPath) ?? "";
        const after = fileContents.get(relPath) ?? "";
        if (before === after) continue;

        let type: VSCodeFileDiff["type"] = "modified";
        if (before === "" && after !== "") type = "added";
        else if (before !== "" && after === "") type = "deleted";

        diffs.push({ relativePath: relPath, before, after, type });
      }

      return diffs.length > 0 ? diffs : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Applies Monaco-style textEdit operations to content.
   * Lines and columns are 1-indexed.
   */
  private applyTextEdits(
    content: string,
    edits: {
      text: string;
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
    }[]
  ): string {
    // Apply edits in reverse order (highest offset first) to preserve positions
    const lines = content.split("\n");

    // Sort edits by position, descending so later edits don't shift earlier ones
    const sorted = [...edits].sort((a, b) => {
      const lineDiff = b.range.startLineNumber - a.range.startLineNumber;
      if (lineDiff !== 0) return lineDiff;
      return b.range.startColumn - a.range.startColumn;
    });

    for (const edit of sorted) {
      const { startLineNumber, startColumn, endLineNumber, endColumn } =
        edit.range;
      const newText = edit.text;

      // Clamp positions to document bounds (Monaco clamps out-of-range to end of doc)
      const lastLine = lines.length - 1;
      let startLine: number, startCol: number, endLine: number, endCol: number;

      if (startLineNumber - 1 > lastLine) {
        startLine = lastLine;
        startCol = lines[lastLine].length;
      } else {
        startLine = Math.max(0, startLineNumber - 1);
        startCol = Math.min(Math.max(0, startColumn - 1), lines[startLine].length);
      }

      if (endLineNumber - 1 > lastLine) {
        endLine = lastLine;
        endCol = lines[lastLine].length;
      } else {
        endLine = Math.max(0, endLineNumber - 1);
        endCol = Math.min(Math.max(0, endColumn - 1), lines[endLine].length);
      }

      const prefix = lines[startLine].slice(0, startCol);
      const suffix = lines[endLine].slice(endCol);
      const newLines = newText.split("\n");

      // Merge: prefix + newText + suffix
      if (newLines.length === 1) {
        lines.splice(
          startLine,
          endLine - startLine + 1,
          prefix + newLines[0] + suffix
        );
      } else {
        const replacement: string[] = [];
        replacement.push(prefix + newLines[0]);
        for (let i = 1; i < newLines.length - 1; i++) {
          replacement.push(newLines[i]);
        }
        replacement.push(newLines[newLines.length - 1] + suffix);
        lines.splice(startLine, endLine - startLine + 1, ...replacement);
      }
    }

    return lines.join("\n");
  }

  invalidateCache(): void {
    this.storageDirChecked = false;
    this.storageDir = undefined;
  }
}
