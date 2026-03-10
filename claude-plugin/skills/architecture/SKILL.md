---
description: Architecture guide for the Promptrail extension. Use when the user asks about how Promptrail works internally, its data model, module structure, design decisions, known limitations, or wants to understand the codebase before making changes.
---

# Promptrail Architecture

VS Code / Cursor extension that reads AI agent sessions (Claude Code + Cursor) and presents a timeline of prompts with per-prompt file attribution, diffs, rollback, and a standalone CLI.

## Module Map

```
src/
  extension.ts          -- VS Code activation, command registration
  cli/
    index.ts            -- Standalone CLI (timeline, diff, rollback, sessions)
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
tests/
  *.test.ts             -- 102 tests covering all core logic + regression bugs
  fixtures/             -- Mock JSONL, SQLite DB, gitignore, changes.json
  mocks/vscode.ts       -- VS Code API mock for test builds
```

## Hybrid Architecture

Two data sources for Cursor sessions:

- **SQLite** (`node:sqlite`, read-only, cached): real timestamps, V0 file content, model/mode metadata, first-edit attribution
- **File Watcher** (real-time): captures actual before/after content when files change, matched to prompts by timestamp windows

Claude Code sessions are self-contained: JSONL has prompts, timestamps, and full tool_use blocks.

### Why Hybrid (Not Pure SQLite)

We tried pure SQLite checkpoint-based tracking. It had 8 bugs:
1. Checkpoint diffs get internally rewritten between prompts (phantom changes)
2. `firstEditBubbleId` only tracks first edit (re-edits invisible)
3. Deleted files produce phantom diffs for every prompt
4. Newly created files appear under all subsequent prompts
5. `node:sqlite` returns timestamps as strings (silent NaN comparison failure)
6. `better-sqlite3` ABI mismatch (silent failure in Electron)
7. Informational prompts showed file changes
8. `dist/` files leaked through broken gitignore matching

The file watcher solves all of these by capturing actual disk writes with real timestamps.

## Data Flow

```
Tracker polls every 4s
  |-> SessionReader.readAllTasks()
  |     |-> Claude: parse JSONL (prompts + tool_use)
  |     |-> Cursor: parse JSONL (prompts only) + SQLite (timestamps, V0, model)
  |-> FileWatcher.getChangesInWindow(startTs, endTs, claudeWindows)
  |     |-> Filter changes by timestamp window
  |     |-> Exclude changes inside Claude prompt windows
  |-> Override Cursor task.filesChanged with watcher data
  |-> TimelineProvider renders in webview
```

## Key Design Decisions

### Timestamp window matching (not task ID tagging)

The watcher records every change with `Date.now()`. At query time, the Tracker matches changes to prompts: a change between prompt N's `createdAt` and prompt N+1's `createdAt` belongs to prompt N.

### Claude window exclusion

The Tracker builds time windows for all Claude prompts. When querying watcher changes for a Cursor prompt, changes inside Claude windows are filtered out.

### `.gitignore` respect with NEVER_IGNORE

The watcher reads `.gitignore` at startup. `.cursor/` and `.claude/` are protected from ignoring. `.git/` and `.promptrail/` are always ignored.

### `toEpochMs()` for all SQLite timestamps

`node:sqlite` may return timestamps as ISO strings instead of numbers. `toEpochMs()` handles both formats.

### SQLite caching (10-second TTL)

`getOrLoadSession()` reads composerData + all bubble timestamps + file mapping in one DB open/close and caches for 10 seconds.

## Known Bugs / Limitations

- File watcher only captures changes while the extension is running
- `.gitignore` is read once at startup; changes mid-session require reload
- Claude Code rollback not yet implemented (diffs show edit hunks, not full file before/after)
- Model/mode is session-level from SQLite, not per-prompt
- Windows path encoding may not handle backslashes correctly

## Platform Paths

| Data | Path |
|------|------|
| Cursor SQLite DB | Platform-dependent: `getCursorUserDir()` in `cursor-history.ts` |
| Cursor transcripts | `~/.cursor/projects/<workspace>/agent-transcripts/` |
| Claude sessions | `~/.claude/projects/<workspace>/` |
| Watcher snapshots | `.promptrail/snapshots/changes.json` in workspace root |
