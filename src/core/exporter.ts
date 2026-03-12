import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface ExportOptions {
  sessionId: string;
  source: "cursor" | "claude" | "vscode";
  workspaceRoot: string;
  outputPath: string;
}

export class ConversationExporter {
  static findAllSessions(
    workspaceRoot: string
  ): { id: string; source: "cursor" | "claude" | "vscode"; label: string; path: string }[] {
    const sessions: {
      id: string;
      source: "cursor" | "claude" | "vscode";
      label: string;
      path: string;
    }[] = [];

    const cursorDir = this.findCursorDir(workspaceRoot);
    if (cursorDir) {
      for (const entry of fs.readdirSync(cursorDir)) {
        const dir = path.join(cursorDir, entry);
        if (!fs.statSync(dir).isDirectory()) continue;
        const jsonl = path.join(dir, `${entry}.jsonl`);
        if (!fs.existsSync(jsonl)) continue;
        const firstPrompt = this.peekFirstPrompt(jsonl, "cursor");
        sessions.push({
          id: entry,
          source: "cursor",
          label: firstPrompt || entry.slice(0, 8),
          path: jsonl,
        });
      }
    }

    const claudeDir = this.findClaudeDir(workspaceRoot);
    if (claudeDir) {
      for (const file of fs.readdirSync(claudeDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const jsonl = path.join(claudeDir, file);
        const id = file.replace(".jsonl", "");
        const firstPrompt = this.peekFirstPrompt(jsonl, "claude");
        sessions.push({
          id,
          source: "claude",
          label: firstPrompt || id.slice(0, 8),
          path: jsonl,
        });
      }
    }

    const vscodeDir = this.findVSCodeChatDir(workspaceRoot);
    if (vscodeDir) {
      for (const file of fs.readdirSync(vscodeDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const jsonl = path.join(vscodeDir, file);
        const id = file.replace(".jsonl", "");
        sessions.push({
          id,
          source: "vscode",
          label: `VS Code ${id.slice(0, 8)}`,
          path: jsonl,
        });
      }
    }

    return sessions;
  }

  static exportToMarkdown(opts: ExportOptions): string {
    const raw = fs.readFileSync(opts.outputPath.replace(/\.md$/, "") ? opts.outputPath : opts.outputPath, "utf-8");
    // opts.outputPath is the source JSONL, actual output path is passed separately
    return this.convertToMarkdown(opts.source, opts.sessionId, opts.outputPath);
  }

  static convertSessionToMarkdown(
    jsonlPath: string,
    source: "cursor" | "claude" | "vscode"
  ): string {
    const raw = fs.readFileSync(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const parts: string[] = [];

    const sourceLabel = source === "cursor" ? "Cursor" : source === "claude" ? "Claude Code" : "VS Code Chat";
    parts.push("# Exported Conversation\n");
    parts.push(`> Source: ${sourceLabel}`);
    parts.push(`> Exported: ${new Date().toISOString()}\n`);
    parts.push("---\n");

    if (source === "cursor") {
      return parts.join("\n") + "\n" + this.parseCursorToMd(lines);
    } else if (source === "vscode") {
      return parts.join("\n") + "\n" + this.parseVSCodeToMd(lines);
    } else {
      return parts.join("\n") + "\n" + this.parseClaudeToMd(lines);
    }
  }

  private static parseCursorToMd(lines: string[]): string {
    const parts: string[] = [];

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const role = obj.role;
      const msg = obj.message || {};
      const content = msg.content;

      if (role === "user") {
        let text = "";
        if (typeof content === "string") {
          text = this.extractUserText(content);
        } else if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "text") {
              text = this.extractUserText(c.text || "");
              if (text) break;
            }
          }
        }
        if (text && text.length > 3) {
          parts.push(`## User\n\n${text}\n`);
        }
      } else if (role === "assistant") {
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const c of content) {
            if (c?.type === "text" && c.text) {
              textParts.push(c.text);
            } else if (c?.type === "tool_use") {
              const name = c.name || "";
              const inp = c.input || {};
              if (["Write", "StrReplace"].includes(name)) {
                const fp = inp.path || inp.file_path || "";
                textParts.push(`*[Tool: ${name} → ${fp}]*`);
              } else if (name === "Shell") {
                textParts.push(
                  `*[Tool: Shell → \`${(inp.command || "").slice(0, 80)}\`]*`
                );
              }
            }
          }
          text = textParts.join("\n\n");
        }
        if (text && text.length > 3) {
          parts.push(`## Assistant\n\n${text}\n`);
        }
      }
    }

    return parts.join("\n---\n\n");
  }

  private static parseClaudeToMd(lines: string[]): string {
    const parts: string[] = [];

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const type = obj.type;

      if (type === "user") {
        const msg = obj.message || {};
        const content = typeof msg === "object" ? msg.content : "";
        let text = "";

        if (typeof content === "string" && content.length > 2) {
          text = content;
        } else if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "text" && c.text && c.text.length > 2) {
              text = c.text;
              break;
            }
          }
        }
        if (text) {
          parts.push(`## User\n\n${text}\n`);
        }
      } else if (type === "assistant") {
        const msg = obj.message || {};
        const content = msg.content;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const c of content) {
            if (c?.type === "text" && c.text) {
              textParts.push(c.text);
            } else if (c?.type === "tool_use") {
              const name = c.name || "";
              const inp = c.input || {};
              const fp = inp.file_path || "";
              if (["Write", "Edit", "MultiEdit"].includes(name) && fp) {
                textParts.push(`*[Tool: ${name} → ${fp}]*`);
              }
            }
          }
          const text = textParts.join("\n\n");
          if (text.length > 3) {
            parts.push(`## Assistant\n\n${text}\n`);
          }
        }
      }
    }

    return parts.join("\n---\n\n");
  }

  private static extractUserText(raw: string): string {
    if (raw.includes("<user_query>")) {
      const s = raw.indexOf("<user_query>") + 12;
      const e = raw.indexOf("</user_query>");
      if (e > s) return raw.slice(s, e).trim();
    }
    if (
      raw.startsWith("<system_reminder>") ||
      raw.startsWith("<open_and_recently")
    ) {
      return "";
    }
    return raw.replace(/<[^>]+>/g, "").trim();
  }

  private static peekFirstPrompt(
    jsonlPath: string,
    source: "cursor" | "claude" | "vscode"
  ): string {
    try {
      const raw = fs.readFileSync(jsonlPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (const line of lines.slice(0, 10)) {
        const obj = JSON.parse(line);
        if (source === "cursor" && obj.role === "user") {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === "text") {
                const text = this.extractUserText(c.text || "");
                if (text.length > 5) return text.slice(0, 60);
              }
            }
          }
        }
        if (source === "claude" && obj.type === "user") {
          const content = obj.message?.content;
          if (typeof content === "string" && content.length > 5)
            return content.slice(0, 60);
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === "text" && c.text?.length > 5)
                return c.text.slice(0, 60);
            }
          }
        }
      }
    } catch {}
    return "";
  }

  private static convertToMarkdown(
    source: "cursor" | "claude" | "vscode",
    sessionId: string,
    jsonlPath: string
  ): string {
    return this.convertSessionToMarkdown(jsonlPath, source);
  }

  private static findCursorDir(workspaceRoot: string): string | undefined {
    const encoded = workspaceRoot.replace(/\//g, "-").replace(/^-/, "");
    const dir = path.join(
      os.homedir(),
      ".cursor",
      "projects",
      encoded,
      "agent-transcripts"
    );
    return fs.existsSync(dir) ? dir : undefined;
  }

  private static findClaudeDir(workspaceRoot: string): string | undefined {
    const encoded = workspaceRoot.replace(/\//g, "-");
    const base = path.join(os.homedir(), ".claude", "projects");
    for (const variant of [encoded, encoded.replace(/^-/, "")]) {
      const dir = path.join(base, variant);
      if (fs.existsSync(dir)) return dir;
    }
    return undefined;
  }

  private static getVSCodeUserDir(): string {
    switch (process.platform) {
      case "win32":
        return path.join(
          process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
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

  private static findVSCodeChatDir(workspaceRoot: string): string | undefined {
    const storageBase = path.join(this.getVSCodeUserDir(), "workspaceStorage");
    if (!fs.existsSync(storageBase)) return undefined;

    const folderUri = process.platform === "win32"
      ? `file:///${workspaceRoot.replace(/\\/g, "/")}`
      : `file://${workspaceRoot}`;
    for (const entry of fs.readdirSync(storageBase)) {
      const wsJson = path.join(storageBase, entry, "workspace.json");
      try {
        const data = JSON.parse(fs.readFileSync(wsJson, "utf-8"));
        const folder: string = data.folder || "";
        if (folder === folderUri || decodeURIComponent(folder) === folderUri) {
          const chatDir = path.join(storageBase, entry, "chatSessions");
          if (fs.existsSync(chatDir)) return chatDir;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private static parseVSCodeToMd(lines: string[]): string {
    // VS Code JSONL uses a replay format (kind=0/1/2 operations)
    // For export, we do a best-effort extraction of user/assistant text
    const parts: string[] = [];

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      // kind=1 SET or kind=2 ARRAY_REPLACE may contain request data
      if (obj.kind === 1 || obj.kind === 2) {
        const k = obj.k;
        const v = obj.v;
        if (!Array.isArray(k) || v === undefined) continue;

        // Look for request message text: k = ['requests', N, 'message', 'text']
        if (
          k.length === 4 &&
          k[0] === "requests" &&
          k[2] === "message" &&
          k[3] === "text" &&
          typeof v === "string" &&
          v.length > 3
        ) {
          parts.push(`## User\n\n${v}\n`);
        }

        // Look for response content in ARRAY_REPLACE: k = ['requests', N, 'response']
        if (
          k.length === 3 &&
          k[0] === "requests" &&
          k[2] === "response" &&
          Array.isArray(v)
        ) {
          const textParts: string[] = [];
          for (const item of v) {
            if (item?.value?.value) {
              textParts.push(item.value.value);
            }
          }
          if (textParts.length > 0) {
            const text = textParts.join("\n\n");
            if (text.length > 3) {
              parts.push(`## Assistant\n\n${text}\n`);
            }
          }
        }
      }
    }

    return parts.join("\n---\n\n");
  }
}
