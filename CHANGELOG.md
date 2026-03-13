# Changelog

All notable changes to the Promptrail extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/thisalihassan/promptrail/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/thisalihassan/promptrail/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/thisalihassan/promptrail/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/thisalihassan/promptrail/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/thisalihassan/promptrail/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/thisalihassan/promptrail/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/thisalihassan/promptrail/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/thisalihassan/promptrail/compare/v0.4.1...v0.4.3
[0.4.1]: https://github.com/thisalihassan/promptrail/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/thisalihassan/promptrail/releases/tag/v0.4.0
