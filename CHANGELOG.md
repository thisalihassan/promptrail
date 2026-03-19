# Changelog

All notable changes to the Promptrail extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.6] - 2026-03-15

### Removed
- **FileWatcher attribution pipeline** — the entire time-window based file attribution system has been removed. File changes are no longer tracked via disk monitoring. File attribution now comes exclusively from Cursor hooks (`hook_edits`), SQLite `toolFormerData`, or source-specific data (Claude JSONL, VS Code replay). This eliminates phantom file attributions from `git pull`, `make build`, and other concurrent disk activity.
- **`--hard` rollback mode** — Restore Files (hard reset) removed from CLI and extension. All rollback is now edit-based Cherry Revert using exact `old_string`/`new_string` reversal.
- **`applyFileWhitelist` / `resolveToolEditedFiles`** — watcher whitelist functions removed; no longer needed without the watcher pipeline

### Added
- **API retry deduplication** — consecutive identical hook prompts (from API key failures, rate limits) are collapsed to the last retry via `deduplicateHookRetries()`
- **Direct `filesChanged` from toolFormerData** — `parseCursorFromSQLite` and `parseCursorFromJSONL` now populate `filesChanged` directly from per-prompt tool data instead of relying on watcher time-windows

### Fixed
- **Hook-sourced tasks with 0 edits showed phantom files (BUG 21)** — with the watcher removed, empty `filesChanged` on hook-sourced tasks is authoritative
- **API retries bloated timeline (BUG 22)** — consecutive identical prompts from API failures are now collapsed

## [0.6.5] - 2026-03-17

### Added
- **Cursor hooks integration** — auto-provisions `.cursor/hooks/` with a hook script that captures `afterFileEdit`, `beforeSubmitPrompt`, `afterAgentResponse`, and `stop` events. Enables Claude-quality per-prompt edit tracking (exact `old_string`/`new_string` pairs), response viewing, and rollback for Cursor sessions.
- **`promptrail init` CLI command** — explicitly installs Cursor hooks (also auto-provisions silently on first use of any command)
- **Hook-backed session parsing** — Cursor sessions with hook data get exact edit/write records per prompt, bypassing the FileWatcher time-window attribution entirely
- **Hook response viewing** — `promptrail response` and the extension sidebar now show AI responses captured via hooks
- **File changes in SQLite** — new `file_changes` table in the shadow DB replaces `changes.json`, with automatic migration, batch inserts, range queries, and 30-day pruning
- **E2E test suite** — 3 full-pipeline scenarios (Claude, Cursor watcher, BUG 17 rollback noise) that create real workspaces and run Tracker end-to-end

### Fixed
- **Rollback file writes leak into other prompts (BUG 17)** — empty `toolEditedFiles` now blocks all watcher files instead of falling through to the session whitelist
- **No-edit prompt shows file changes (BUG 18)** — `resolveToolEditedFiles()` preserves the empty Set when the session has per-prompt data, so "no edits" is authoritative
- **Shadow DB misses assistant bubbles for later prompts (BUG 19)** — `shouldResnapshot()` compares cached vs readable assistant counts instead of checking `=== 0`
- **Claude Code slash commands appear as prompts (BUG 20)** — `isClaudeInternalMessage()` filters `/plugin`, `/help`, command output, and meta caveats from the timeline

### Changed
- **Extracted shared modules** — `mergeChangesInWindow`, `applyFileWhitelist`, `deduplicateTimestamps`, `resolveToolEditedFiles`, `isClaudeInternalMessage`, and `shouldResnapshot` extracted into tested, exported functions
- **All regression tests refactored** — tests now call the actual exported functions instead of reimplementing inline logic
- **WAL mode enabled** on the shadow DB for better concurrent access from hooks and the extension
- Landing page badge changed from "Open Source" to "Local-first"

## [0.6.4] - 2026-03-14

