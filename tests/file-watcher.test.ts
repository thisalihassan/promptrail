import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadGitignorePatterns,
  shouldTrackFile,
  mergeChangesInWindow,
  ALWAYS_IGNORE,
  NEVER_IGNORE,
  type IgnorePatterns,
} from "../src/core/file-watcher";

describe("loadGitignorePatterns", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-gitignore-"));
    fs.copyFileSync(
      path.join(__dirname, "fixtures", "sample.gitignore"),
      path.join(tmpDir, ".gitignore")
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses directory patterns as prefixes", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    assert.ok(patterns.prefixes.includes("node_modules/"));
    assert.ok(patterns.prefixes.includes("dist/"));
  });

  it("parses glob suffix patterns", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    assert.ok(patterns.suffixes.includes(".vsix"));
    assert.ok(patterns.suffixes.includes(".tgz"));
    assert.ok(patterns.suffixes.includes(".log"));
  });

  it("parses exact file patterns", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    assert.ok(patterns.exactFiles.includes(".env"));
    assert.ok(patterns.exactFiles.includes(".env.local"));
  });

  it("skips comments and blank lines", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    const all = [
      ...patterns.prefixes,
      ...patterns.suffixes,
      ...patterns.exactFiles,
    ].join(",");
    assert.ok(!all.includes("#"), "Comments should be excluded");
    assert.ok(!all.includes("Dependencies"), "Comment text should be excluded");
  });

  it("NEVER ignores .cursor/ even if in gitignore", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    assert.ok(
      !patterns.prefixes.includes(".cursor/"),
      ".cursor/ should be excluded from ignore prefixes"
    );
  });

  it("NEVER ignores .claude/ even if in gitignore", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    assert.ok(
      !patterns.prefixes.includes(".claude/"),
      ".claude/ should NOT appear in prefixes (not in sample gitignore but protected)"
    );
  });

  it("ALWAYS ignores .git/ and .promptrail/", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    assert.ok(patterns.prefixes.includes(".git/"));
    assert.ok(patterns.prefixes.includes(".promptrail/"));
  });

  it("always includes node_modules/ even if not in gitignore", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-empty-"));
    const patterns = loadGitignorePatterns(emptyDir);
    assert.ok(patterns.prefixes.includes("node_modules/"));
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("handles missing .gitignore gracefully", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-nogi-"));
    const patterns = loadGitignorePatterns(emptyDir);
    assert.ok(patterns.prefixes.length > 0, "Should still have ALWAYS_IGNORE entries");
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("deduplicates patterns", () => {
    const patterns = loadGitignorePatterns(tmpDir);
    const unique = new Set(patterns.prefixes);
    assert.strictEqual(patterns.prefixes.length, unique.size);
  });
});

describe("shouldTrackFile", () => {
  const patterns: IgnorePatterns = {
    prefixes: [".git/", ".promptrail/", "node_modules/", "dist/", ".vscode/"],
    suffixes: [".vsix", ".tgz", ".log"],
    exactFiles: [".env", ".env.local"],
  };

  it("tracks normal source files", () => {
    assert.strictEqual(shouldTrackFile("src/foo.ts", patterns), true);
    assert.strictEqual(shouldTrackFile("package.json", patterns), true);
    assert.strictEqual(shouldTrackFile("README.md", patterns), true);
  });

  it("ignores node_modules", () => {
    assert.strictEqual(shouldTrackFile("node_modules/foo/index.js", patterns), false);
  });

  it("ignores dist", () => {
    assert.strictEqual(shouldTrackFile("dist/extension.js", patterns), false);
  });

  it("ignores .git", () => {
    assert.strictEqual(shouldTrackFile(".git/config", patterns), false);
    assert.strictEqual(shouldTrackFile(".git/HEAD", patterns), false);
  });

  it("ignores .promptrail", () => {
    assert.strictEqual(shouldTrackFile(".promptrail/snapshots/changes.json", patterns), false);
  });

  it("ignores suffix patterns", () => {
    assert.strictEqual(shouldTrackFile("promptrail-0.3.0.vsix", patterns), false);
    assert.strictEqual(shouldTrackFile("foo.tgz", patterns), false);
    assert.strictEqual(shouldTrackFile("debug.log", patterns), false);
  });

  it("ignores exact file matches", () => {
    assert.strictEqual(shouldTrackFile(".env", patterns), false);
    assert.strictEqual(shouldTrackFile(".env.local", patterns), false);
  });

  it("tracks .cursor/ (NEVER_IGNORE)", () => {
    assert.strictEqual(shouldTrackFile(".cursor/skills/foo/SKILL.md", patterns), true);
    assert.strictEqual(shouldTrackFile(".cursor/rules/bar.md", patterns), true);
  });

  it("tracks .claude/ (NEVER_IGNORE)", () => {
    assert.strictEqual(shouldTrackFile(".claude/settings.json", patterns), true);
  });

  it("tracks claude-plugin/ (normal directory)", () => {
    assert.strictEqual(shouldTrackFile("claude-plugin/hooks.json", patterns), true);
  });

  it("ignores absolute paths", () => {
    assert.strictEqual(shouldTrackFile("/Users/foo/bar.ts", patterns), false);
  });

  it("ignores .tmp. files", () => {
    assert.strictEqual(shouldTrackFile("CLAUDE.md.tmp.98875.123", patterns), false);
    assert.strictEqual(shouldTrackFile("foo.tmp.12345.67890", patterns), false);
  });

  it("tracks files with .tmp in the name but not the pattern", () => {
    assert.strictEqual(shouldTrackFile("src/tmp-handler.ts", patterns), true);
  });
});

