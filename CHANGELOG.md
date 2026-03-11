# Changelog

All notable changes to the Promptrail extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Action buttons (View Diff, Cherry Revert, Restore Files) hidden on prompts with no file changes

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

[Unreleased]: https://github.com/thisalihassan/promptrail/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/thisalihassan/promptrail/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/thisalihassan/promptrail/compare/v0.4.1...v0.4.3
[0.4.1]: https://github.com/thisalihassan/promptrail/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/thisalihassan/promptrail/releases/tag/v0.4.0
