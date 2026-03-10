# Promptrail - VS Code/Cursor Extension

## Quick Reference

VS Code extension that reads AI agent sessions (Claude Code + Cursor) and presents a timeline of prompts with per-prompt file attribution, diffs, and rollback.

### Module Map

```
src/
  extension.ts          -- VS Code activation, command registration
  core/
    cursor-history.ts   -- SQLite interface to Cursor's state.vscdb (via node:sqlite)
    session-reader.ts   -- Parses Claude + Cursor sessions into Task[]
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

Hybrid data model: SQLite metadata (cached, read-only) + file watcher (real-time snapshots).

- **Cursor sessions**: JSONL for prompts, SQLite for timestamps/file attribution, file watcher for actual diffs
- **Claude sessions**: JSONL contains everything (tool_use blocks with old_string/new_string)
- Polling interval: 4 seconds
- SQLite cache TTL: 10 seconds
- Snapshots stored in `.promptrail/snapshots/<taskId>/files.json`

### Key Design Decisions

- Cursor's SQLite checkpoint diffs are unreliable for per-prompt diffs (get rewritten internally), so file watcher captures actual disk changes
- `firstEditBubbleId` only tracks first edit per file; checkpoint comparison needed for re-edits
- Cursor JSONL has NO tool_use blocks -- only text messages

### Detailed References

For in-depth documentation on Cursor internals, see the skills files:
- `.cursor/skills/promptrail-architecture/SKILL.md` -- full architecture guide
- `~/.cursor/skills/cursor-sqlite-internals/SKILL.md` -- Cursor SQLite schema
- `~/.cursor/skills/cursor-agent-session-data/SKILL.md` -- extracting session data
