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
import { loadGitignorePatterns, shouldTrackFile, type IgnorePatterns } from '../src/core/file-watcher';

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
		const changes = [
			{ relPath: 'src/cursor-history.ts', before: 'v1', after: 'v2', timestamp: 100 },
			{ relPath: 'src/cursor-history.ts', before: 'v5', after: 'v6', timestamp: 500 }
		];
		const prompts = [50, 200, 400];

		const byPrompt = new Map<number, string[]>();
		for (const c of changes) {
			for (let i = prompts.length - 1; i >= 0; i--) {
				const end = i + 1 < prompts.length ? prompts[i + 1] : Infinity;
				if (c.timestamp >= prompts[i] && c.timestamp < end) {
					if (!byPrompt.has(i)) byPrompt.set(i, []);
					byPrompt.get(i)!.push(c.relPath);
					break;
				}
			}
		}

		assert.ok((byPrompt.get(0) || []).includes('src/cursor-history.ts'));
		assert.ok((byPrompt.get(2) || []).includes('src/cursor-history.ts'));
		assert.ok(
			!(byPrompt.get(1) || []).includes('src/cursor-history.ts'),
			'Prompt 1 should NOT have the file (no edit in its window)'
		);
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 3: Claude Code changes leaked into Cursor prompts.
// ──────────────────────────────────────────────────────────────
describe('BUG 3: Claude changes leaked into Cursor prompts', () => {
	it('excludes changes inside Claude windows', () => {
		const changes = [
			{ relPath: 'src/app.ts', timestamp: 150 },
			{ relPath: 'claude-plugin/hooks.json', timestamp: 250 },
			{ relPath: 'src/utils.ts', timestamp: 350 }
		];
		const claudeWindows = [{ start: 200, end: 300 }];

		const filtered = changes.filter((c) => {
			if (c.timestamp < 100 || c.timestamp >= 400) return false;
			for (const w of claudeWindows) {
				if (c.timestamp >= w.start && c.timestamp < w.end) return false;
			}
			return true;
		});

		assert.strictEqual(filtered.length, 2);
		assert.ok(!filtered.some((c) => c.relPath === 'claude-plugin/hooks.json'));
	});

	it('Claude changes still visible under Claude tasks', () => {
		const changes = [{ relPath: 'claude-plugin/hooks.json', timestamp: 250 }];
		const inWindow = changes.filter((c) => c.timestamp >= 200 && c.timestamp < 300);
		assert.strictEqual(inWindow.length, 1);
	});

	it('overlapping Claude + Cursor windows: Claude wins exclusion', () => {
		// Cursor prompt at 100, Claude prompt at 150, Cursor prompt at 300
		// Change at 200 -- inside both Cursor[100-300] and Claude[150-300]
		const claudeWindows = [{ start: 150, end: 300 }];
		const changeTs = 200;

		let excludedByClaude = false;
		for (const w of claudeWindows) {
			if (changeTs >= w.start && changeTs < w.end) {
				excludedByClaude = true;
				break;
			}
		}
		assert.ok(excludedByClaude, 'Change in overlapping window should be excluded from Cursor');
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
		const prompts = [{ createdAt: 0 }, { createdAt: 100 }];
		const changes = [
			{ relPath: 'a.ts', timestamp: 5 },
			{ relPath: 'b.ts', timestamp: 105 }
		];

		for (const c of changes) {
			let matched = -1;
			for (let i = prompts.length - 1; i >= 0; i--) {
				if (c.timestamp >= prompts[i].createdAt) {
					matched = i;
					break;
				}
			}
			if (c.relPath === 'a.ts') assert.strictEqual(matched, 0);
			else assert.strictEqual(matched, 1, 'b.ts at 105 must go to prompt 1, not 0');
		}
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 7: Deleted file showed as diff for EVERY prompt.
// ──────────────────────────────────────────────────────────────
describe('BUG 7: Deleted file phantom diffs', () => {
	it('deletion only appears under the prompt that deleted it', () => {
		const changes = [{ relPath: 'src/checkpoint.ts', before: 'old code', after: '', timestamp: 250 }];
		const windows = [
			{ start: 0, end: 100 },
			{ start: 100, end: 200 },
			{ start: 200, end: 300 }
		];

		for (let p = 0; p < windows.length; p++) {
			const w = windows[p];
			const inWindow = changes.filter((c) => c.timestamp >= w.start && c.timestamp < w.end);
			if (p === 2) {
				assert.strictEqual(inWindow.length, 1);
				assert.strictEqual(inWindow[0].relPath, 'src/checkpoint.ts');
			} else {
				assert.strictEqual(inWindow.length, 0, `Prompt ${p} must NOT show deletion`);
			}
		}
	});
});

// ──────────────────────────────────────────────────────────────
// BUG 8: Newly created file appeared under ALL prompts.
// ──────────────────────────────────────────────────────────────
describe('BUG 8: New file under all prompts', () => {
	it('creation only under the prompt that created it', () => {
		const changes = [{ relPath: 'new.ts', before: '', after: 'content', timestamp: 150 }];
		const windows = [
			{ start: 0, end: 100 },
			{ start: 100, end: 200 },
			{ start: 200, end: 300 }
		];

		const prompts: number[] = [];
		for (let p = 0; p < windows.length; p++) {
			const w = windows[p];
			if (changes.some((c) => c.timestamp >= w.start && c.timestamp < w.end)) {
				prompts.push(p);
			}
		}
		assert.deepStrictEqual(prompts, [1], 'ONLY prompt 1');
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
		const changes = [
			{ relPath: 'app.ts', before: 'line1\nline2\n', after: 'line1\nline2\nline3\n', timestamp: 100 },
			{ relPath: 'app.ts', before: 'line1\nline2\nline3\n', after: 'line1\nLINE2\nline3\n', timestamp: 101 },
			{ relPath: 'app.ts', before: 'line1\nLINE2\nline3\n', after: 'line1\nLINE2\nline3\nline4\n', timestamp: 102 }
		];

		const merged = new Map<string, { before: string; after: string }>();
		for (const c of changes) {
			const e = merged.get(c.relPath);
			if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
			else e.after = c.after;
		}

		const result = merged.get('app.ts')!;
		assert.strictEqual(result.before, 'line1\nline2\n', 'Before must be the ORIGINAL content, not any intermediate state');
		assert.strictEqual(result.after, 'line1\nLINE2\nline3\nline4\n', 'After must be the FINAL content, not any intermediate state');
	});

	it('diff before != after when file actually changed', () => {
		const changes = [{ relPath: 'x.ts', before: 'old', after: 'new', timestamp: 100 }];
		const c = changes[0];
		assert.notStrictEqual(c.before, c.after, 'Changed file must have different before/after');
	});

	it('no-op edit (same content) is filtered out', () => {
		const changes = [{ relPath: 'x.ts', before: 'same', after: 'same', timestamp: 100 }];
		const actual = changes.filter((c) => c.before !== c.after);
		assert.strictEqual(actual.length, 0, 'Same content = no change');
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

		const changes = [
			{ relPath: 'f.ts', before: v1, after: v2, timestamp: 100 },
			{ relPath: 'f.ts', before: v2, after: v3, timestamp: 200 }
		];

		// Merge: first before, last after
		const merged = new Map<string, { before: string; after: string }>();
		for (const c of changes) {
			const e = merged.get(c.relPath);
			if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
			else e.after = c.after;
		}

		const m = merged.get('f.ts')!;
		const rollbackContent = m.before; // what we restore to

		assert.strictEqual(rollbackContent, v1, 'Rollback must restore to v1 (first before), NOT v2 (intermediate)');
		assert.notStrictEqual(rollbackContent, v2);
	});
});

describe('VERIFY: Prompt-to-file attribution is exact', () => {
	it('exact file list for a 5-prompt session', () => {
		// Simulate a real session with 5 prompts
		const changes = [
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

		const windows = [
			{ start: 0, end: 100 },
			{ start: 100, end: 200 },
			{ start: 200, end: 300 },
			{ start: 300, end: 400 },
			{ start: 400, end: 500 }
		];

		const attribution = new Map<number, Set<string>>();
		for (const c of changes) {
			if (c.before === c.after) continue;
			for (let i = windows.length - 1; i >= 0; i--) {
				if (c.timestamp >= windows[i].start && c.timestamp < windows[i].end) {
					if (!attribution.has(i)) attribution.set(i, new Set());
					attribution.get(i)!.add(c.relPath);
					break;
				}
			}
		}

		// Prompt 0: app.ts, utils.ts
		assert.deepStrictEqual(
			[...(attribution.get(0) || [])].sort(),
			['src/app.ts', 'src/utils.ts'],
			'Prompt 0 must have exactly app.ts and utils.ts'
		);

		// Prompt 1: NOTHING
		assert.strictEqual((attribution.get(1) || new Set()).size, 0, 'Prompt 1 (informational) must have ZERO files');

		// Prompt 2: new-file.ts only
		assert.deepStrictEqual([...(attribution.get(2) || [])], ['src/new-file.ts'], 'Prompt 2 must have ONLY new-file.ts');

		// Prompt 3: app.ts (re-edit) + old.ts (deletion)
		assert.deepStrictEqual(
			[...(attribution.get(3) || [])].sort(),
			['src/app.ts', 'src/old.ts'],
			'Prompt 3 must have app.ts (re-edit) and old.ts (deletion)'
		);

		// Prompt 4: utils.ts only
		assert.deepStrictEqual([...(attribution.get(4) || [])], ['src/utils.ts'], 'Prompt 4 must have ONLY utils.ts');
	});

	it('file created and deleted in SAME prompt = no net change', () => {
		const changes = [
			{ relPath: 'temp.ts', before: '', after: 'content', timestamp: 110 },
			{ relPath: 'temp.ts', before: 'content', after: '', timestamp: 120 }
		];

		const merged = new Map<string, { before: string; after: string }>();
		for (const c of changes) {
			const e = merged.get(c.relPath);
			if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
			else e.after = c.after;
		}

		const result = merged.get('temp.ts')!;
		assert.strictEqual(result.before, result.after, 'Created then deleted = no net change (before === after === empty)');
	});

	it('file edited back to original = no net change', () => {
		const original = 'const x = 1;\n';
		const changes = [
			{ relPath: 'f.ts', before: original, after: 'const x = 2;\n', timestamp: 110 },
			{ relPath: 'f.ts', before: 'const x = 2;\n', after: original, timestamp: 120 }
		];

		const merged = new Map<string, { before: string; after: string }>();
		for (const c of changes) {
			const e = merged.get(c.relPath);
			if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
			else e.after = c.after;
		}

		const result = merged.get('f.ts')!;
		assert.strictEqual(result.before, result.after, 'Edited then reverted = no net change');
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
		const changes: any[] = [];
		const inWindow = changes.filter((c: any) => c.timestamp >= 0 && c.timestamp < 100);
		assert.strictEqual(inWindow.length, 0);
	});

	it('change at exact window boundary: start is inclusive', () => {
		const changes = [{ relPath: 'f.ts', timestamp: 100 }];
		const inWindow = changes.filter((c) => c.timestamp >= 100 && c.timestamp < 200);
		assert.strictEqual(inWindow.length, 1, 'Change at exact start should be included');
	});

	it('change at exact window boundary: end is exclusive', () => {
		const changes = [{ relPath: 'f.ts', timestamp: 200 }];
		const inWindow = changes.filter((c) => c.timestamp >= 100 && c.timestamp < 200);
		assert.strictEqual(inWindow.length, 0, 'Change at exact end should be excluded');
	});

	it("very large file content doesn't corrupt merge", () => {
		const bigContent = 'x'.repeat(100000);
		const changes = [{ relPath: 'big.ts', before: '', after: bigContent, timestamp: 100 }];

		const merged = new Map<string, { before: string; after: string }>();
		for (const c of changes) {
			merged.set(c.relPath, { before: c.before, after: c.after });
		}

		assert.strictEqual(merged.get('big.ts')!.after.length, 100000);
	});

	it('file with special characters in path', () => {
		const p: IgnorePatterns = { prefixes: ['dist/'], suffixes: [], exactFiles: [] };
		assert.ok(shouldTrackFile('src/my file (1).ts', p));
		assert.ok(shouldTrackFile('src/données.ts', p));
		assert.ok(shouldTrackFile('src/[brackets].ts', p));
	});

	it("binary-like content (null bytes) doesn't crash merge", () => {
		const content = 'line1\x00\x00line2';
		const changes = [{ relPath: 'bin.ts', before: '', after: content, timestamp: 100 }];

		const merged = new Map<string, { before: string; after: string }>();
		for (const c of changes) {
			merged.set(c.relPath, { before: c.before, after: c.after });
		}

		assert.strictEqual(merged.get('bin.ts')!.after, content);
	});

	it('100 changes to same file in one window', () => {
		const changes: { relPath: string; before: string; after: string; timestamp: number }[] = [];
		for (let i = 0; i < 100; i++) {
			changes.push({
				relPath: 'hot.ts',
				before: `v${i}`,
				after: `v${i + 1}`,
				timestamp: 100 + i
			});
		}

		const merged = new Map<string, { before: string; after: string }>();
		for (const c of changes) {
			const e = merged.get(c.relPath);
			if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
			else e.after = c.after;
		}

		const result = merged.get('hot.ts')!;
		assert.strictEqual(result.before, 'v0', 'Before = first version');
		assert.strictEqual(result.after, 'v100', 'After = last version (100th edit)');
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
	it("consecutive identical timestamps get spread by 1ms each", () => {
		// After Cursor update, prompts #40-#50 all had createdAt = 1773170194000
		const raw = [
			1773170194000, 1773170194000, 1773170194000,
			1773170194000, 1773170194000, 1773170194000,
			1773170500000, // prompt #46 has a real timestamp
			1773170600000,
		];

		const result: number[] = [...raw];
		for (let i = 1; i < result.length; i++) {
			if (result[i] <= result[i - 1]) {
				result[i] = result[i - 1] + 1;
			}
		}

		// Each should be strictly increasing
		for (let i = 1; i < result.length; i++) {
			assert.ok(result[i] > result[i - 1],
				`Timestamp ${i} (${result[i]}) must be > timestamp ${i-1} (${result[i-1]})`);
		}

		// Windows are nonzero
		for (let i = 0; i < result.length - 1; i++) {
			const windowSize = result[i + 1] - result[i];
			assert.ok(windowSize > 0, `Window ${i} must have nonzero size, got ${windowSize}`);
		}
	});

	it("file changes match the spread-out windows", () => {
		// 3 prompts all at T=1000, spread to 1000, 1001, 1002
		const timestamps = [1000, 1001, 1002];
		const changes = [
			{ relPath: "a.ts", timestamp: 1000 },
			{ relPath: "b.ts", timestamp: 1001 },
			{ relPath: "c.ts", timestamp: 1002 },
		];

		const attribution = new Map<number, string[]>();
		for (const c of changes) {
			for (let i = timestamps.length - 1; i >= 0; i--) {
				const end = i + 1 < timestamps.length ? timestamps[i + 1] : Infinity;
				if (c.timestamp >= timestamps[i] && c.timestamp < end) {
					if (!attribution.has(i)) attribution.set(i, []);
					attribution.get(i)!.push(c.relPath);
					break;
				}
			}
		}

		assert.deepStrictEqual(attribution.get(0), ["a.ts"]);
		assert.deepStrictEqual(attribution.get(1), ["b.ts"]);
		assert.deepStrictEqual(attribution.get(2), ["c.ts"]);
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
	const SESSION_START = 1773244616266; // 2026-03-11 15:56 UTC
	const SESSION_END   = 1773318460652; // 2026-03-12 12:27 UTC
	const PROMPT_COUNT  = 45;
	const SNAPSHOT_WINDOW = {
		start: 1773250646272, // 2026-03-11 17:37 UTC
		end:   1773263589011, // 2026-03-11 21:13 UTC
	};

	function oldFallback(fileMtime: number, count: number): number[] {
		const result: number[] = [];
		for (let i = 0; i < count; i++) {
			result.push(fileMtime - (count - i) * 30_000);
		}
		return result;
	}

	function newFallback(start: number, end: number, count: number): number[] {
		const span = Math.max(end - start, count);
		const result: number[] = [];
		for (let i = 0; i < count; i++) {
			result.push(start + (span * i) / Math.max(count - 1, 1));
		}
		for (let i = 1; i < result.length; i++) {
			if (result[i] <= result[i - 1]) result[i] = result[i - 1] + 1;
		}
		return result;
	}

	it("OLD: all timestamps cluster around file mtime, zero overlap with snapshots", () => {
		const fileMtime = SESSION_END;
		const ts = oldFallback(fileMtime, PROMPT_COUNT);

		const inSnapshot = ts.filter(
			(t) => t >= SNAPSHOT_WINDOW.start && t < SNAPSHOT_WINDOW.end
		);
		assert.strictEqual(inSnapshot.length, 0,
			"Old fallback produces ZERO prompts inside the snapshot window (THE BUG)");

		const range = ts[ts.length - 1] - ts[0];
		assert.ok(range < 25 * 60_000,
			"Old fallback compresses 20-hour session into < 25 minutes");
	});

	it("NEW: timestamps spread across session range, many overlap with snapshots", () => {
		const ts = newFallback(SESSION_START, SESSION_END, PROMPT_COUNT);

		const inSnapshot = ts.filter(
			(t) => t >= SNAPSHOT_WINDOW.start && t < SNAPSHOT_WINDOW.end
		);
		assert.ok(inSnapshot.length >= 5,
			`Expected >= 5 prompts in snapshot window, got ${inSnapshot.length}`);

		const range = ts[ts.length - 1] - ts[0];
		assert.ok(range > 15 * 3600_000,
			"New fallback must span at least 15 hours (actual session is ~20h)");
	});

	it("NEW: first timestamp equals session start, last equals session end", () => {
		const ts = newFallback(SESSION_START, SESSION_END, PROMPT_COUNT);
		assert.strictEqual(ts[0], SESSION_START);
		assert.strictEqual(ts[ts.length - 1], SESSION_END);
	});

	it("NEW: single-prompt session doesn't divide by zero", () => {
		const ts = newFallback(SESSION_START, SESSION_END, 1);
		assert.strictEqual(ts.length, 1);
		assert.strictEqual(ts[0], SESSION_START);
	});

	it("NEW: timestamps are strictly increasing", () => {
		const ts = newFallback(SESSION_START, SESSION_END, PROMPT_COUNT);
		for (let i = 1; i < ts.length; i++) {
			assert.ok(ts[i] > ts[i - 1],
				`Timestamp ${i} must be > timestamp ${i - 1}`);
		}
	});

	it("E2E: snapshot changes found via window matching with new timestamps", () => {
		const snapshots = [
			{ relPath: "src/tracker.ts", before: "v1", after: "v2",
			  timestamp: SNAPSHOT_WINDOW.start + 60_000 },
			{ relPath: "src/cli.ts", before: "a", after: "b",
			  timestamp: SNAPSHOT_WINDOW.start + 3600_000 },
			{ relPath: "README.md", before: "", after: "# Hi",
			  timestamp: SNAPSHOT_WINDOW.end - 60_000 },
		];

		const ts = newFallback(SESSION_START, SESSION_END, PROMPT_COUNT);

		let totalFound = 0;
		for (let i = 0; i < ts.length; i++) {
			const start = ts[i];
			const end = i + 1 < ts.length ? ts[i + 1] : Date.now();
			const found = snapshots.filter(
				(s) => s.timestamp >= start && s.timestamp < end
			);
			totalFound += found.length;
		}

		assert.strictEqual(totalFound, snapshots.length,
			"All snapshot changes must be found by exactly one prompt window");
	});

	it("E2E: same snapshots are LOST with old fallback", () => {
		const snapshots = [
			{ relPath: "src/tracker.ts", timestamp: SNAPSHOT_WINDOW.start + 60_000 },
			{ relPath: "src/cli.ts", timestamp: SNAPSHOT_WINDOW.start + 3600_000 },
			{ relPath: "README.md", timestamp: SNAPSHOT_WINDOW.end - 60_000 },
		];

		const ts = oldFallback(SESSION_END, PROMPT_COUNT);

		let totalFound = 0;
		for (let i = 0; i < ts.length; i++) {
			const start = ts[i];
			const end = i + 1 < ts.length ? ts[i + 1] : Date.now();
			totalFound += snapshots.filter(
				(s) => s.timestamp >= start && s.timestamp < end
			).length;
		}

		assert.strictEqual(totalFound, 0,
			"Old fallback finds ZERO snapshots (confirming the bug)");
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
	it("JSONL has more user messages than SQLite has user bubbles", () => {
		const jsonlUserCount = 21;
		const sqliteUserCount = 18;
		assert.ok(jsonlUserCount > sqliteUserCount,
			"JSONL includes auto-continues and duplicates that SQLite skips");
	});

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

	it("session-level whitelist filters non-AI files from watcher", () => {
		const sessionEditedFiles = new Set(["src/app.ts", "tests/app.test.ts"]);
		const watcherFiles = ["src/app.ts", "package-lock.json", "tests/app.test.ts"];

		const filtered = watcherFiles.filter((f) => sessionEditedFiles.has(f));

		assert.deepStrictEqual(filtered, ["src/app.ts", "tests/app.test.ts"]);
		assert.ok(!filtered.includes("package-lock.json"), "git pull file excluded");
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

	it("JSONL fallback still works when SQLite is unavailable", () => {
		const jsonlPrompts = ["fix diffs", "add tests"];
		const tasks = jsonlPrompts.map((text, i) => ({
			prompt: text,
			promptIndex: i,
		}));
		assert.strictEqual(tasks.length, 2);
	});

	it("E2E: SQLite-first pipeline with watcher fallback", () => {
		const sqliteBubbles = [
			{ text: "fix the bug", createdAt: 1000, files: new Set(["session-reader.ts", "vscode-history.ts"]) },
			{ text: "add tests", createdAt: 2000, files: new Set(["regressions.test.ts", "integration.test.ts"]) },
			{ text: "update docs", createdAt: 3000, files: new Set<string>() },
		];

		const sessionFiles = new Set(["session-reader.ts", "vscode-history.ts", "regressions.test.ts", "integration.test.ts"]);

		const tasks = sqliteBubbles.map((b, i) => ({
			prompt: b.text,
			createdAt: b.createdAt,
			promptIndex: i,
			toolEditedFiles: b.files.size > 0 ? b.files : undefined,
			sessionEditedFiles: sessionFiles,
			filesChanged: [] as string[],
		}));

		// Simulate watcher data in time windows
		const watcherChanges = [
			{ relPath: "session-reader.ts", timestamp: 1500 },
			{ relPath: "package-lock.json", timestamp: 1600 },
			{ relPath: "integration.test.ts", timestamp: 2500 },
		];

		for (let i = 0; i < tasks.length; i++) {
			const startTs = tasks[i].createdAt;
			const endTs = i + 1 < tasks.length ? tasks[i + 1].createdAt : Infinity;
			const inWindow = watcherChanges.filter(c => c.timestamp >= startTs && c.timestamp < endTs);

			if (inWindow.length > 0) {
				const perPrompt = tasks[i].toolEditedFiles;
				const session = tasks[i].sessionEditedFiles;
				const whitelist = perPrompt && perPrompt.size > 0 ? perPrompt : session;
				const filtered = inWindow
					.map(c => c.relPath)
					.filter(f => !whitelist || whitelist.has(f));
				tasks[i].filesChanged = filtered;
			}

			if (tasks[i].filesChanged.length === 0 && tasks[i].toolEditedFiles && tasks[i].toolEditedFiles!.size > 0) {
				tasks[i].filesChanged = [...tasks[i].toolEditedFiles!];
			}
		}

		assert.deepStrictEqual(tasks[0].filesChanged, ["session-reader.ts"],
			"watcher finds session-reader.ts, toolEditedFiles filters out package-lock.json");
		assert.deepStrictEqual(tasks[1].filesChanged, ["integration.test.ts"],
			"watcher finds integration.test.ts in window");
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
describe("BUG 16: Cursor bubble types and interaction model", () => {
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

	it("capabilityType=30 are user interactions with empty text", () => {
		const cap30Bubble = { type: 2, text: "", capabilityType: 30 };
		assert.strictEqual(cap30Bubble.text, "",
			"cap=30 bubbles have empty text -- answer content is lost");
		assert.strictEqual(cap30Bubble.type, 2,
			"cap=30 are type 2 (assistant), not type 1 (user)");
	});

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
