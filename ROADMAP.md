# Roadmap

## Done

- **Standalone CLI** — available via `npm install -g promptrail`
- **Cursor extension** — published on [Open VSX](https://open-vsx.org/extension/thisalihassan/promptrail) and [npm](https://www.npmjs.com/package/promptrail)
- **Session migration** — migrate sessions between workspaces via `promptrail migrate`
- **Claude Code plugin** — native integration via Claude Code hooks
- **Cherry Revert** — undo a single prompt's changes without affecting other prompts (LCS diff + reverse-patch for Cursor, exact string reversal for Claude)
- **Restore Files** — hard reset files to their pre-prompt state for Cursor sessions
- **Dual rollback modes** — user chooses Cherry Revert or Restore Files in extension UI and CLI (`--hard`)
- **Per-prompt file attribution** — uses Cursor SQLite `toolFormerData` to filter out `git pull` and manual edits from the file watcher
- **SQLite-first Cursor parsing** — uses SQLite user bubbles as canonical prompt list, eliminating JSONL noise (duplicates, auto-continues)
- **Shadow DB** — `.promptrail/promptrail.db` caches Cursor bubble data before it gets pruned or collapsed
- **Assistant response capture** — shadow DB preserves AI responses (text + tool calls) per prompt before Cursor prunes bubble data
- **View Response** — view AI responses in extension sidebar and CLI (`promptrail response <n>`)
- **Full-text search** — FTS5-powered search across prompts and responses in CLI (`promptrail search`) and sidebar
- **Claude Code plugin marketplace** — installable via `/plugin marketplace add thisalihassan/promptrail`
- **Claude Code response viewing** — `promptrail response` works for Claude Code sessions
- **CHANGELOG** — marketplace-ready changelog
- **Cross-source search** — search works for Claude and VS Code sessions, not just Cursor
- **File name search** — `promptrail search "auth.ts"` finds prompts that edited matching files
- **Timeline pagination** — `promptrail timeline -n 10` limits output to last N prompts
- **Landing page** — GitHub Pages site at `docs/`

## Planned

- **Linux/Windows testing** — verify all platform paths
- **Claude Code: Restore Files** — hard reset for Claude sessions (data path exists via file watcher, implementation deferred)
- **Windsurf/Copilot support** — read sessions from other AI coding agents
