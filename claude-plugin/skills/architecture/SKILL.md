---
description: Architecture guide for the Promptrail CLI. Use when the user asks about how Promptrail works, its data model, CLI commands, or wants to understand the tool before making changes.
---

# Promptrail Architecture

CLI tool that reads Claude Code sessions and presents a timeline of prompts with per-prompt file attribution, diffs, search, and rollback.

## CLI Commands

```
promptrail timeline [--files]        All prompts with file counts
promptrail diff <n|text>             Diff for prompt #n or matching text
promptrail response <n|text>         AI response for prompt #n or matching text
promptrail search <query>            Full-text search across prompts and responses
promptrail rollback <n|text>         Cherry revert prompt's changes
promptrail sessions                  List all sessions
```

Filters: `--source claude` (always use this), `--model <substring>`
Shortcuts: `tl`, `d`, `r`, `rb`, `s`

## How Claude Code Data Works

Claude Code JSONL at `~/.claude/projects/<encoded-workspace>/` is self-contained. Each session file has:

- **User messages**: `role: "human"`, `content[].text` contains the prompt
- **Assistant messages**: `role: "assistant"` with `content[]` containing text blocks and `tool_use` blocks
- **Tool use blocks**: `type: "tool_use"` with `name` (Edit, Write, etc.) and `input` containing `file_path`, `old_string`, `new_string`, or `content`
- **Timestamps**: Each message has a real timestamp

No SQLite or file watcher needed -- the JSONL has everything for prompts, file changes, and rollback.

### Edit Tools in Claude Code JSONL

| Tool Name | Purpose | Key Fields |
|-----------|---------|------------|
| `Edit` | String replacement | `file_path`, `old_string`, `new_string` |
| `Write` | File creation/overwrite | `file_path`, `content` |
| `MultiEdit` | Multiple edits in one call | `file_path`, `edits[]` |

## Data Flow

```
SessionReader.readAllTasks()
  |-> Parse Claude Code JSONL (prompts + tool_use blocks for file changes)
  |-> Returns Task[] sorted chronologically
```

Each Task has: `id`, `prompt`, `createdAt`, `filesChanged`, `source`, `model`

## Key Files

| File | Purpose |
|------|---------|
| `src/cli/index.ts` | CLI entry point, all commands |
| `src/core/session-reader.ts` | Parses Claude Code sessions into Task[] |
| `src/core/selective-revert.ts` | Cherry revert logic (exact string matching) |
| `src/models/types.ts` | Shared interfaces (Task, FileChange, etc.) |

## Platform Paths

| Data | Path |
|------|------|
| Claude sessions | `~/.claude/projects/<workspace>/` |
| Shadow DB | `.promptrail/promptrail.db` in workspace root |

## Known Limitations

- Claude Code rollback uses selective string-matching revert (exact `old_string`/`new_string` from tool calls), not full file before/after snapshots
- Hard rollback (Restore Files) is not yet supported for Claude Code sessions
