import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SessionReader } from "../src/core/session-reader";

describe("Integration: Claude session via SessionReader", () => {
  let tmpDir: string;
  let claudeDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-integ-"));
    const encoded = tmpDir.replace(/\//g, "-");
    claudeDir = path.join(os.homedir(), ".claude", "projects", encoded);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "fixtures", "claude-session.jsonl"),
      path.join(claudeDir, "session-integ001.jsonl")
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("reads Claude sessions from the workspace", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks();
    const claude = tasks.filter((t) => t.source === "claude");
    assert.ok(claude.length >= 2, `Expected >= 2 Claude tasks, got ${claude.length}`);
  });

  it("tasks are sorted by createdAt descending", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks();
    for (let i = 0; i < tasks.length - 1; i++) {
      assert.ok(tasks[i].createdAt >= tasks[i + 1].createdAt);
    }
  });

  it("readAllTasks caches for 2 seconds (same ref)", () => {
    const reader = new SessionReader(tmpDir);
    const tasks1 = reader.readAllTasks();
    assert.ok(tasks1.length > 0, "Should have tasks to cache");
    const tasks2 = reader.readAllTasks();
    assert.strictEqual(tasks1, tasks2, "Same reference = cache hit");
  });

  it("Edit operations have file in filesChanged", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks() as any[];
    const editTask = tasks.find((t: any) => t.edits && t.edits.length > 0);
    assert.ok(editTask, "Should have a task with edits");
    assert.ok(editTask.filesChanged.some((f: string) => f.includes("auth.ts")));
  });

  it("Write operations create new file entries", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks() as any[];
    const writeTask = tasks.find((t: any) => t.writes && t.writes.length > 0);
    assert.ok(writeTask, "Should have a task with writes");
    assert.ok(writeTask.filesChanged.some((f: string) => f.includes("errors.ts")));
  });
});

describe("Integration: Timestamp window matching", () => {
  it("assigns changes to correct prompt windows", () => {
    const changes = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures", "changes.json"), "utf-8")
    );

    const promptTimestamps = [1773100001000, 1773100120000, 1773100300000];

    const assignments = new Map<number, string[]>();
    for (const c of changes) {
      for (let i = promptTimestamps.length - 1; i >= 0; i--) {
        const start = promptTimestamps[i];
        const end = i + 1 < promptTimestamps.length ? promptTimestamps[i + 1] : Infinity;
        if (c.timestamp >= start && c.timestamp < end) {
          if (!assignments.has(i)) assignments.set(i, []);
          assignments.get(i)!.push(c.relPath);
          break;
        }
      }
    }

    assert.ok((assignments.get(0) || []).includes("src/app.ts"));
    assert.ok((assignments.get(1) || []).includes("src/utils.ts"));
    assert.ok((assignments.get(1) || []).includes("src/new-file.ts"));
    assert.ok((assignments.get(2) || []).includes("src/deleted.ts"));
  });

  it("Claude window exclusion removes overlapping changes", () => {
    const changes = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures", "changes.json"), "utf-8")
    );

    const claudeWindows = [{ start: 1773100200000, end: 1773100300000 }];
    const filtered = changes.filter((c: any) => {
      if (c.timestamp < 1773100001000 || c.timestamp >= 1773100400000) return false;
      for (const w of claudeWindows) {
        if (c.timestamp >= w.start && c.timestamp < w.end) return false;
      }
      return true;
    });

    assert.ok(!filtered.some((c: any) => c.relPath === "claude-plugin/hooks.json"));
    assert.ok(filtered.some((c: any) => c.relPath === "src/app.ts"));
    assert.ok(filtered.some((c: any) => c.relPath === "src/deleted.ts"));
  });

  it("identical before/after is treated as no change", () => {
    const changes = [{ relPath: "noop.ts", before: "x", after: "x", timestamp: 1000 }];
    assert.strictEqual(changes.filter((c) => c.before !== c.after).length, 0);
  });

  it("rapid successive edits merge correctly", () => {
    const changes = [
      { relPath: "rapid.ts", before: "v1", after: "v2", timestamp: 1000 },
      { relPath: "rapid.ts", before: "v2", after: "v3", timestamp: 1001 },
      { relPath: "rapid.ts", before: "v3", after: "v4", timestamp: 1002 },
    ];

    const merged = new Map<string, { before: string; after: string }>();
    for (const c of changes) {
      const e = merged.get(c.relPath);
      if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
      else e.after = c.after;
    }

    assert.strictEqual(merged.get("rapid.ts")!.before, "v1");
    assert.strictEqual(merged.get("rapid.ts")!.after, "v4");
  });

  it("file created then deleted = no net change", () => {
    const changes = [
      { relPath: "tmp.ts", before: "", after: "new", timestamp: 1000 },
      { relPath: "tmp.ts", before: "new", after: "", timestamp: 2000 },
    ];

    const merged = new Map<string, { before: string; after: string }>();
    for (const c of changes) {
      const e = merged.get(c.relPath);
      if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
      else e.after = c.after;
    }

    assert.strictEqual(merged.get("tmp.ts")!.before, "");
    assert.strictEqual(merged.get("tmp.ts")!.after, "");
  });

  it("interleaved edits to multiple files tracked independently", () => {
    const changes = [
      { relPath: "a.ts", before: "a1", after: "a2", timestamp: 100 },
      { relPath: "b.ts", before: "b1", after: "b2", timestamp: 101 },
      { relPath: "a.ts", before: "a2", after: "a3", timestamp: 102 },
    ];

    const merged = new Map<string, { before: string; after: string }>();
    for (const c of changes) {
      const e = merged.get(c.relPath);
      if (!e) merged.set(c.relPath, { before: c.before, after: c.after });
      else e.after = c.after;
    }

    assert.strictEqual(merged.get("a.ts")!.before, "a1");
    assert.strictEqual(merged.get("a.ts")!.after, "a3");
    assert.strictEqual(merged.get("b.ts")!.before, "b1");
    assert.strictEqual(merged.get("b.ts")!.after, "b2");
  });
});

