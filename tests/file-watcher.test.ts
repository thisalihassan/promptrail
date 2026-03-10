import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadGitignorePatterns,
  shouldTrackFile,
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

describe("getChangesInWindow (via fixture data)", () => {
  it("returns changes within timestamp window", () => {
    const changes = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "changes.json"),
        "utf-8"
      )
    );

    const inWindow = changes.filter(
      (c: any) => c.timestamp >= 1773100040000 && c.timestamp < 1773100100000
    );

    assert.strictEqual(inWindow.length, 2, "Should find 2 changes for app.ts in window");
    assert.ok(inWindow.every((c: any) => c.relPath === "src/app.ts"));
  });

  it("merges multiple edits to same file: first before, last after", () => {
    const changes = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "changes.json"),
        "utf-8"
      )
    );

    const inWindow = changes.filter(
      (c: any) => c.timestamp >= 1773100040000 && c.timestamp < 1773100100000
    );

    const merged = new Map<string, { before: string; after: string }>();
    for (const c of inWindow) {
      const existing = merged.get(c.relPath);
      if (!existing) {
        merged.set(c.relPath, { before: c.before, after: c.after });
      } else {
        existing.after = c.after;
      }
    }

    const appTs = merged.get("src/app.ts");
    assert.ok(appTs);
    assert.ok(appTs!.before.includes('"hello"'), "Before should be the first version");
    assert.ok(appTs!.after.includes('"hello world!"'), "After should be the last version");
  });

  it("Claude window exclusion filters out overlapping changes", () => {
    const changes = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "changes.json"),
        "utf-8"
      )
    );

    const claudeWindows = [{ start: 1773100200000, end: 1773100300000 }];

    const cursorWindowStart = 1773100000000;
    const cursorWindowEnd = 1773100400000;

    const inWindow = changes.filter((c: any) => {
      if (c.timestamp < cursorWindowStart || c.timestamp >= cursorWindowEnd)
        return false;
      for (const w of claudeWindows) {
        if (c.timestamp >= w.start && c.timestamp < w.end) return false;
      }
      return true;
    });

    const claudePluginChanges = inWindow.filter((c: any) =>
      c.relPath.startsWith("claude-plugin/")
    );
    assert.strictEqual(
      claudePluginChanges.length,
      0,
      "Claude plugin changes at 1773100250000 should be excluded (inside Claude window)"
    );

    assert.ok(inWindow.length > 0, "Should still have non-Claude changes");
  });

  it("empty window returns no changes", () => {
    const changes = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "changes.json"),
        "utf-8"
      )
    );

    const inWindow = changes.filter(
      (c: any) => c.timestamp >= 9999999999999 && c.timestamp < 9999999999999
    );
    assert.strictEqual(inWindow.length, 0);
  });

  it("detects file deletions (after is empty string)", () => {
    const changes = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "changes.json"),
        "utf-8"
      )
    );

    const deletion = changes.find(
      (c: any) => c.relPath === "src/deleted.ts"
    );
    assert.ok(deletion);
    assert.strictEqual(deletion.before, "// old code\n");
    assert.strictEqual(deletion.after, "");
  });

  it("detects file creation (before is empty string)", () => {
    const changes = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "changes.json"),
        "utf-8"
      )
    );

    const creation = changes.find(
      (c: any) => c.relPath === "src/new-file.ts"
    );
    assert.ok(creation);
    assert.strictEqual(creation.before, "");
    assert.ok(creation.after.includes("VERSION"));
  });
});
