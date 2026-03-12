# Promptrail - VS Code/Cursor Extension

## Quick Reference

VS Code extension that reads AI agent sessions (Claude Code, Cursor, and VS Code Chat) and presents a timeline of prompts with per-prompt file attribution, diffs, and rollback.

### Module Map

```
src/
  extension.ts          -- VS Code activation, command registration
  core/
    cursor-history.ts   -- SQLite interface to Cursor's state.vscdb (via node:sqlite)
    promptrail-db.ts    -- Shadow DB (.promptrail/promptrail.db) caching Cursor data
    vscode-history.ts   -- VS Code Chat data reader (JSONL replay + chatEditingSessions)
    session-reader.ts   -- Parses Claude + Cursor + VS Code sessions into Task[]
    tracker.ts          -- Orchestrates tasks, watcher, changesets, rollback
    file-watcher.ts     -- Content cache + real-time snapshot capture
    exporter.ts         -- Exports conversations to markdown
  models/
    types.ts            -- Shared interfaces (Task, FileChange, etc.)
  views/
    timeline-provider.ts -- Webview sidebar (HTML/JS timeline UI)
```

### Build & Dev

- `npm run build` -- esbuild bundle to `dist/extension.js`
- Package: `npx @vscode/vsce package`
- Zero native dependencies; uses `node:sqlite` (built into Cursor's Electron/Node 22)

### Architecture

SQLite-first for Cursor sessions + file watcher for diffs. Self-contained for Claude and VS Code Chat.

- **Cursor sessions**: SQLite user bubbles are the canonical prompt list (not JSONL). Per-prompt file attribution via `toolFormerData`. File watcher for before/after diffs. Shadow DB (`.promptrail/promptrail.db`) caches SQLite data before Cursor prunes it.
- **Claude sessions**: JSONL contains everything (tool_use blocks with old_string/new_string)
- **VS Code Chat sessions**: JSONL replay format (kind 0/1/2 ops) + chatEditingSessions/state.json for per-request file ops. No watcher needed.
- Polling interval: 4 seconds
- SQLite cache TTL: 10 seconds
- Snapshots stored in `.promptrail/snapshots/changes.json`

### Key Design Decisions

- **SQLite-first for Cursor**: SQLite user bubbles are clean (no auto-continues, no duplicates). JSONL is noisy and used only as fallback.
- Cursor's SQLite checkpoint diffs are unreliable for per-prompt diffs, so file watcher captures actual disk changes
- `toolFormerData` on assistant bubbles tracks exactly which files each prompt edited
- `capabilityType=30` bubbles are user interaction responses (answers to questions) with empty text -- untraceable
- Shadow DB snapshots Cursor data before it gets pruned (BUG 13) or collapsed (BUG 12)
- VS Code Chat's chatEditingSessions gives exact per-prompt file attribution -- no watcher dependency

### Platform Support

All three sources support macOS, Linux, and Windows:
- `getCursorUserDir()` in cursor-history.ts handles platform-specific Cursor paths
- `getVSCodeUserDir()` in vscode-history.ts handles platform-specific VS Code paths
- Windows file:// URIs use 3 slashes + drive letter: `file:///C:/path`

### Detailed References

For in-depth documentation, see the skills files:
- `.cursor/skills/promptrail-architecture/SKILL.md` -- full architecture guide
- `.cursor/skills/vscode-chat-internals/SKILL.md` -- VS Code Chat data storage internals
- `~/.cursor/skills/cursor-sqlite-internals/SKILL.md` -- Cursor SQLite schema
- `~/.cursor/skills/cursor-agent-session-data/SKILL.md` -- extracting session data