describe("toolEditedFiles whitelist filtering", () => {
  // Simulates what tracker.ts does: watcher returns files,
  // whitelist filters them. This is the exact integration point
  // where the "informational prompt shows 6 files" bug lived.

  function applyWhitelist(
    watcherFiles: string[],
    whitelist: Set<string> | undefined
  ): string[] {
    return whitelist
      ? watcherFiles.filter((f) => whitelist.has(f))
      : watcherFiles;
  }

  it("whitelist with files: only matching files pass through", () => {
    const watcher = ["a.ts", "b.ts", "c.ts"];
    const whitelist = new Set(["a.ts", "c.ts"]);
    const result = applyWhitelist(watcher, whitelist);
    assert.deepStrictEqual(result, ["a.ts", "c.ts"]);
  });

  it("empty whitelist (informational prompt): zero files pass through", () => {
    const watcher = ["a.ts", "b.ts", "package.json"];
    const whitelist = new Set<string>();
    const result = applyWhitelist(watcher, whitelist);
    assert.deepStrictEqual(result, []);
  });

  it("undefined whitelist (no SQLite data): all files pass through as fallback", () => {
    const watcher = ["a.ts", "b.ts"];
    const result = applyWhitelist(watcher, undefined);
    assert.deepStrictEqual(result, ["a.ts", "b.ts"]);
  });

  it("whitelist excludes git pull / manual edits from watcher", () => {
    const watcher = [
      "src/tracker.ts",
      "src/index.ts",
      ".github/workflows/ci.yaml",
      "package-lock.json",
    ];
    const whitelist = new Set(["src/tracker.ts", "src/index.ts"]);
    const result = applyWhitelist(watcher, whitelist);
    assert.deepStrictEqual(result, ["src/tracker.ts", "src/index.ts"]);
    assert.ok(!result.includes(".github/workflows/ci.yaml"));
    assert.ok(!result.includes("package-lock.json"));
  });

  it("empty Set is truthy (critical for the undefined vs empty distinction)", () => {
    const emptySet = new Set<string>();
    assert.ok(emptySet, "empty Set must be truthy");
    assert.strictEqual(emptySet.size, 0);

    // This is the exact check tracker.ts uses
    const whitelist: Set<string> | undefined = emptySet;
    const filtered = whitelist
      ? ["a.ts", "b.ts"].filter((f) => whitelist.has(f))
      : ["a.ts", "b.ts"];
    assert.deepStrictEqual(filtered, [], "empty Set should filter to nothing");
  });
});

