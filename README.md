# Promptrail

**git blame, but for AI coding agents.**

See which prompt changed which files. View diffs and rollback by intent. Works with Cursor and Claude Code.

<p align="center">
  <img src="https://raw.githubusercontent.com/thisalihassan/promptrail/master/docs/hero.gif" alt="Promptrail demo" width="800">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/promptrail"><img src="https://img.shields.io/npm/v/promptrail" alt="npm"></a>
  <a href="https://open-vsx.org/extension/thisalihassan/promptrail"><img src="https://img.shields.io/open-vsx/v/thisalihassan/promptrail" alt="Open VSX"></a>
  <a href="https://github.com/thisalihassan/promptrail/blob/main/LICENSE"><img src="https://img.shields.io/github/license/thisalihassan/promptrail" alt="License"></a>
</p>

```bash
npx promptrail timeline
```

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
- **View Response**: Read the AI's full response for any prompt (text replies + tool calls)
- **Cherry Revert**: Undo a specific prompt's changes without losing unrelated work
- **Restore Files**: Hard reset files to their exact state before a prompt (overwrites later edits)
- **Export**: Export any conversation to markdown
- **Search**: Full-text search across prompts and AI responses (FTS5), or filter by file name
- **Filter**: Toggle to show only prompts that changed files

## Extension Commands

| Command | Description |
|---------|-------------|
| `Promptrail: Refresh Timeline` | Refresh the sidebar timeline |
| `Promptrail: View Task Diff` | Open before/after diffs for a prompt's changes |
| `Promptrail: View AI Response` | View the AI's response for a prompt (text + tool calls) |
| `Promptrail: Rollback to Task` | Cherry Revert or Restore Files — choose rollback mode |
| `Promptrail: Export Chat to Markdown` | Export a conversation as `.md` |

## Installation

### CLI

```bash
npm install -g promptrail
```

Or run directly without installing:

```bash
npx promptrail timeline
```

### Cursor Extension

Install from [Open VSX](https://open-vsx.org/extension/thisalihassan/promptrail):

```bash
cursor --install-extension thisalihassan.promptrail
```

### From Source (CLI + Extension)

```bash
git clone https://github.com/thisalihassan/promptrail
cd promptrail
npm install
npm run build
```

Install the CLI globally from the local build:

```bash
npm link
# Now you can run: promptrail timeline
```

Or run it directly without linking:

```bash
node dist/cli.js timeline
```

To install the extension locally:

```bash
npm run package
cursor --install-extension promptrail-*.vsix
```

### Claude Code Plugin

Promptrail includes a Claude Code plugin that adds skills for timeline, diff, search, response, and rollback. Install from inside Claude Code:

```
/plugin marketplace add thisalihassan/promptrail
/plugin install promptrail@promptrail
```

Once installed, Claude Code sessions are automatically tracked via hooks. The timeline, diffs, search, and rollback all work through the CLI. See [claude-plugin/README.md](claude-plugin/README.md) for full usage.

### For Development

Open the repo in Cursor and press `F5` to launch the Extension Development Host.

## CLI Usage

Run from your project root:

```bash
promptrail timeline              # List all prompts with file counts and model badges
promptrail timeline --files      # Include file lists per prompt
promptrail timeline -n 10        # Show only the last 10 prompts
promptrail diff 3                # Show diff for prompt #3
promptrail diff "refactor auth"  # Diff for prompt matching text
promptrail response 3            # Show AI response for prompt #3
promptrail search "shadow DB"    # Search prompts and responses (FTS5)
promptrail search "auth.ts"      # Search by file name
promptrail rollback 5            # Cherry revert prompt #5 (preserves later edits)
promptrail rollback 5 --hard     # Restore files to state before prompt #5
promptrail --version             # Print version
promptrail sessions              # List all sessions
promptrail migrate ../old-project  # Copy sessions from another workspace
```

### Filters

```bash
promptrail timeline -s claude    # Only Claude Code prompts
promptrail timeline -s cursor    # Only Cursor prompts
promptrail timeline -m sonnet    # Only prompts using sonnet models
```

Shortcuts: `tl` for timeline, `d` for diff, `r` for response, `rb` for rollback, `s` for sessions, `mg` for migrate. Search has no shortcut to avoid collision with `sessions`.

### Session Migration

AI agents often edit files across workspace boundaries. You're working on a backend repo and Cursor starts editing the frontend, or Claude Code touches a shared library in a different project. The chats live in the wrong workspace — you can't see the timeline, diffs, or rollback where the changes actually happened.

`migrate` copies all session history from one workspace to another so you can track everything from the right place.

```bash
cd /path/to/frontend
promptrail migrate /path/to/backend
```

**What gets copied:**

- **Cursor chats** — transcripts and sidebar entries, so imported chats show up in Cursor's chat panel
- **Cursor metadata** — timestamps, file attribution, checkpoints, code blocks
- **Claude Code sessions** — session files including subagent and tool-result data
- **File snapshots** — change history merged with deduplication

All embedded workspace paths are automatically rewritten from source to target. The source workspace is never modified — everything is copied, not moved.

## Known Limitations

- **Rollback requires the extension to have been running** during the AI's edits. The file watcher captures before/after snapshots in real time — if the extension wasn't active, there's no snapshot data for rollback.
- **Restore Files not yet supported for Claude Code sessions.** Cherry Revert works for Claude (uses exact `old_string`/`new_string` from tool calls). Restore Files is planned.
- **Cherry Revert may conflict** if a later prompt modified the same lines or strings. Conflicts are reported per-file so you know what couldn't be reverted.

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | Fully supported |
| Linux | Supported |
| Windows | Supported |

## License

Promptrail is licensed under the Business Source License 1.1 (`BUSL-1.1`).

The Additional Use Grant allows personal use and internal business use,
including internal production use within your own organization. A separate
commercial license is required to sell Promptrail, offer it to third parties as
a hosted or managed service, bundle or embed it in a product or service
offered to third parties, white-label it, or otherwise commercialize it beyond
internal use.