### Fixed
- **Search now works for Claude and VS Code sessions** — previously only searched Cursor sessions via FTS5. Now searches prompt text across all sources with direct matching, plus FTS5 for Cursor response text.
- **Search results show prompt index** — each result displays `#N` so you can immediately run `promptrail diff <N>` or `promptrail rollback <N>`
- **Search source label** — results were hardcoded to show `cursor`; now correctly shows `cursor` / `claude` / `vscode`
- **SQLite experimental warning suppressed** — `node:sqlite` no longer prints `ExperimentalWarning` to stderr

### Added
- **Search by file name** — `promptrail search "auth.ts"` finds prompts that edited files matching the query (works in both CLI and extension sidebar)
- **`--last` / `-n` flag for timeline** — `promptrail timeline -n 10` shows only the last N prompts. Default remains all.
- **Landing page** — `docs/index.html` for GitHub Pages deployment
- **Hero GIF** — terminal demo at `docs/hero.gif`, referenced in README

## [0.6.3] - 2026-03-13

### Added
- **Claude Code response viewing** — `promptrail response` now works for Claude Code sessions, reading responses directly from JSONL (text replies + tool calls with file paths and commands)
- **Claude Code plugin marketplace** — repo is now a Claude Code plugin marketplace. Install with `/plugin marketplace add thisalihassan/promptrail` then `/plugin install promptrail@promptrail`
- **Claude Code plugin README** — full installation and usage docs at `claude-plugin/README.md`

### Changed
- **Claude Code plugin skills rewritten** — all 7 skills (architecture, timeline, diff, response, search, rollback, sessions) are now Claude Code-focused with `--source claude` defaults. Removed Cursor/VS Code references.
- Removed `vscode-chat-internals` skill from Claude Code plugin (irrelevant for Claude Code users)

## [0.6.2] - 2026-03-13

### Added
- **Assistant response capture** — shadow DB now preserves AI responses (text replies + tool calls) per prompt before Cursor prunes bubble data. New `assistant_bubbles` table with append-only snapshots.
- **View Response** button in the timeline sidebar — available on every prompt, opens the AI's full response as a markdown document
- **`promptrail response <n|text>`** CLI command — view AI response for any prompt by number or text match (shortcut: `r`)
- **`Promptrail: View AI Response`** extension command — also available from the command palette
- **Full-text search** across prompts and AI responses via SQLite FTS5 — search by keywords, code symbols, or concepts
- **`promptrail search <query>`** CLI command — search with `--source` and `--model` filters, results show highlighted snippets from matching prompts and responses
- **Sidebar search enhanced** — typing 3+ characters now also searches AI response text via FTS5, surfacing prompts that match only in the response

## [0.6.1] - 2026-03-13

### Fixed
- Re-publish of 0.6.0 — the v0.6.0 git tag was created before the fix PR was merged, so CI deployed 0.5.2 code labeled as 0.6.0. This release contains the actual 0.6.0 changes.

## [0.6.0] - 2026-03-12

### Added
- **SQLite-first architecture** for Cursor sessions — uses SQLite user bubbles as the canonical prompt list instead of JSONL, eliminating duplicate entries, auto-continue noise, and index alignment issues
- **Shadow DB** (`.promptrail/promptrail.db`) — caches Cursor's bubble data (text, timestamps, per-prompt files, tool calls) on first read. Survives Cursor pruning, timestamp collapse, and session restarts. Append-only incremental sync.
- **Home-directory path normalization** — files outside the workspace (e.g. `~/.cursor/plans/`) now display as home-relative paths instead of absolute paths
- 162 tests (up from 102), including regression tests for 16 specific bugs discovered in Cursor's data model

### Fixed
- Cursor sessions with pruned bubble data (500+ bubbles) now fall through to JSONL parsing instead of showing empty prompts
- Cursor sessions with collapsed timestamps (all bubbles same `createdAt`) detected and spread across session range
- Per-prompt file attribution accuracy improved from ~17% to ~88% against verified ground truth
- Timeline no longer shows duplicate prompts from JSONL re-sends
- Timeline no longer shows phantom "auto-continue" prompts injected by Cursor's agent restart mechanism
- `toolEditedFiles` whitelist now correctly falls back to showing files from SQLite when file watcher has no matching data in the time window
- Plan files (`.cursor/plans/`) now tracked with correct relative paths

