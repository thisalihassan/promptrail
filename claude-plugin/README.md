# Promptrail — Claude Code Plugin

Prompt-level version control for Claude Code. Browse, search, diff, and rollback AI changes by intent.

## Installation

### 1. Install the CLI

```bash
npm install -g promptrail
```

### 2. Install the plugin

From inside Claude Code, run:

```
/plugin marketplace add thisalihassan/promptrail
/plugin install promptrail@promptrail
```

That's it. The plugin is now installed and sessions are automatically tracked via hooks.

### Alternative: per-session usage

If you prefer not to install permanently, clone the repo and use `--plugin-dir`:

```bash
git clone https://github.com/thisalihassan/promptrail.git
claude --plugin-dir ./promptrail/claude-plugin
```

## Usage

Run from your project root. Always use `--source claude` to see only Claude Code sessions.

### Timeline — see what the AI did

```bash
promptrail timeline --files --source claude
```

### Diff — see what a prompt changed

```bash
promptrail diff 3 --source claude
promptrail diff "refactor auth" --source claude
```

### Response — see the AI's full reply

```bash
promptrail response 3 --source claude
```

### Search — find past conversations

```bash
promptrail search "database optimization" --source claude
```

### Rollback — undo a prompt's changes

```bash
promptrail rollback 5 --source claude
```

### Sessions — list all sessions

```bash
promptrail sessions --source claude
```

### Filters

```bash
promptrail timeline --files --source claude --model sonnet
```

## How It Works

The plugin uses Claude Code hooks to log file changes. The Promptrail CLI reads Claude Code's JSONL session files at `~/.claude/projects/<workspace>/` to build the timeline, diffs, and rollback data.

Claude Code JSONL is self-contained — it has prompts, timestamps, tool calls with exact `old_string`/`new_string`, and full file contents. No SQLite or file watcher needed.

## Available Skills

The plugin includes these skills that Claude Code can use:

| Skill | Description |
|-------|-------------|
| **timeline** | Show all prompts with file change counts |
| **diff** | Show file-level diff for a prompt |
| **response** | View the AI's full response for a prompt |
| **search** | Full-text search across prompts and responses |
| **rollback** | Undo a prompt's file changes |
| **sessions** | List all sessions |
| **architecture** | How Promptrail works internally |
