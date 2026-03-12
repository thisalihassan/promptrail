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
- **CHANGELOG** — marketplace-ready changelog

## Planned

- **Linux/Windows testing** — verify all platform paths
- **Claude Code: Restore Files** — hard reset for Claude sessions (data path exists via file watcher, implementation deferred)
- **Windsurf/Copilot support** — read sessions from other AI coding agents