## [0.5.2] - 2026-03-11

### Fixed
- Prompt-to-file attribution drift: short prompts ("yes", "ok") were skipped by JSONL parser but counted by SQLite, causing `toolFormerData` file edits to map to the wrong prompt
- Informational prompts no longer show files from manual user actions (`git pull`, `npm version`, etc.) — `toolEditedFiles` now uses empty Set instead of undefined
- Never skip user messages regardless of length — prompt index always matches SQLite bubble count

### Added
- 10 new integration tests for whitelist filtering, index alignment, and the undefined vs empty Set distinction

## [0.5.1] - 2026-03-11

### Added
- `promptrail --version` / `-v` CLI flag
- Known Limitations section in README

### Changed
- Updated README with Cherry Revert / Restore Files rollback modes and `--hard` CLI flag
- Updated ROADMAP with completed features
- Rollback command description updated in package.json

### Fixed
- Action buttons (View Diff, Cherry Revert, Restore Files) no longer shown on prompts with no file changes

## [0.5.0] - 2026-03-11

### Added
- **Cherry Revert**: undo a single prompt's changes without affecting earlier or later prompts (like `git revert` instead of `git reset`)
- **Restore Files**: hard reset option that restores files to their exact pre-prompt state
- Dual rollback modes: user chooses Cherry Revert or Restore Files in both extension UI and CLI (`--hard` flag)
- Per-prompt file attribution from Cursor SQLite `toolFormerData` — filters out `git pull`, manual edits, and other non-AI file changes from the watcher
- LCS-based line diff with context-aware hunk matching for Cursor prompt rollback
- Exact `old_string`/`new_string` reversal for Claude prompt rollback
- Conflict detection when a later prompt modified the same lines
- Per-file rollback status in both extension UI and CLI (reverted, deleted, recreated, conflict)
- CHANGELOG.md for VS Code marketplace
- 29 new tests covering selective revert scenarios

### Fixed
- File watcher no longer attributes `git pull` or manual user edits to AI prompts

## [0.4.3] - 2026-03-11

### Added
- Release CI workflow
- Published to Open VSX Registry

### Fixed
- Workspace path checks for CLI and extension
- CLI now shows latest prompts first in timeline
- CI workflow branch reference (`main` → `master`)

## [0.4.1] - 2026-03-11

### Fixed
- npm release command

## [0.4.0] - 2026-03-10

### Added
- Initial public release
- Hybrid data model: SQLite metadata + file watcher for real-time change tracking
- Claude Code session parsing (JSONL with tool_use blocks)
- Cursor session parsing (JSONL + SQLite for timestamps, V0 content, model info)
- Timeline webview sidebar with search, source/model filtering, and collapsible groups
- Per-prompt file attribution via timestamp-window matching
- Diff viewer (VS Code native diff for Cursor, hunk-based for Claude)
- Rollback support for Cursor prompts via file watcher snapshots
- Conversation export to Markdown
- Session migration between workspaces (export/import with path rewriting)
- Standalone CLI (`promptrail timeline`, `diff`, `rollback`, `sessions`, `migrate`, `export`, `import`)
- `.gitignore` respect with `NEVER_IGNORE` for `.cursor/` and `.claude/`
- 102 tests covering core logic and 10+ regression bugs

### Fixed
- `.promptrail/` excluded from git tracking via `.git/info/exclude`

[Unreleased]: https://github.com/thisalihassan/promptrail/compare/v0.6.6...HEAD
[0.6.6]: https://github.com/thisalihassan/promptrail/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/thisalihassan/promptrail/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/thisalihassan/promptrail/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/thisalihassan/promptrail/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/thisalihassan/promptrail/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/thisalihassan/promptrail/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/thisalihassan/promptrail/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/thisalihassan/promptrail/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/thisalihassan/promptrail/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/thisalihassan/promptrail/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/thisalihassan/promptrail/compare/v0.4.1...v0.4.3
[0.4.1]: https://github.com/thisalihassan/promptrail/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/thisalihassan/promptrail/releases/tag/v0.4.0
