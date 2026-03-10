# Promptrail

**Git tracks what changed. Promptrail tracks why the agent changed it.**

Prompt-level version control for AI code editing. Every agent instruction becomes a tracked changeset with full provenance, diffs, and selective rollback.

## The Problem

You ask an AI agent to refactor a function. It edits 4 files. You ask it to add error handling. It edits 6 more. After a few rounds you have no idea:

- Which prompt caused which changes
- Why the agent touched a seemingly unrelated file
- How to undo just one specific instruction without losing everything after it

Cursor checkpoints help but only show a flat list. Git commits are too coarse. Neither tracks the *intent* behind each change.

## How It Works

Promptrail reads your AI sessions automatically — no manual tagging, no configuration. It builds a timeline where each entry is a **prompt** with its associated file changes.

### Supported Agents

| Agent | Prompt Source | File Change Source | Diff Quality |
|-------|-------------|-------------------|--------------|
| **Cursor** | JSONL transcripts | Real-time file watcher + SQLite metadata | Full before/after snapshots |
| **Claude Code** | JSONL with tool_use blocks | Parsed directly from JSONL | Edit-level hunks (old_string/new_string) |

### What You Can Do

- **Browse**: See every prompt in the sidebar timeline, grouped by source (Cursor / Claude)
- **Trace**: See exactly which files changed for each prompt, with model and mode badges
- **Diff**: View before/after diffs for any prompt's changes
- **Rollback**: Revert a specific prompt's changes without losing unrelated work
- **Export**: Export any conversation to markdown
- **Search**: Filter prompts by text or file name
- **Filter**: Toggle to show only prompts that changed files

## Extension Commands

| Command | Description |
|---------|-------------|
| `Promptrail: Refresh Timeline` | Refresh the sidebar timeline |
| `Promptrail: View Task Diff` | Open before/after diffs for a prompt's changes |
| `Promptrail: Rollback to Task` | Restore workspace to before a prompt's edits |
| `Promptrail: Export Chat to Markdown` | Export a conversation as `.md` |

## CLI

Promptrail also ships a standalone CLI that works from any terminal — no editor needed.

```bash
promptrail timeline              # List all prompts with file counts and model badges
promptrail timeline --files      # Include file lists per prompt
promptrail diff 3                # Show diff for prompt #3
promptrail diff "refactor auth"  # Diff for prompt matching text
promptrail rollback 5            # Rollback prompt #5's changes
promptrail sessions              # List all sessions
```

Shortcuts: `tl` for timeline, `d` for diff, `rb` for rollback, `s` for sessions.

After installing globally (`npm install -g .` or via `npx`), run from your project root.

## Installation

### From Source

```bash
git clone https://github.com/thisalihassan/promptrail
cd promptrail
npm install
npm run build
npm run package
```

Install the generated `.vsix`:

```bash
cursor --install-extension promptrail-0.3.0.vsix
```

### For Development

Open the repo in Cursor/VS Code and press `F5` to launch the Extension Development Host.

### Build Commands

| Command | What it builds |
|---------|---------------|
| `npm run build` | Extension + CLI |
| `npm run build:ext` | Extension only |
| `npm run build:cli` | CLI only |
| `npm run watch` | Watch both |
| `npm run watch:ext` | Watch extension only |
| `npm run watch:cli` | Watch CLI only |
| `npm run package` | Create `.vsix` for distribution |
| `npm run release` | Build, package, and bump version |

## Architecture

Promptrail uses a **hybrid approach** combining three data sources:

**SQLite** (`node:sqlite`) — Reads Cursor's internal `state.vscdb` for real per-message timestamps, original file content (V0), file-to-prompt attribution via bubble IDs, and model/mode metadata. Queried once per session and cached in memory.

**File Watcher** — Maintains a content cache of all workspace files. When any file changes on disk, captures before (from cache) and after (from disk) content with a `Date.now()` timestamp. Changes are attributed to prompts by matching timestamps to prompt time windows. Changes during Claude Code prompt windows are automatically excluded (Claude tracks its own changes via JSONL).

**JSONL Transcripts** — Parsed for prompt text. Cursor transcripts only contain text (no tool calls). Claude Code transcripts contain full `tool_use` blocks with file paths, `old_string`/`new_string` for edits, and `content` for writes.

The file watcher respects `.gitignore` patterns but always tracks `.cursor/` and `.claude/` directories regardless of gitignore. Snapshots are stored in `.promptrail/snapshots/` and survive extension reloads.

### Platform Support

| Platform | Status |
|----------|--------|
| macOS | Fully supported |
| Linux | Supported (reads from `~/.config/Cursor/`) |
| Windows | Supported (reads from `%APPDATA%/Cursor/`) |

## Design Principles

- **Zero configuration** — reads existing sessions automatically, no setup needed
- **Intent over commits** — the unit of navigation is the prompt, not the file or commit
- **Durable across sessions** — snapshots survive editor restarts
- **Local-first** — all data stays in `.promptrail/` in your project root
- **Git-compatible** — works alongside git without replacing it
- **Zero native dependencies** — uses `node:sqlite` built into Cursor's runtime, no compiled binaries
- **Smart filtering** — respects `.gitignore`, excludes Claude Code changes from Cursor prompt attribution

## License

MIT