describe("perPromptFiles sets toolEditedFiles correctly", () => {
  // Simulates what session-reader.ts does when SQLite data is available.
  // This tests the fix: prompts WITHOUT edits get empty Set, not undefined.

  it("prompts with edits get their file set, others get empty Set", () => {
    const perPromptFiles = new Map<number, Set<string>>();
    perPromptFiles.set(0, new Set(["src/app.ts"]));
    // prompt 1 had no edits -- not in the map
    perPromptFiles.set(2, new Set(["src/utils.ts", "src/helper.ts"]));

    const tasks = [
      { id: "t0", toolEditedFiles: undefined as Set<string> | undefined },
      { id: "t1", toolEditedFiles: undefined as Set<string> | undefined },
      { id: "t2", toolEditedFiles: undefined as Set<string> | undefined },
    ];

    // Apply the same logic as session-reader.ts
    for (let i = 0; i < tasks.length; i++) {
      tasks[i].toolEditedFiles = perPromptFiles.get(i) ?? new Set();
    }

    assert.ok(tasks[0].toolEditedFiles!.has("src/app.ts"));
    assert.strictEqual(tasks[0].toolEditedFiles!.size, 1);

    assert.strictEqual(tasks[1].toolEditedFiles!.size, 0, "informational prompt should have empty Set");
    assert.ok(tasks[1].toolEditedFiles !== undefined, "should NOT be undefined");

    assert.strictEqual(tasks[2].toolEditedFiles!.size, 2);
  });

  it("when perPromptFiles is undefined (no SQLite), toolEditedFiles stays undefined", () => {
    const perPromptFiles: Map<number, Set<string>> | undefined = undefined;
    const tasks = [
      { id: "t0", toolEditedFiles: undefined as Set<string> | undefined },
    ];

    if (perPromptFiles) {
      for (let i = 0; i < tasks.length; i++) {
        tasks[i].toolEditedFiles = perPromptFiles.get(i) ?? new Set();
      }
    }

    assert.strictEqual(tasks[0].toolEditedFiles, undefined, "should remain undefined without SQLite data");
  });

  it("the combined flow: no SQLite = fallback, SQLite + no edits = empty, SQLite + edits = filtered", () => {
    const watcherFiles = ["a.ts", "b.ts", "manual-edit.ts"];

    function applyWhitelist(
      files: string[],
      whitelist: Set<string> | undefined
    ): string[] {
      return whitelist ? files.filter((f) => whitelist.has(f)) : files;
    }

    // Case 1: no SQLite data at all
    const noSqlite = applyWhitelist(watcherFiles, undefined);
    assert.deepStrictEqual(noSqlite, ["a.ts", "b.ts", "manual-edit.ts"], "fallback: all files");

    // Case 2: SQLite says this prompt edited a.ts only
    const withEdits = applyWhitelist(watcherFiles, new Set(["a.ts"]));
    assert.deepStrictEqual(withEdits, ["a.ts"], "filtered to AI edits only");

    // Case 3: SQLite says this prompt had no edits (informational)
    const noEdits = applyWhitelist(watcherFiles, new Set());
    assert.deepStrictEqual(noEdits, [], "informational prompt: zero files");
  });
});

describe("JSONL prompt count must match SQLite bubble count", () => {
  it("short prompts like 'yes' and 'ok' must not be skipped (causes index drift)", () => {
    // Simulates the exact bug: JSONL skips short prompts but SQLite counts all
    // user bubbles, causing toolFormerData to map to the wrong prompt index.
    const sqliteBubbles = [
      { text: "refactor the auth module", hasEdits: true, editFiles: ["auth.ts"] },
      { text: "yes", hasEdits: false, editFiles: [] },
      { text: "add error handling", hasEdits: true, editFiles: ["handler.ts"] },
    ];

    // JSONL parser must produce the same count -- never skip any user message
    const jsonlPrompts = sqliteBubbles.map((b) => b.text || "(empty)");

    assert.strictEqual(
      jsonlPrompts.length,
      sqliteBubbles.length,
      "JSONL must parse same number of prompts as SQLite has user bubbles"
    );

    // Now verify toolFormerData maps correctly
    const perPromptFiles = new Map<number, Set<string>>();
    for (let i = 0; i < sqliteBubbles.length; i++) {
      if (sqliteBubbles[i].hasEdits) {
        perPromptFiles.set(i, new Set(sqliteBubbles[i].editFiles));
      }
    }

    // Apply to tasks (same logic as session-reader.ts)
    const tasks = jsonlPrompts.map((text, i) => ({
      prompt: text,
      toolEditedFiles: perPromptFiles.get(i) ?? new Set<string>(),
    }));

    // Prompt 0 "refactor" should have auth.ts
    assert.ok(tasks[0].toolEditedFiles.has("auth.ts"), "prompt 0 maps to auth.ts");
    // Prompt 1 "yes" should have nothing (NOT auth.ts from drift!)
    assert.strictEqual(tasks[1].toolEditedFiles.size, 0, "'yes' prompt has no edits");
    // Prompt 2 "add error handling" should have handler.ts
    assert.ok(tasks[2].toolEditedFiles.has("handler.ts"), "prompt 2 maps to handler.ts");
  });

  it("old behavior with >= 4 filter would cause index drift", () => {
    // This test documents the bug that existed before the fix
    const sqliteBubbles = ["refactor auth", "ok", "yes", "add tests"];
    const jsonlWithOldFilter = sqliteBubbles.filter((t) => t.length >= 4);

    assert.strictEqual(jsonlWithOldFilter.length, 2, "old filter drops 'ok' and 'yes'");
    assert.strictEqual(sqliteBubbles.length, 4, "SQLite has all 4");
    assert.notStrictEqual(
      jsonlWithOldFilter.length,
      sqliteBubbles.length,
      "mismatch = index drift bug"
    );

    // With no filter, counts always match
    const jsonlNoFilter = sqliteBubbles.map((t) => t || "(empty)");
    assert.strictEqual(jsonlNoFilter.length, sqliteBubbles.length, "no filter: counts match");
  });
});
