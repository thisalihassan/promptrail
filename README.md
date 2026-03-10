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

| Agent | Diff Quality |
|-------|--------------|
| **Cursor** | Full before/after snapshots |
| **Claude Code** | Edit-level hunks |

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

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=thisalihassan.promptrail) or search "Promptrail" in Cursor/VS Code extensions.

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | Fully supported |
| Linux | Supported |
| Windows | Supported |

## License

MIT
