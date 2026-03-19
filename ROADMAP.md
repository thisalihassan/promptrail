# Roadmap

## Done

- **Standalone CLI** — available via `npm install -g promptrail`
- **Cursor extension** — published on [Open VSX](https://open-vsx.org/extension/thisalihassan/promptrail) and [npm](https://www.npmjs.com/package/promptrail)
- **Session migration** — migrate sessions between workspaces via `promptrail migrate`
- **Claude Code plugin** — native integration via Claude Code hooks
- **Cherry Revert** — undo a single prompt's changes without affecting other prompts (exact string reversal for Cursor hooks + Claude, LCS diff for legacy)
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
- **Cursor hooks** — auto-provisioned `.cursor/hooks/` captures `afterFileEdit`, `beforeSubmitPrompt`, `afterAgentResponse`, `stop` for Claude-quality per-prompt tracking in Cursor
- **`promptrail init`** — CLI command to explicitly install Cursor hooks
- **FileWatcher removed** — entire time-window attribution pipeline removed; file attribution now comes exclusively from hooks, SQLite toolFormerData, or source-specific data (no more phantom files from `git pull` or builds)
- **API retry deduplication** — consecutive identical hook prompts (from API key failures) collapsed to the last retry
- **E2E test suite** — full-pipeline tests (Claude, Cursor JSONL-only)

## Planned

- **Linux/Windows testing** — verify all platform paths
- **File deletion tracking** — `postToolUse` hook with `"Delete"` matcher for per-prompt delete attribution
- **Subagent file attribution** — `subagentStop` hook provides `modified_files` per subagent
- **Windsurf/Copilot support** — read sessions from other AI coding agents