describe("mergeChangesInWindow (real function)", () => {
  let fixtureChanges: Array<{ relPath: string; before: string; after: string; timestamp: number }>;

  before(() => {
    fixtureChanges = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures", "changes.json"), "utf-8")
    );
  });

  it("returns only changes within the timestamp window", () => {
    const { files } = mergeChangesInWindow(fixtureChanges, 1773100040000, 1773100100000);
    assert.strictEqual(files.length, 1);
    assert.ok(files.includes("src/app.ts"));
  });

  it("merges multiple edits: first before, last after", () => {
    const { changes } = mergeChangesInWindow(fixtureChanges, 1773100040000, 1773100100000);
    const appTs = changes.find((c) => c.relativePath === "src/app.ts");
    assert.ok(appTs);
    assert.ok(appTs!.before!.includes('"hello"'), "Before should be the first version");
    assert.ok(appTs!.after!.includes('"hello world!"'), "After should be the last version");
  });

  it("excludeWindows filters out overlapping changes", () => {
    const excludeWindows = [{ start: 1773100200000, end: 1773100300000 }];
    const { files } = mergeChangesInWindow(fixtureChanges, 1773100000000, 1773100400000, excludeWindows);
    assert.ok(!files.includes("claude-plugin/hooks.json"),
      "Claude plugin change at 1773100250000 should be excluded");
    assert.ok(files.length > 0, "Should still have non-excluded changes");
  });

  it("empty window returns no changes", () => {
    const { files, changes } = mergeChangesInWindow(fixtureChanges, 9999999999999, 9999999999999);
    assert.strictEqual(files.length, 0);
    assert.strictEqual(changes.length, 0);
  });

  it("detects file deletions (before has content, after is empty)", () => {
    const { changes } = mergeChangesInWindow(fixtureChanges, 1773100300000, 1773100400000);
    const deletion = changes.find((c) => c.relativePath === "src/deleted.ts");
    assert.ok(deletion);
    assert.strictEqual(deletion!.type, "deleted");
    assert.strictEqual(deletion!.before, "// old code\n");
    assert.strictEqual(deletion!.after, "");
  });

  it("detects file creation (before is empty, after has content)", () => {
    const { changes } = mergeChangesInWindow(fixtureChanges, 1773100120000, 1773100250000);
    const creation = changes.find((c) => c.relativePath === "src/new-file.ts");
    assert.ok(creation);
    assert.strictEqual(creation!.type, "added");
    assert.strictEqual(creation!.before, "");
    assert.ok(creation!.after!.includes("VERSION"));
  });

  it("skips no-op changes where before === after", () => {
    const changes = [
      { relPath: "noop.ts", before: "same", after: "same", timestamp: 500 },
      { relPath: "real.ts", before: "old", after: "new", timestamp: 600 },
    ];
    const { files } = mergeChangesInWindow(changes, 0, 1000);
    assert.ok(!files.includes("noop.ts"), "No-op should be filtered out");
    assert.ok(files.includes("real.ts"));
  });

  it("rapid successive edits merge to first-before and last-after", () => {
    const changes = [
      { relPath: "rapid.ts", before: "v1", after: "v2", timestamp: 100 },
      { relPath: "rapid.ts", before: "v2", after: "v3", timestamp: 101 },
      { relPath: "rapid.ts", before: "v3", after: "v4", timestamp: 102 },
    ];
    const result = mergeChangesInWindow(changes, 0, 1000);
    const rapid = result.changes.find((c) => c.relativePath === "rapid.ts");
    assert.ok(rapid);
    assert.strictEqual(rapid!.before, "v1");
    assert.strictEqual(rapid!.after, "v4");
  });

  it("file created then deleted in same window = no net change", () => {
    const changes = [
      { relPath: "tmp.ts", before: "", after: "content", timestamp: 100 },
      { relPath: "tmp.ts", before: "content", after: "", timestamp: 200 },
    ];
    const { files } = mergeChangesInWindow(changes, 0, 1000);
    assert.ok(!files.includes("tmp.ts"), "Created then deleted = no net change");
  });

  it("interleaved edits to multiple files tracked independently", () => {
    const changes = [
      { relPath: "a.ts", before: "a1", after: "a2", timestamp: 100 },
      { relPath: "b.ts", before: "b1", after: "b2", timestamp: 101 },
      { relPath: "a.ts", before: "a2", after: "a3", timestamp: 102 },
    ];
    const result = mergeChangesInWindow(changes, 0, 1000);
    const a = result.changes.find((c) => c.relativePath === "a.ts");
    const b = result.changes.find((c) => c.relativePath === "b.ts");
    assert.ok(a && b);
    assert.strictEqual(a!.before, "a1");
    assert.strictEqual(a!.after, "a3");
    assert.strictEqual(b!.before, "b1");
    assert.strictEqual(b!.after, "b2");
  });

  it("start is inclusive, end is exclusive", () => {
    const changes = [
      { relPath: "at-start.ts", before: "a", after: "b", timestamp: 100 },
      { relPath: "at-end.ts", before: "c", after: "d", timestamp: 200 },
    ];
    const { files } = mergeChangesInWindow(changes, 100, 200);
    assert.ok(files.includes("at-start.ts"), "Change at exact start should be included");
    assert.ok(!files.includes("at-end.ts"), "Change at exact end should be excluded");
  });
});
