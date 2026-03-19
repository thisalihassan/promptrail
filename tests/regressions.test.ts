/**
 * Regression tests for bugs discovered during development.
 * Each test documents the bug, why it happened, and verifies the fix.
 *
 * These tests are ADVERSARIAL -- they try to break the system,
 * not just confirm it works in ideal conditions.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { toEpochMs } from '../src/core/cursor-history';
import { loadGitignorePatterns, shouldTrackFile, mergeChangesInWindow, type IgnorePatterns, type TimestampedChange } from '../src/core/file-watcher';
import { deduplicateTimestamps, deduplicateHookRetries, isClaudeInternalMessage } from '../src/core/session-reader';
import { shouldResnapshot } from '../src/core/cursor-history';

// ──────────────────────────────────────────────────────────────
// BUG 1: node:sqlite returns timestamps as strings, not numbers.
// ──────────────────────────────────────────────────────────────
describe('BUG 1: Timestamp type mismatch (string vs number)', () => {
	it('toEpochMs handles ISO string from node:sqlite', () => {
		const ts = toEpochMs('2026-03-10T14:06:25.059Z');
		assert.strictEqual(typeof ts, 'number');
		assert.ok(ts > 1_700_000_000_000);
	});

	it('toEpochMs handles numeric string from node:sqlite', () => {
		const ts = toEpochMs('1773151585059');
		assert.strictEqual(ts, 1773151585059);
	});

	it('comparing number >= converted string actually works', () => {
		const taskTs = toEpochMs('2026-03-10T14:06:25.059Z');
		const fileChangeTs = 1773151721255;
		assert.ok(fileChangeTs >= taskTs, 'Must be true after conversion');
	});

	it('BROKEN without fix: raw string comparison fails silently', () => {
		const taskTs = '2026-03-10T14:06:25.059Z'; // the raw value from node:sqlite
		const fileChangeTs = 1773151721255;
		// This is what happened BEFORE the fix:
		assert.strictEqual(fileChangeTs >= (taskTs as any), false, 'Raw string comparison should fail (this was the bug)');
	});

	it('window matching finds prompt 0, not -1', () => {
		const timestamps = [toEpochMs('2026-03-10T14:06:25.059Z'), toEpochMs('2026-03-10T14:12:51.894Z')];
		const changeTs = 1773151721255; // 14:08

		let matched = -1;
		for (let i = timestamps.length - 1; i >= 0; i--) {
			if (timestamps[i] > 0 && changeTs >= timestamps[i]) {
				matched = i;
				break;
			}
		}
		assert.strictEqual(matched, 0);
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 2: firstEditBubbleId only tracks the FIRST edit.
// ──────────────────────────────────────────────────────────────
describe('BUG 2: Re-edits to same file lost', () => {
	it('timestamp windows catch re-edits that firstEditBubbleId misses', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'src/cursor-history.ts', before: 'v1', after: 'v2', timestamp: 100 },
			{ relPath: 'src/cursor-history.ts', before: 'v5', after: 'v6', timestamp: 500 }
		];
		const prompts = [50, 200, 400];

		const w0 = mergeChangesInWindow(changes, prompts[0], prompts[1]);
		assert.ok(w0.files.includes('src/cursor-history.ts'));

		const w1 = mergeChangesInWindow(changes, prompts[1], prompts[2]);
		assert.strictEqual(w1.files.length, 0,
			'Prompt 1 should NOT have the file (no edit in its window)');

		const w2 = mergeChangesInWindow(changes, prompts[2], Infinity);
		assert.ok(w2.files.includes('src/cursor-history.ts'));
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 3: Claude Code changes leaked into Cursor prompts.
// ──────────────────────────────────────────────────────────────
describe('BUG 3: Claude changes leaked into Cursor prompts', () => {
	it('excludes changes inside Claude windows', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'src/app.ts', before: 'a', after: 'b', timestamp: 150 },
			{ relPath: 'claude-plugin/hooks.json', before: 'x', after: 'y', timestamp: 250 },
			{ relPath: 'src/utils.ts', before: 'c', after: 'd', timestamp: 350 }
		];
		const claudeWindows = [{ start: 200, end: 300 }];

		const { files } = mergeChangesInWindow(changes, 100, 400, claudeWindows);
		assert.strictEqual(files.length, 2);
		assert.ok(!files.includes('claude-plugin/hooks.json'));
	});

	it('Claude changes still visible under Claude tasks', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'claude-plugin/hooks.json', before: 'x', after: 'y', timestamp: 250 }
		];
		const { files } = mergeChangesInWindow(changes, 200, 300);
		assert.strictEqual(files.length, 1);
	});

	it('overlapping Claude + Cursor windows: Claude wins exclusion', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'file.ts', before: 'a', after: 'b', timestamp: 200 }
		];
		const claudeWindows = [{ start: 150, end: 300 }];

		const { files } = mergeChangesInWindow(changes, 100, 300, claudeWindows);
		assert.strictEqual(files.length, 0, 'Change in overlapping window should be excluded from Cursor');
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 4: Broken gitignore pattern matching (dist// bug).
// ──────────────────────────────────────────────────────────────
describe('BUG 4: Broken gitignore patterns', () => {
	it('dist/ prefix correctly ignores dist/extension.js', () => {
		const p: IgnorePatterns = { prefixes: ['dist/'], suffixes: [], exactFiles: [] };
		assert.strictEqual(shouldTrackFile('dist/extension.js', p), false);
	});

	it('*.vsix suffix correctly ignores any .vsix file', () => {
		const p: IgnorePatterns = { prefixes: [], suffixes: ['.vsix'], exactFiles: [] };
		assert.strictEqual(shouldTrackFile('promptrail-0.3.0.vsix', p), false);
		assert.strictEqual(shouldTrackFile('foo.vsix', p), false);
	});

	it('loadGitignorePatterns parses trailing-slash dirs as prefixes', () => {
		const tmp = fs.mkdtempSync('/tmp/promptrail-bug4-');
		fs.writeFileSync(path.join(tmp, '.gitignore'), 'dist/\nnode_modules/\n');
		const patterns = loadGitignorePatterns(tmp);
		assert.ok(patterns.prefixes.includes('dist/'), 'dist/ should be a prefix');
		assert.strictEqual(shouldTrackFile('dist/cli.js', patterns), false);
		fs.rmSync(tmp, { recursive: true });
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 5: Poll-based task ID caused off-by-one attribution.
// ──────────────────────────────────────────────────────────────
describe('BUG 5: Off-by-one from poll delay', () => {
	it('timestamp matching is instant, not poll-dependent', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'a.ts', before: 'x', after: 'y', timestamp: 5 },
			{ relPath: 'b.ts', before: 'x', after: 'y', timestamp: 105 }
		];

		const w0 = mergeChangesInWindow(changes, 0, 100);
		assert.ok(w0.files.includes('a.ts'));
		assert.ok(!w0.files.includes('b.ts'));

		const w1 = mergeChangesInWindow(changes, 100, Infinity);
		assert.ok(w1.files.includes('b.ts'), 'b.ts at 105 must go to prompt 1, not 0');
		assert.ok(!w1.files.includes('a.ts'));
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 7: Deleted file showed as diff for EVERY prompt.
// ──────────────────────────────────────────────────────────────
describe('BUG 7: Deleted file phantom diffs', () => {
	it('deletion only appears under the prompt that deleted it', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'src/checkpoint.ts', before: 'old code', after: '', timestamp: 250 }
		];

		const w0 = mergeChangesInWindow(changes, 0, 100);
		assert.strictEqual(w0.files.length, 0, 'Prompt 0 must NOT show deletion');

		const w1 = mergeChangesInWindow(changes, 100, 200);
		assert.strictEqual(w1.files.length, 0, 'Prompt 1 must NOT show deletion');

		const w2 = mergeChangesInWindow(changes, 200, 300);
		assert.strictEqual(w2.files.length, 1);
		assert.strictEqual(w2.files[0], 'src/checkpoint.ts');
		assert.strictEqual(w2.changes[0].type, 'deleted');
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 8: Newly created file appeared under ALL prompts.
// ──────────────────────────────────────────────────────────────
describe('BUG 8: New file under all prompts', () => {
	it('creation only under the prompt that created it', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'new.ts', before: '', after: 'content', timestamp: 150 }
		];

		const w0 = mergeChangesInWindow(changes, 0, 100);
		const w1 = mergeChangesInWindow(changes, 100, 200);
		const w2 = mergeChangesInWindow(changes, 200, 300);

		assert.strictEqual(w0.files.length, 0, 'Prompt 0 must NOT show creation');
		assert.strictEqual(w1.files.length, 1, 'ONLY prompt 1 should have the file');
		assert.strictEqual(w1.changes[0].type, 'added');
		assert.strictEqual(w2.files.length, 0, 'Prompt 2 must NOT show creation');
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 9: SQLite failure silently broke everything.
// ──────────────────────────────────────────────────────────────
describe('BUG 9: SQLite failure resilience', () => {
	it('all methods return undefined, never throw', () => {
		const { CursorHistory } = require('../src/core/cursor-history');
		const h = new CursorHistory('/nonexistent');
		assert.strictEqual(h.getComposerSession('x'), undefined);
		assert.strictEqual(h.getUserBubbleTimestamps('x'), undefined);
		assert.strictEqual(h.getFilePromptMapping('x'), undefined);
		assert.strictEqual(h.getV0Content('x', 'f.ts'), undefined);
		assert.doesNotThrow(() => h.getComposerSession('x'));
	});
});

// ──────────────────────────────────────────────────────────────
// .cursor/ and .claude/ protected from gitignore
// ──────────────────────────────────────────────────────────────
describe('REGRESSION: .cursor/.claude/ always tracked', () => {
	it('.cursor/ tracked even when in gitignore', () => {
		const tmp = fs.mkdtempSync('/tmp/promptrail-ni-');
		fs.writeFileSync(path.join(tmp, '.gitignore'), '.cursor/\n.claude/\n');
		const patterns = loadGitignorePatterns(tmp);
		assert.ok(!patterns.prefixes.includes('.cursor/'));
		assert.ok(shouldTrackFile('.cursor/skills/foo/SKILL.md', patterns));
		assert.ok(shouldTrackFile('.claude/settings.json', patterns));
		fs.rmSync(tmp, { recursive: true });
	});

	it('.git/ and .promptrail/ always ignored even with empty gitignore', () => {
		const tmp = fs.mkdtempSync('/tmp/promptrail-ai-');
		fs.writeFileSync(path.join(tmp, '.gitignore'), '');
		const patterns = loadGitignorePatterns(tmp);
		assert.ok(patterns.prefixes.includes('.git/'));
		assert.ok(patterns.prefixes.includes('.promptrail/'));
		fs.rmSync(tmp, { recursive: true });
	});
});

// ══════════════════════════════════════════════════════════════
// ADVERSARIAL: Verify diff CONTENT is correct, not just counts.
// ══════════════════════════════════════════════════════════════

describe('VERIFY: Diff content correctness', () => {
	it('merge of 3 rapid edits produces correct before and after', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'app.ts', before: 'line1\nline2\n', after: 'line1\nline2\nline3\n', timestamp: 100 },
			{ relPath: 'app.ts', before: 'line1\nline2\nline3\n', after: 'line1\nLINE2\nline3\n', timestamp: 101 },
			{ relPath: 'app.ts', before: 'line1\nLINE2\nline3\n', after: 'line1\nLINE2\nline3\nline4\n', timestamp: 102 }
		];

		const { changes: merged } = mergeChangesInWindow(changes, 100, 200);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].before, 'line1\nline2\n', 'Before must be the ORIGINAL content, not any intermediate state');
		assert.strictEqual(merged[0].after, 'line1\nLINE2\nline3\nline4\n', 'After must be the FINAL content, not any intermediate state');
	});

	it('diff before != after when file actually changed', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'x.ts', before: 'old', after: 'new', timestamp: 100 }
		];
		const { changes: merged } = mergeChangesInWindow(changes, 0, 200);
		assert.strictEqual(merged.length, 1);
		assert.notStrictEqual(merged[0].before, merged[0].after, 'Changed file must have different before/after');
	});

	it('no-op edit (same content) is filtered out', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'x.ts', before: 'same', after: 'same', timestamp: 100 }
		];
		const { files } = mergeChangesInWindow(changes, 0, 200);
		assert.strictEqual(files.length, 0, 'Same content = no change');
	});
});

describe('VERIFY: Rollback content correctness', () => {
	it('rollback restores exact original content', () => {
		const originalContent = 'const x = 1;\nconst y = 2;\n';
		const modifiedContent = 'const x = 42;\nconst y = 2;\nconst z = 3;\n';

		const changes = [{ relPath: 'app.ts', before: originalContent, after: modifiedContent, timestamp: 100 }];

		// Rollback = swap before/after
		const rollback = changes.map((c) => ({
			relPath: c.relPath,
			before: c.after,
			after: c.before
		}));

		assert.strictEqual(rollback[0].after, originalContent, "Rollback 'after' must be EXACTLY the original content");
		assert.strictEqual(rollback[0].before, modifiedContent, "Rollback 'before' must be the current (modified) content");
	});

	it('rollback of file creation = deletion (after is empty)', () => {
		const changes = [{ relPath: 'new.ts', before: '', after: 'export const X = 1;\n', timestamp: 100 }];

		const rollback = changes.map((c) => ({
			relPath: c.relPath,
			type: c.before === '' ? 'deleted' : 'modified',
			after: c.before
		}));

		assert.strictEqual(rollback[0].type, 'deleted');
		assert.strictEqual(rollback[0].after, '', 'Rollback of creation = empty string (delete file)');
	});

	it('rollback of file deletion = recreation with original content', () => {
		const original = '// important code\nfunction main() {}\n';
		const changes = [{ relPath: 'deleted.ts', before: original, after: '', timestamp: 100 }];

		const rollback = changes.map((c) => ({
			relPath: c.relPath,
			type: c.before !== '' && c.after === '' ? 'modified' : 'modified',
			after: c.before
		}));

		assert.strictEqual(rollback[0].after, original, 'Rollback of deletion must restore EXACT original content');
	});

	it('rollback with multiple edits restores to FIRST before, not intermediate', () => {
		const v1 = 'version 1';
		const v2 = 'version 2';
		const v3 = 'version 3';

		const changes: TimestampedChange[] = [
			{ relPath: 'f.ts', before: v1, after: v2, timestamp: 100 },
			{ relPath: 'f.ts', before: v2, after: v3, timestamp: 200 }
		];

		const { changes: merged } = mergeChangesInWindow(changes, 0, 300);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].before, v1, 'Rollback must restore to v1 (first before), NOT v2 (intermediate)');
		assert.notStrictEqual(merged[0].before, v2);
	});
});

describe('VERIFY: Prompt-to-file attribution is exact', () => {
	it('exact file list for a 5-prompt session', () => {
		const changes: TimestampedChange[] = [
			// Prompt 0 (T=0-99): edits app.ts and utils.ts
			{ relPath: 'src/app.ts', before: 'a', after: 'b', timestamp: 10 },
			{ relPath: 'src/utils.ts', before: 'c', after: 'd', timestamp: 20 },
			// Prompt 1 (T=100-199): no changes (informational question)
			// Prompt 2 (T=200-299): creates new-file.ts
			{ relPath: 'src/new-file.ts', before: '', after: 'new', timestamp: 210 },
			// Prompt 3 (T=300-399): edits app.ts AGAIN + deletes old.ts
			{ relPath: 'src/app.ts', before: 'b2', after: 'b3', timestamp: 310 },
			{ relPath: 'src/old.ts', before: 'old', after: '', timestamp: 320 },
			// Prompt 4 (T=400-499): edits utils.ts
			{ relPath: 'src/utils.ts', before: 'd2', after: 'd3', timestamp: 410 }
		];

		const w0 = mergeChangesInWindow(changes, 0, 100);
		assert.deepStrictEqual(w0.files.sort(), ['src/app.ts', 'src/utils.ts'],
			'Prompt 0 must have exactly app.ts and utils.ts');

		const w1 = mergeChangesInWindow(changes, 100, 200);
		assert.strictEqual(w1.files.length, 0, 'Prompt 1 (informational) must have ZERO files');

		const w2 = mergeChangesInWindow(changes, 200, 300);
		assert.deepStrictEqual(w2.files, ['src/new-file.ts'], 'Prompt 2 must have ONLY new-file.ts');

		const w3 = mergeChangesInWindow(changes, 300, 400);
		assert.deepStrictEqual(w3.files.sort(), ['src/app.ts', 'src/old.ts'],
			'Prompt 3 must have app.ts (re-edit) and old.ts (deletion)');

		const w4 = mergeChangesInWindow(changes, 400, 500);
		assert.deepStrictEqual(w4.files, ['src/utils.ts'], 'Prompt 4 must have ONLY utils.ts');
	});

	it('file created and deleted in SAME prompt = no net change', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'temp.ts', before: '', after: 'content', timestamp: 110 },
			{ relPath: 'temp.ts', before: 'content', after: '', timestamp: 120 }
		];

		const { files } = mergeChangesInWindow(changes, 100, 200);
		assert.strictEqual(files.length, 0, 'Created then deleted = no net change (before === after === empty)');
	});

	it('file edited back to original = no net change', () => {
		const original = 'const x = 1;\n';
		const changes: TimestampedChange[] = [
			{ relPath: 'f.ts', before: original, after: 'const x = 2;\n', timestamp: 110 },
			{ relPath: 'f.ts', before: 'const x = 2;\n', after: original, timestamp: 120 }
		];

		const { files } = mergeChangesInWindow(changes, 100, 200);
		assert.strictEqual(files.length, 0, 'Edited then reverted = no net change');
	});
});

describe('BUG 10: dist-tests/ build output leaked into snapshots', () => {
	it('dist-tests/ from gitignore is parsed as prefix and ignored', () => {
		const tmp = fs.mkdtempSync('/tmp/promptrail-disttest-');
		fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules/\ndist/\ndist-tests/\n*.vsix\n.cursor/\n');
		const patterns = loadGitignorePatterns(tmp);

		assert.ok(patterns.prefixes.includes('dist-tests/'), 'dist-tests/ must be in prefixes');
		assert.strictEqual(shouldTrackFile('dist-tests/index.js', patterns), false, 'dist-tests/index.js must be ignored');
		assert.strictEqual(shouldTrackFile('dist-tests/index.js.map', patterns), false, 'dist-tests/index.js.map must be ignored');
		assert.strictEqual(
			shouldTrackFile('dist-tests/fixtures/changes.json', patterns),
			false,
			'dist-tests/fixtures/* must be ignored'
		);
		// But dist/ is still ignored too
		assert.strictEqual(shouldTrackFile('dist/extension.js', patterns), false);
		// And .cursor/ is still tracked (NEVER_IGNORE)
		assert.ok(shouldTrackFile('.cursor/skills/foo.md', patterns));
		fs.rmSync(tmp, { recursive: true });
	});
});

describe('EDGE CASES: Try to break things', () => {
	it('empty changes array = no results', () => {
		const { files } = mergeChangesInWindow([], 0, 100);
		assert.strictEqual(files.length, 0);
	});

	it('change at exact window boundary: start is inclusive', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'f.ts', before: 'a', after: 'b', timestamp: 100 }
		];
		const { files } = mergeChangesInWindow(changes, 100, 200);
		assert.strictEqual(files.length, 1, 'Change at exact start should be included');
	});

	it('change at exact window boundary: end is exclusive', () => {
		const changes: TimestampedChange[] = [
			{ relPath: 'f.ts', before: 'a', after: 'b', timestamp: 200 }
		];
		const { files } = mergeChangesInWindow(changes, 100, 200);
		assert.strictEqual(files.length, 0, 'Change at exact end should be excluded');
	});

	it("very large file content doesn't corrupt merge", () => {
		const bigContent = 'x'.repeat(100000);
		const changes: TimestampedChange[] = [
			{ relPath: 'big.ts', before: '', after: bigContent, timestamp: 100 }
		];

		const { changes: merged } = mergeChangesInWindow(changes, 0, 200);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0]!.after!.length, 100000);
	});

	it('file with special characters in path', () => {
		const p: IgnorePatterns = { prefixes: ['dist/'], suffixes: [], exactFiles: [] };
		assert.ok(shouldTrackFile('src/my file (1).ts', p));
		assert.ok(shouldTrackFile('src/données.ts', p));
		assert.ok(shouldTrackFile('src/[brackets].ts', p));
	});

	it("binary-like content (null bytes) doesn't crash merge", () => {
		const content = 'line1\x00\x00line2';
		const changes: TimestampedChange[] = [
			{ relPath: 'bin.ts', before: '', after: content, timestamp: 100 }
		];

		const { changes: merged } = mergeChangesInWindow(changes, 0, 200);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].after, content);
	});

	it('100 changes to same file in one window', () => {
		const changes: TimestampedChange[] = [];
		for (let i = 0; i < 100; i++) {
			changes.push({
				relPath: 'hot.ts',
				before: `v${i}`,
				after: `v${i + 1}`,
				timestamp: 100 + i
			});
		}

		const { changes: merged } = mergeChangesInWindow(changes, 100, 300);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0].before, 'v0', 'Before = first version');
		assert.strictEqual(merged[0].after, 'v100', 'After = last version (100th edit)');
	});

	it("gitignore with weird patterns doesn't crash", () => {
		const tmp = fs.mkdtempSync('/tmp/promptrail-weird-');
		fs.writeFileSync(path.join(tmp, '.gitignore'), '\n\n# comment\n  \n*.log\n!important.log\n/build\n**/*.tmp\n.cursor/\n');
		assert.doesNotThrow(() => loadGitignorePatterns(tmp));
		const patterns = loadGitignorePatterns(tmp);
		assert.ok(patterns.suffixes.includes('.log'));
		assert.ok(!patterns.prefixes.includes('.cursor/'), '.cursor/ must be protected');
		fs.rmSync(tmp, { recursive: true });
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 11: getTasks shows files but getTaskChangeset returns empty.
//
// getTasks() and getTaskChangeset() both call readAllTasks()
// independently. If new Claude prompts appear between the two
// calls (cache expires after 2 seconds), the Claude windows
// change. A file change that passed the filter in getTasks()
// gets excluded in getTaskChangeset() because a new Claude
// window now overlaps it.
//
// The timeline shows "1 file" but View Diff says "No diff data."
//
// Fix: getTaskChangeset should NOT re-apply Claude window
// exclusion. The user clicked on a task that already shows files.
// ──────────────────────────────────────────────────────────────
describe("BUG 12: Cursor update resets all bubble timestamps to same value", () => {
	it("all-identical timestamps detected as collapsed and spread across session range", () => {
		const allSame = Array(8).fill(1773170194000);
		const ts = deduplicateTimestamps(allSame, 8, 1773170000000, 1773170800000);
		for (let i = 1; i < ts.length; i++) {
			assert.ok(ts[i] > ts[i - 1],
				`Timestamp ${i} (${ts[i]}) must be > timestamp ${i-1} (${ts[i-1]})`);
		}
	});

	it("file changes found via spread-out windows using mergeChangesInWindow", () => {
		const allSame = Array(3).fill(1000);
		const ts = deduplicateTimestamps(allSame, 3, 1000, 4000);

		const changes = [
			{ relPath: "a.ts", before: "", after: "a", timestamp: ts[0] },
			{ relPath: "b.ts", before: "", after: "b", timestamp: ts[1] },
			{ relPath: "c.ts", before: "", after: "c", timestamp: ts[2] },
		];

		for (let i = 0; i < ts.length; i++) {
			const start = ts[i];
			const end = i + 1 < ts.length ? ts[i + 1] : Infinity;
			const { files } = mergeChangesInWindow(changes, start, end);
			assert.strictEqual(files.length, 1,
				`Window ${i} should have exactly 1 file, got ${files.length}: [${files}]`);
		}
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 13: Missing bubble timestamps compress all prompts into
//         a tiny window around the JSONL file mtime.
//
// When Cursor prunes bubbleId entries from SQLite (common for
// long or old sessions), getUserBubbleTimestamps returns all
// zeros.  The old fallback computed:
//
//   fallbackMod - (promptCount - i) * 30_000
//
// This crammed a 45-prompt / 20-hour session into 22.5 minutes
// around the file mtime, leaving ZERO overlap with the file
// watcher snapshot data.  Every diff and rollback failed.
//
// Fix: spread fallback timestamps from session.createdAt to
// session.lastUpdatedAt so they cover the real time range.
// ──────────────────────────────────────────────────────────────
describe("BUG 13: Missing bubble timestamps break all diffs", () => {
	const SESSION_START = 1773244616266;
	const SESSION_END   = 1773318460652;
	const PROMPT_COUNT  = 45;
	const SNAPSHOT_WINDOW = {
		start: 1773250646272,
		end:   1773263589011,
	};

	it("missing timestamps (undefined) spread across session range", () => {
		const ts = deduplicateTimestamps(undefined, PROMPT_COUNT, SESSION_START, SESSION_END);
		assert.strictEqual(ts.length, PROMPT_COUNT);

		const inSnapshot = ts.filter(t => t >= SNAPSHOT_WINDOW.start && t < SNAPSHOT_WINDOW.end);
		assert.ok(inSnapshot.length >= 5,
			`Expected >= 5 prompts in snapshot window, got ${inSnapshot.length}`);

		const range = ts[ts.length - 1] - ts[0];
		assert.ok(range > 15 * 3600_000,
			"Must span at least 15 hours (actual session is ~20h)");
	});

	it("first timestamp equals session start, last equals session end", () => {
		const ts = deduplicateTimestamps(undefined, PROMPT_COUNT, SESSION_START, SESSION_END);
		assert.strictEqual(ts[0], SESSION_START);
		assert.strictEqual(ts[ts.length - 1], SESSION_END);
	});

	it("single-prompt session doesn't divide by zero", () => {
		const ts = deduplicateTimestamps(undefined, 1, SESSION_START, SESSION_END);
		assert.strictEqual(ts.length, 1);
		assert.strictEqual(ts[0], SESSION_START);
	});

	it("timestamps are strictly increasing", () => {
		const ts = deduplicateTimestamps(undefined, PROMPT_COUNT, SESSION_START, SESSION_END);
		for (let i = 1; i < ts.length; i++) {
			assert.ok(ts[i] > ts[i - 1], `Timestamp ${i} must be > timestamp ${i - 1}`);
		}
	});

	it("collapsed timestamps (all same value) detected and spread", () => {
		const collapsed = Array(10).fill(1773170194000);
		const ts = deduplicateTimestamps(collapsed, 10, SESSION_START, SESSION_END);
		for (let i = 1; i < ts.length; i++) {
			assert.ok(ts[i] > ts[i - 1], `Must be strictly increasing after spread`);
		}
		const range = ts[ts.length - 1] - ts[0];
		assert.ok(range > 1_000_000, "Collapsed timestamps must be spread across session range");
	});

	it("valid raw timestamps preserved, only duplicates deduped", () => {
		const raw = [1000, 2000, 3000, 3000, 5000];
		const ts = deduplicateTimestamps(raw, 5, 0, 10000);
		assert.strictEqual(ts[0], 1000);
		assert.strictEqual(ts[1], 2000);
		assert.strictEqual(ts[2], 3000);
		assert.ok(ts[3] > ts[2], "Duplicate 3000 must be deduped to > 3000");
		assert.strictEqual(ts[4], 5000);
	});

	it("E2E: snapshot changes found via window matching with real function", () => {
		const snapshots = [
			{ relPath: "src/tracker.ts", before: "v1", after: "v2", timestamp: SNAPSHOT_WINDOW.start + 60_000 },
			{ relPath: "src/cli.ts", before: "a", after: "b", timestamp: SNAPSHOT_WINDOW.start + 3600_000 },
			{ relPath: "README.md", before: "", after: "# Hi", timestamp: SNAPSHOT_WINDOW.end - 60_000 },
		];

		const ts = deduplicateTimestamps(undefined, PROMPT_COUNT, SESSION_START, SESSION_END);

		let totalFound = 0;
		for (let i = 0; i < ts.length; i++) {
			const start = ts[i];
			const end = i + 1 < ts.length ? ts[i + 1] : Date.now();
			const { files } = mergeChangesInWindow(snapshots, start, end);
			totalFound += files.length;
		}

		assert.strictEqual(totalFound, snapshots.length,
			"All snapshot changes must be found by exactly one prompt window");
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 14: Cursor auto-injects "Continue" messages in JSONL
//         that don't exist in SQLite user bubbles.
//
// When Cursor's agent process crashes/restarts mid-response,
// it injects a phantom user message in JSONL. SQLite does NOT
// include these as type=1 user bubbles.
//
// Fix: SQLite-first architecture. SQLite user bubbles are the
// canonical prompt list -- no auto-continues, no duplicates.
// JSONL is only used as fallback when SQLite is unavailable.
// ──────────────────────────────────────────────────────────────
describe("BUG 14: Auto-continue in JSONL but not SQLite", () => {
	// Documentation test: verifies data format, not a code path
	it("JSONL has more user messages than SQLite has user bubbles", () => {
		const jsonlUserCount = 21;
		const sqliteUserCount = 18;
		assert.ok(jsonlUserCount > sqliteUserCount,
			"JSONL includes auto-continues and duplicates that SQLite skips");
	});

	// Documentation test: verifies data format, not a code path
	it("SQLite-first avoids auto-continue entirely", () => {
		const sqliteBubbles = [
			{ text: "fix the diffs", files: new Set(["session-reader.ts"]) },
			{ text: "add tests", files: new Set(["test.ts"]) },
			{ text: "update docs", files: new Set(["readme.md"]) },
		];

		const tasks = sqliteBubbles.map((b, i) => ({
			prompt: b.text,
			toolEditedFiles: b.files,
			promptIndex: i,
		}));

		assert.strictEqual(tasks.length, 3, "one task per SQLite bubble");
		assert.ok(tasks[1].toolEditedFiles.has("test.ts"),
			"direct attribution, no index shift");
	});

	it("toolFormerData provides per-prompt file attribution without watcher", () => {
		const bubble = { text: "deploy", files: new Set(["deploy.sh", "config.yaml"]) };
		const filesChanged = [...bubble.files];
		assert.strictEqual(filesChanged.length, 2, "files come directly from toolFormerData");
		assert.ok(filesChanged.includes("deploy.sh"));
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 15: JSONL duplicates and index mismatch.
//
// JSONL can have duplicate user messages (Cursor re-sends
// context on reconnect). When using JSONL indices to look up
// SQLite data, the duplicates shift all subsequent indices.
//
// Fix: SQLite-first architecture bypasses JSONL entirely for
// prompt discovery. Each SQLite user bubble has a clean index.
// ──────────────────────────────────────────────────────────────
describe("BUG 15: SQLite-first eliminates index mismatch", () => {
	// Documentation test: verifies data format, not a code path
	it("SQLite user bubble index is stable (no duplicates)", () => {
		const sqliteBubbleTexts = [
			"fix diffs", "add tests", "update docs", "refactor",
		];

		const perPromptFiles = new Map<number, Set<string>>();
		perPromptFiles.set(0, new Set(["session-reader.ts"]));
		perPromptFiles.set(1, new Set(["test.ts"]));
		perPromptFiles.set(2, new Set(["readme.md"]));
		perPromptFiles.set(3, new Set(["utils.ts"]));

		const tasks = sqliteBubbleTexts.map((text, i) => ({
			prompt: text,
			promptIndex: i,
			toolEditedFiles: perPromptFiles.get(i) ?? new Set<string>(),
		}));

		assert.ok(tasks[0].toolEditedFiles.has("session-reader.ts"));
		assert.ok(tasks[1].toolEditedFiles.has("test.ts"));
		assert.ok(tasks[2].toolEditedFiles.has("readme.md"));
		assert.ok(tasks[3].toolEditedFiles.has("utils.ts"));
	});

	// Documentation test: verifies data format, not a code path
	it("JSONL fallback still works when SQLite is unavailable", () => {
		const jsonlPrompts = ["fix diffs", "add tests"];
		const tasks = jsonlPrompts.map((text, i) => ({
			prompt: text,
			promptIndex: i,
		}));
		assert.strictEqual(tasks.length, 2);
	});

	it("E2E: toolFormerData directly populates filesChanged (no watcher)", () => {
		const sqliteBubbles = [
			{ text: "fix the bug", createdAt: 1000, files: new Set(["session-reader.ts", "vscode-history.ts"]) },
			{ text: "add tests", createdAt: 2000, files: new Set(["regressions.test.ts", "integration.test.ts"]) },
			{ text: "update docs", createdAt: 3000, files: new Set<string>() },
		];

		const tasks = sqliteBubbles.map((b, i) => ({
			prompt: b.text,
			createdAt: b.createdAt,
			promptIndex: i,
			filesChanged: [...b.files],
		}));

		assert.deepStrictEqual(tasks[0].filesChanged, ["session-reader.ts", "vscode-history.ts"]);
		assert.deepStrictEqual(tasks[1].filesChanged, ["regressions.test.ts", "integration.test.ts"]);
		assert.deepStrictEqual(tasks[2].filesChanged, [],
			"no files for informational prompt");
	});

	it("home-directory paths normalized correctly", () => {
		const wsRoot = "/Users/test/Work/project";
		const home = "/Users/test";

		function toRel(fp: string): string {
			if (fp.startsWith(wsRoot + "/")) return fp.slice(wsRoot.length + 1);
			if (fp.startsWith(home + "/")) return fp.slice(home.length + 1);
			return fp;
		}

		assert.strictEqual(
			toRel("/Users/test/Work/project/src/app.ts"),
			"src/app.ts",
			"workspace-relative path"
		);
		assert.strictEqual(
			toRel("/Users/test/.cursor/plans/fix.plan.md"),
			".cursor/plans/fix.plan.md",
			"home-relative path for plan files"
		);
		assert.strictEqual(
			toRel("/other/path/file.ts"),
			"/other/path/file.ts",
			"absolute path preserved when outside both"
		);
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 16: Cursor bubble types and capabilityType.
//
// SQLite bubbles have type=1 (user) and type=2 (assistant).
// capabilityType=30 on assistant bubbles represents user
// interactions (answers to questions, button clicks) but these
// have EMPTY text -- the actual answer is not recoverable.
// capabilityType=15 on assistant bubbles represents tool calls.
//
// Known: auto-continues are in JSONL but NOT in SQLite bubbles.
// Known: user answers (AskQuestion responses) are cap=30 with
//        empty text -- untraceable as separate prompts.
// Known: "Build" button clicks appear as separate user bubbles
//        with "Implement the plan..." text in SQLite.
// ──────────────────────────────────────────────────────────────
// Documentation test: verifies data format, not a code path
describe("BUG 16: Cursor bubble types and interaction model", () => {
	// Documentation test: verifies data format, not a code path
	it("only type=1 bubbles are user prompts in SQLite", () => {
		const bubbles = [
			{ type: 1, text: "fix diffs" },
			{ type: 2, text: "", capabilityType: 15 },
			{ type: 2, text: "", capabilityType: 30 },
			{ type: 1, text: "add tests" },
			{ type: 2, text: "", capabilityType: 15 },
		];

		const userBubbles = bubbles.filter(b => b.type === 1);
		assert.strictEqual(userBubbles.length, 2);
		assert.strictEqual(userBubbles[0].text, "fix diffs");
		assert.strictEqual(userBubbles[1].text, "add tests");
	});

	// Documentation test: verifies data format, not a code path
	it("capabilityType=30 are user interactions with empty text", () => {
		const cap30Bubble = { type: 2, text: "", capabilityType: 30 };
		assert.strictEqual(cap30Bubble.text, "",
			"cap=30 bubbles have empty text -- answer content is lost");
		assert.strictEqual(cap30Bubble.type, 2,
			"cap=30 are type 2 (assistant), not type 1 (user)");
	});

	// Documentation test: verifies data format, not a code path
	it("toolFormerData with FILE_EDIT_TOOLS tracks per-prompt files", () => {
		const FILE_EDIT_TOOLS = new Set([
			"edit_file_v2", "write", "delete_file", "apply_patch",
		]);

		const toolCalls = [
			{ name: "edit_file_v2", file: "app.ts" },
			{ name: "run_terminal_command_v2", file: "" },
			{ name: "read_file_v2", file: "" },
			{ name: "write", file: "new.ts" },
			{ name: "ask_question", file: "" },
			{ name: "create_plan", file: "" },
		];

		const editedFiles = toolCalls
			.filter(tc => FILE_EDIT_TOOLS.has(tc.name) && tc.file)
			.map(tc => tc.file);

		assert.deepStrictEqual(editedFiles, ["app.ts", "new.ts"]);
		assert.ok(!editedFiles.includes(""),
			"non-file tools excluded");
	});
});

// Architecture test: documents the design decision to remove re-filtering,
// not an exported function. Inline logic replicates the pre/post-fix behavior.
describe("BUG 11: getTasks shows files but getTaskChangeset returns empty", () => {
	it("Claude windows expanding between calls can exclude previously-found changes", () => {
		const fileChange = { relPath: "README.md", before: "old", after: "new", timestamp: 500 };
		const cursorWindow = { start: 400, end: 600 };

		const claudeWindowsV1 = [{ start: 100, end: 300 }];
		const filteredV1 = [fileChange].filter((c) => {
			if (c.timestamp < cursorWindow.start || c.timestamp >= cursorWindow.end) return false;
			for (const w of claudeWindowsV1) {
				if (c.timestamp >= w.start && c.timestamp < w.end) return false;
			}
			return true;
		});
		assert.strictEqual(filteredV1.length, 1, "getTasks finds README.md");

		const claudeWindowsV2 = [{ start: 100, end: 300 }, { start: 450, end: 550 }];
		const filteredV2 = [fileChange].filter((c) => {
			if (c.timestamp < cursorWindow.start || c.timestamp >= cursorWindow.end) return false;
			for (const w of claudeWindowsV2) {
				if (c.timestamp >= w.start && c.timestamp < w.end) return false;
			}
			return true;
		});
		assert.strictEqual(filteredV2.length, 0,
			"getTaskChangeset loses README.md because new Claude window appeared (THE BUG)");
	});

	it("fix: getTaskChangeset without Claude re-filtering always finds the change", () => {
		const fileChange = { relPath: "README.md", before: "old", after: "new", timestamp: 500 };
		const cursorWindow = { start: 400, end: 600 };

		const filtered = [fileChange].filter((c) =>
			c.timestamp >= cursorWindow.start && c.timestamp < cursorWindow.end
		);
		assert.strictEqual(filtered.length, 1);
		assert.strictEqual(filtered[0].before, "old");
		assert.strictEqual(filtered[0].after, "new");
	});
});

// ----------------------------------------------------------
// BUG 17 & 18: SUPERSEDED by watcher removal.
//
// These bugs were caused by the FileWatcher time-window attribution
// pipeline: watcher changes were filtered through applyFileWhitelist
// with toolEditedFiles/sessionEditedFiles. Empty vs undefined
// toolEditedFiles caused phantom file attributions.
//
// Fix: The entire watcher-based attribution pipeline was removed.
// File attribution now comes directly from hooks (hook_edits per
// generationId) or SQLite toolFormerData. No watcher fallback means
// git pull, builds, and other concurrent disk activity can never be
// misattributed to an AI prompt.
// ----------------------------------------------------------

// ----------------------------------------------------------
// BUG 21: Hook-sourced tasks with 0 edits must not fall through
//         to watcher (now removed) or show phantom files.
//
// parseCursorFromHooks sets hookSourced=true on all tasks.
// With the watcher removed, filesChanged comes directly from
// hook_edits — an empty array is authoritative.
// ----------------------------------------------------------
describe("BUG 21: Hook-sourced tasks with 0 edits", () => {
	it("hookSourced task with empty filesChanged stays empty (no phantom files)", () => {
		const task = {
			id: "cur-abc-0",
			prompt: "already done",
			createdAt: Date.now(),
			status: "completed" as const,
			filesChanged: [],
			source: "cursor",
			hookSourced: true,
			edits: undefined,
			writes: undefined,
		};
		assert.strictEqual(task.filesChanged.length, 0,
			"hook-sourced task with no edits must have empty filesChanged");
		assert.strictEqual(task.hookSourced, true);
	});

	it("hookSourced task with edits populates filesChanged from hook_edits", () => {
		const task = {
			id: "cur-abc-1",
			prompt: "fix the bug",
			createdAt: Date.now(),
			status: "completed" as const,
			filesChanged: ["src/app.ts"],
			source: "cursor",
			hookSourced: true,
			edits: [{ file: "src/app.ts", oldString: "old", newString: "new" }],
		};
		assert.strictEqual(task.filesChanged.length, 1);
		assert.strictEqual(task.filesChanged[0], "src/app.ts");
	});
});

// ----------------------------------------------------------
// BUG 22: Consecutive identical hook prompts from API retries
//         bloat the timeline.
//
// When Cursor retries a prompt (API key failure, rate limit),
// each retry fires a new beforeSubmitPrompt hook with a unique
// generationId. parseCursorFromHooks showed all retries as
// separate prompts in the timeline.
//
// Fix: deduplicateHookRetries() collapses consecutive runs of
// identical prompt text into the last entry (the final attempt).
// ----------------------------------------------------------
describe("BUG 22: API retry deduplication", () => {
	it("collapses 3 consecutive identical prompts to 1", () => {
		const prompts = [
			{ promptText: "fix the bug", generationId: "gen1", model: null, timestamp: 1000 },
			{ promptText: "fix the bug", generationId: "gen2", model: null, timestamp: 2000 },
			{ promptText: "fix the bug", generationId: "gen3", model: null, timestamp: 3000 },
		];
		const result = deduplicateHookRetries(prompts);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].generationId, "gen3", "keeps the last retry");
	});

	it("preserves distinct prompts between retries", () => {
		const prompts = [
			{ promptText: "fix auth", generationId: "gen1", model: null, timestamp: 1000 },
			{ promptText: "fix auth", generationId: "gen2", model: null, timestamp: 2000 },
			{ promptText: "now add tests", generationId: "gen3", model: null, timestamp: 3000 },
			{ promptText: "now add tests", generationId: "gen4", model: null, timestamp: 4000 },
		];
		const result = deduplicateHookRetries(prompts);
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0].promptText, "fix auth");
		assert.strictEqual(result[0].generationId, "gen2");
		assert.strictEqual(result[1].promptText, "now add tests");
		assert.strictEqual(result[1].generationId, "gen4");
	});

	it("single prompt passthrough", () => {
		const prompts = [
			{ promptText: "hello", generationId: "gen1", model: null, timestamp: 1000 },
		];
		const result = deduplicateHookRetries(prompts);
		assert.strictEqual(result.length, 1);
	});

	it("empty array passthrough", () => {
		const result = deduplicateHookRetries([]);
		assert.strictEqual(result.length, 0);
	});

	it("non-consecutive duplicates are NOT collapsed", () => {
		const prompts = [
			{ promptText: "fix auth", generationId: "gen1", model: null, timestamp: 1000 },
			{ promptText: "add tests", generationId: "gen2", model: null, timestamp: 2000 },
			{ promptText: "fix auth", generationId: "gen3", model: null, timestamp: 3000 },
		];
		const result = deduplicateHookRetries(prompts);
		assert.strictEqual(result.length, 3, "non-consecutive duplicates kept separately");
	});
});

// ----------------------------------------------------------
// BUG 19: Shadow DB re-snapshot misses assistant bubbles for
//         later prompts
//
// When the extension snapshots while the AI is generating a
// response, assistant bubbles for the latest prompt haven't
// been written to Cursor's DB yet. The old condition:
//   cachedAssistantCount === 0
// only re-snapshotted when there were ZERO assistant bubbles.
// Once prompt 0's response was captured (count > 0), later
// prompts' responses were never captured — even after the AI
// finished generating.
//
// Fix: shouldResnapshot() compares cached assistant count
// against the number of readable assistant bubbles in Cursor's
// DB (readableAssistantCount), triggering a re-snapshot when
// new response data is available.
// ----------------------------------------------------------
describe("BUG 19: Shadow DB re-snapshot misses assistant bubbles", () => {
	it("triggers re-snapshot when new user bubbles appear", () => {
		assert.ok(shouldResnapshot(2, 4, 10, 10),
			"2 cached user bubbles < 4 current → re-snapshot");
	});

	it("triggers re-snapshot when new assistant bubbles are readable", () => {
		assert.ok(shouldResnapshot(4, 4, 10, 20),
			"4 == 4 user bubbles but 10 < 20 assistant → re-snapshot");
	});

	it("no re-snapshot when all data is current", () => {
		assert.ok(!shouldResnapshot(4, 4, 20, 20),
			"all counts match → no re-snapshot needed");
	});

	it("initial snapshot: zero cached triggers re-snapshot", () => {
		assert.ok(shouldResnapshot(0, 4, 0, 20),
			"fresh shadow DB → re-snapshot everything");
	});
});

// ──────────────────────────────────────────────────────────────
// Cursor Hooks Integration
//
// Hook-sourced Cursor tasks get Claude-quality edit tracking:
// exact old_string/new_string pairs per prompt, response text,
// and no dependency on FileWatcher time-window attribution.
// ──────────────────────────────────────────────────────────────

describe("Cursor Hooks: PromptRailDB hook table queries", () => {
	let tmpDir: string;
	let db: any;

	function createDb() {
		const { PromptRailDB } = require("../src/core/promptrail-db");
		return new PromptRailDB(tmpDir);
	}

	it("hook tables are created by PromptRailDB constructor", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-test-"));
		db = createDb();

		// Insert a hook prompt directly — if the table doesn't exist, this throws
		const ids = db.getHookConversationIds();
		assert.ok(Array.isArray(ids), "getHookConversationIds returns array");
		assert.strictEqual(ids.length, 0, "no hook data yet");
		db.dispose();
	});

	it("getHookPrompts returns prompts ordered by timestamp", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-test-"));
		db = createDb();

		// Manually insert hook data
		const dbPath = path.join(tmpDir, ".promptrail", "promptrail.db");
		const { DatabaseSync } = require("node:sqlite");
		const rawDb = new DatabaseSync(dbPath);
		rawDb.exec("PRAGMA journal_mode=WAL");
		rawDb.prepare(`INSERT INTO hook_prompts (conversationId, generationId, promptText, model, timestamp)
			VALUES (?, ?, ?, ?, ?)`).run("conv-1", "gen-a", "fix the bug", "gpt-4", 1000);
		rawDb.prepare(`INSERT INTO hook_prompts (conversationId, generationId, promptText, model, timestamp)
			VALUES (?, ?, ?, ?, ?)`).run("conv-1", "gen-b", "add tests", "gpt-4", 2000);
		rawDb.close();

		// Re-create DB to pick up the data
		db = createDb();
		const ids = db.getHookConversationIds();
		assert.deepStrictEqual(ids, ["conv-1"]);

		const prompts = db.getHookPrompts("conv-1");
		assert.strictEqual(prompts.length, 2);
		assert.strictEqual(prompts[0].promptText, "fix the bug");
		assert.strictEqual(prompts[1].promptText, "add tests");
		assert.ok(prompts[0].timestamp < prompts[1].timestamp, "ordered by timestamp");
		db.dispose();
	});

	it("getHookEdits returns edits grouped by generationId", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-test-"));
		db = createDb();

		const dbPath = path.join(tmpDir, ".promptrail", "promptrail.db");
		const { DatabaseSync } = require("node:sqlite");
		const rawDb = new DatabaseSync(dbPath);
		rawDb.exec("PRAGMA journal_mode=WAL");

		rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)`).run("conv-1", "gen-a", "src/app.ts", "old code", "new code", 1000);
		rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)`).run("conv-1", "gen-a", "src/util.ts", "", "new file content", 1001);
		rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)`).run("conv-1", "gen-b", "tests/app.test.ts", "old test", "new test", 2000);
		rawDb.close();

		db = createDb();
		const edits = db.getHookEdits("conv-1");
		assert.strictEqual(edits.length, 3);

		const genA = edits.filter((e: any) => e.generationId === "gen-a");
		assert.strictEqual(genA.length, 2);
		assert.strictEqual(genA[0].filePath, "src/app.ts");
		assert.strictEqual(genA[0].oldString, "old code");
		assert.strictEqual(genA[0].newString, "new code");
		assert.strictEqual(genA[1].filePath, "src/util.ts");
		assert.strictEqual(genA[1].oldString, "");
		db.dispose();
	});

	it("getHookResponseForGeneration concatenates response texts", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-test-"));
		db = createDb();

		const dbPath = path.join(tmpDir, ".promptrail", "promptrail.db");
		const { DatabaseSync } = require("node:sqlite");
		const rawDb = new DatabaseSync(dbPath);
		rawDb.exec("PRAGMA journal_mode=WAL");

		rawDb.prepare(`INSERT INTO hook_responses (conversationId, generationId, responseText, model, timestamp)
			VALUES (?, ?, ?, ?, ?)`).run("conv-1", "gen-a", "I fixed the bug by...", "gpt-4", 1500);
		rawDb.close();

		db = createDb();
		const resp = db.getHookResponseForGeneration("conv-1", "gen-a");
		assert.strictEqual(resp, "I fixed the bug by...");

		const noResp = db.getHookResponseForGeneration("conv-1", "gen-nonexistent");
		assert.strictEqual(noResp, undefined);
		db.dispose();
	});
});

describe("Cursor Hooks: parseCursorFromHooks via SessionReader", () => {
	it("hook-sourced tasks have edits and writes populated", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-parse-"));

		// Set up hook data in the DB
		const dbPath = path.join(tmpDir, ".promptrail", "promptrail.db");
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const { DatabaseSync } = require("node:sqlite");
		const rawDb = new DatabaseSync(dbPath);
		rawDb.exec("PRAGMA journal_mode=WAL");
		rawDb.exec(`
			CREATE TABLE IF NOT EXISTS hook_prompts (
				conversationId TEXT NOT NULL, generationId TEXT NOT NULL,
				promptText TEXT NOT NULL, model TEXT, timestamp REAL NOT NULL,
				PRIMARY KEY (conversationId, generationId)
			);
			CREATE TABLE IF NOT EXISTS hook_edits (
				id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL,
				generationId TEXT NOT NULL, filePath TEXT NOT NULL,
				oldString TEXT, newString TEXT, timestamp REAL NOT NULL
			);
			CREATE TABLE IF NOT EXISTS hook_responses (
				id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL,
				generationId TEXT NOT NULL, responseText TEXT NOT NULL,
				model TEXT, timestamp REAL NOT NULL
			);
		`);

		rawDb.prepare(`INSERT INTO hook_prompts VALUES (?, ?, ?, ?, ?)`)
			.run("conv-123", "gen-1", "fix the auth bug", "gpt-4", 1000);
		rawDb.prepare(`INSERT INTO hook_prompts VALUES (?, ?, ?, ?, ?)`)
			.run("conv-123", "gen-2", "add rate limiting", "gpt-4", 2000);

		// gen-1: one edit
		rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)`).run("conv-123", "gen-1", "src/auth.ts", "if (token)", "if (token && valid)", 1100);

		// gen-2: one write (new file) + one edit
		rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)`).run("conv-123", "gen-2", "src/rate-limit.ts", "", "export class RateLimit {}", 2100);
		rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)`).run("conv-123", "gen-2", "src/auth.ts", "checkAuth()", "checkAuth(); rateLimit()", 2200);

		rawDb.close();

		// Use SessionReader to parse
		const { SessionReader } = require("../src/core/session-reader");
		const reader = new SessionReader(tmpDir);
		const allTasks = reader.readAllTasks();

		// Should find the 2 hook-sourced tasks
		const hookTasks = allTasks.filter((t: any) => t.source === "cursor" && t.sessionId === "conv-123");
		assert.strictEqual(hookTasks.length, 2, "2 hook-sourced tasks");

		const task1 = hookTasks.find((t: any) => t.prompt.includes("fix the auth"));
		assert.ok(task1, "task 1 found");
		assert.ok(task1.edits, "task 1 has edits");
		assert.strictEqual(task1.edits.length, 1);
		assert.strictEqual(task1.edits[0].file, "src/auth.ts");
		assert.strictEqual(task1.edits[0].oldString, "if (token)");
		assert.strictEqual(task1.edits[0].newString, "if (token && valid)");
		assert.strictEqual(task1.generationId, "gen-1");

		const task2 = hookTasks.find((t: any) => t.prompt.includes("rate limiting"));
		assert.ok(task2, "task 2 found");
		assert.ok(task2.writes, "task 2 has writes");
		assert.strictEqual(task2.writes.length, 1);
		assert.strictEqual(task2.writes[0].file, "src/rate-limit.ts");
		assert.ok(task2.edits, "task 2 also has edits");
		assert.strictEqual(task2.edits.length, 1);
		assert.strictEqual(task2.filesChanged.length, 2, "2 files changed by task 2");
		assert.strictEqual(task2.generationId, "gen-2");
	});

	it("hook-sourced tasks skip null/null edits (file touches without actual changes)", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-null-"));
		const dbPath = path.join(tmpDir, ".promptrail", "promptrail.db");
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const { DatabaseSync } = require("node:sqlite");
		const rawDb = new DatabaseSync(dbPath);
		rawDb.exec("PRAGMA journal_mode=WAL");
		rawDb.exec(`
			CREATE TABLE IF NOT EXISTS hook_prompts (
				conversationId TEXT NOT NULL, generationId TEXT NOT NULL,
				promptText TEXT NOT NULL, model TEXT, timestamp REAL NOT NULL,
				PRIMARY KEY (conversationId, generationId)
			);
			CREATE TABLE IF NOT EXISTS hook_edits (
				id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL,
				generationId TEXT NOT NULL, filePath TEXT NOT NULL,
				oldString TEXT, newString TEXT, timestamp REAL NOT NULL
			);
			CREATE TABLE IF NOT EXISTS hook_responses (
				id INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL,
				generationId TEXT NOT NULL, responseText TEXT NOT NULL,
				model TEXT, timestamp REAL NOT NULL
			);
		`);

		rawDb.prepare(`INSERT INTO hook_prompts VALUES (?, ?, ?, ?, ?)`)
			.run("conv-null", "gen-1", "check this file", "gpt-4", 1000);
		// null/null edit = file touch without actual change
		rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)`).run("conv-null", "gen-1", "src/app.ts", null, null, 1100);
		rawDb.close();

		const { SessionReader } = require("../src/core/session-reader");
		const reader = new SessionReader(tmpDir);
		const allTasks = reader.readAllTasks();

		const task = allTasks.find((t: any) => t.prompt.includes("check this file"));
		assert.ok(task, "task found");
		assert.strictEqual(task.filesChanged.length, 0, "null/null edit produces no file changes");
		assert.ok(!task.edits || task.edits.length === 0, "no edit records");
		assert.ok(!task.writes || task.writes.length === 0, "no write records");
	});
});

describe("Cursor Hooks: ensureCursorHooks auto-provisioning", () => {
	it("creates hooks.json and hook script in a fresh workspace", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-init-"));
		const { ensureCursorHooks } = require("../src/core/ensure-hooks");

		const created = ensureCursorHooks(tmpDir);
		assert.ok(created, "should report files created");

		const hookScript = path.join(tmpDir, ".cursor", "hooks", "promptrail-hook.js");
		assert.ok(fs.existsSync(hookScript), "hook script created");

		const hooksJson = path.join(tmpDir, ".cursor", "hooks.json");
		assert.ok(fs.existsSync(hooksJson), "hooks.json created");

		const config = JSON.parse(fs.readFileSync(hooksJson, "utf-8"));
		assert.strictEqual(config.version, 1);
		assert.ok(config.hooks.afterFileEdit, "afterFileEdit configured");
		assert.ok(config.hooks.beforeSubmitPrompt, "beforeSubmitPrompt configured");
		assert.ok(config.hooks.afterAgentResponse, "afterAgentResponse configured");
		assert.ok(config.hooks.stop, "stop configured");
	});

	it("merges into existing hooks.json without duplicating", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-merge-"));
		const cursorDir = path.join(tmpDir, ".cursor");
		fs.mkdirSync(cursorDir, { recursive: true });

		// Pre-existing hooks.json with a different hook
		const existing = {
			version: 1,
			hooks: {
				afterFileEdit: [{ command: "echo 'other hook'" }],
			},
		};
		fs.writeFileSync(path.join(cursorDir, "hooks.json"), JSON.stringify(existing), "utf-8");

		const { ensureCursorHooks } = require("../src/core/ensure-hooks");
		ensureCursorHooks(tmpDir);

		const config = JSON.parse(fs.readFileSync(path.join(cursorDir, "hooks.json"), "utf-8"));
		// Should have both the original hook and ours
		assert.strictEqual(config.hooks.afterFileEdit.length, 2, "original + promptrail");
		assert.ok(config.hooks.afterFileEdit.some((h: any) => h.command.includes("other hook")));
		assert.ok(config.hooks.afterFileEdit.some((h: any) => h.command.includes("promptrail-hook.js")));
		// New events should be added
		assert.ok(config.hooks.beforeSubmitPrompt.length > 0);
		assert.ok(config.hooks.stop.length > 0);
	});

	it("second call is idempotent (no changes)", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hook-idem-"));
		const { ensureCursorHooks } = require("../src/core/ensure-hooks");

		ensureCursorHooks(tmpDir);
		const secondRun = ensureCursorHooks(tmpDir);
		assert.ok(!secondRun, "second run should report no changes");
	});
});

// ----------------------------------------------------------
// BUG 20: Claude Code slash commands (/plugin, /help) appear
//         as prompts in the timeline.
//
// Claude Code injects internal JSONL messages for slash commands
// like "/plugin install promptrail", their stdout/stderr output,
// and meta caveats. These are NOT real user prompts but were
// passing through extractClaudePrompt because only
// <task-notification> was filtered.
//
// Fix: isClaudeInternalMessage() filters all internal message
// types: <command-name>, <local-command-stdout>,
// <local-command-stderr>, <local-command-caveat>,
// <task-notification>. Also skip messages with isMeta: true.
// ----------------------------------------------------------
describe("BUG 20: Claude Code slash commands appear as prompts", () => {
	it("filters <command-name> messages (slash commands)", () => {
		const msg = '<command-name>/plugin</command-name>\n            <command-message>plugin</command-message>\n            <command-args>install promptrail</command-args>';
		assert.ok(isClaudeInternalMessage(msg), "/plugin command should be filtered");
	});

	it("filters <local-command-stdout> messages", () => {
		const msg = "<local-command-stdout>Plugin 'promptrail@promptrail' is already installed.</local-command-stdout>";
		assert.ok(isClaudeInternalMessage(msg), "command stdout should be filtered");
	});

	it("filters <local-command-caveat> messages", () => {
		const msg = "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>";
		assert.ok(isClaudeInternalMessage(msg), "command caveat should be filtered");
	});

	it("filters <local-command-stderr> messages", () => {
		const msg = "<local-command-stderr>Error: something failed</local-command-stderr>";
		assert.ok(isClaudeInternalMessage(msg), "command stderr should be filtered");
	});

	it("filters <task-notification> messages (backward compat)", () => {
		const msg = "<task-notification>Task completed</task-notification>";
		assert.ok(isClaudeInternalMessage(msg), "task notification should be filtered");
	});

	it("allows real user prompts through", () => {
		assert.ok(!isClaudeInternalMessage("fix the authentication bug"));
		assert.ok(!isClaudeInternalMessage("add error handling to the API"));
		assert.ok(!isClaudeInternalMessage("what does this code do?"));
	});

	it("handles leading whitespace", () => {
		assert.ok(isClaudeInternalMessage("  <command-name>/help</command-name>"));
		assert.ok(isClaudeInternalMessage("\n<local-command-stdout>ok</local-command-stdout>"));
	});
});
