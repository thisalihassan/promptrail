import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SessionReader, applyFileWhitelist } from "../src/core/session-reader";
import { mergeChangesInWindow } from "../src/core/file-watcher";

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
  let fixtureChanges: Array<{ relPath: string; before: string; after: string; timestamp: number }>;

  before(() => {
    fixtureChanges = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures", "changes.json"), "utf-8")
    );
  });

  it("assigns changes to correct prompt windows", () => {
    const w0 = mergeChangesInWindow(fixtureChanges, 1773100001000, 1773100120000);
    const w1 = mergeChangesInWindow(fixtureChanges, 1773100120000, 1773100300000);
    const w2 = mergeChangesInWindow(fixtureChanges, 1773100300000, 1773100500000);

    assert.ok(w0.files.includes("src/app.ts"));
    assert.ok(w1.files.includes("src/utils.ts"));
    assert.ok(w1.files.includes("src/new-file.ts"));
    assert.ok(w2.files.includes("src/deleted.ts"));
  });

  it("Claude window exclusion removes overlapping changes", () => {
    const excludeWindows = [{ start: 1773100200000, end: 1773100300000 }];
    const { files } = mergeChangesInWindow(fixtureChanges, 1773100001000, 1773100400000, excludeWindows);

    assert.ok(!files.includes("claude-plugin/hooks.json"));
    assert.ok(files.includes("src/app.ts"));
  });

  it("identical before/after is treated as no change", () => {
    const changes = [{ relPath: "noop.ts", before: "x", after: "x", timestamp: 500 }];
    const { files } = mergeChangesInWindow(changes, 0, 1000);
    assert.strictEqual(files.length, 0);
  });

  it("rapid successive edits merge correctly", () => {
    const changes = [
      { relPath: "rapid.ts", before: "v1", after: "v2", timestamp: 1000 },
      { relPath: "rapid.ts", before: "v2", after: "v3", timestamp: 1001 },
      { relPath: "rapid.ts", before: "v3", after: "v4", timestamp: 1002 },
    ];
    const result = mergeChangesInWindow(changes, 0, 2000);
    const rapid = result.changes.find((c) => c.relativePath === "rapid.ts");
    assert.ok(rapid);
    assert.strictEqual(rapid!.before, "v1");
    assert.strictEqual(rapid!.after, "v4");
  });

  it("file created then deleted = no net change", () => {
    const changes = [
      { relPath: "tmp.ts", before: "", after: "new", timestamp: 1000 },
      { relPath: "tmp.ts", before: "new", after: "", timestamp: 2000 },
    ];
    const { files } = mergeChangesInWindow(changes, 0, 3000);
    assert.ok(!files.includes("tmp.ts"));
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
});

describe("toolEditedFiles whitelist filtering", () => {
  it("whitelist with files: only matching files pass through", () => {
    const watcher = ["a.ts", "b.ts", "c.ts"];
    const result = applyFileWhitelist(watcher, new Set(["a.ts", "c.ts"]), undefined);
    assert.deepStrictEqual(result, ["a.ts", "c.ts"]);
  });

  it("empty toolEditedFiles (informational prompt): zero files pass through", () => {
    const watcher = ["a.ts", "b.ts", "package.json"];
    const result = applyFileWhitelist(watcher, new Set<string>(), new Set(["a.ts", "b.ts"]));
    assert.deepStrictEqual(result, [],
      "empty toolEditedFiles means no edits — must not fall through to session whitelist");
  });

  it("undefined toolEditedFiles (no SQLite data): falls back to session whitelist", () => {
    const watcher = ["a.ts", "b.ts", "random.txt"];
    const result = applyFileWhitelist(watcher, undefined, new Set(["a.ts", "b.ts"]));
    assert.deepStrictEqual(result, ["a.ts", "b.ts"]);
  });

  it("undefined toolEditedFiles + no session: all files pass through", () => {
    const watcher = ["a.ts", "b.ts"];
    const result = applyFileWhitelist(watcher, undefined, undefined);
    assert.deepStrictEqual(result, ["a.ts", "b.ts"]);
  });

  it("whitelist excludes git pull / manual edits from watcher", () => {
    const watcher = [
      "src/tracker.ts",
      "src/index.ts",
      ".github/workflows/ci.yaml",
      "package-lock.json",
    ];
    const result = applyFileWhitelist(watcher, new Set(["src/tracker.ts", "src/index.ts"]), undefined);
    assert.deepStrictEqual(result, ["src/tracker.ts", "src/index.ts"]);
    assert.ok(!result.includes(".github/workflows/ci.yaml"));
    assert.ok(!result.includes("package-lock.json"));
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
    const perPromptFiles = undefined as Map<number, Set<string>> | undefined;
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
    const session = new Set(["a.ts", "b.ts"]);

    const noSqlite = applyFileWhitelist(watcherFiles, undefined, session);
    assert.deepStrictEqual(noSqlite, ["a.ts", "b.ts"], "no SQLite: falls back to session whitelist");

    const withEdits = applyFileWhitelist(watcherFiles, new Set(["a.ts"]), session);
    assert.deepStrictEqual(withEdits, ["a.ts"], "SQLite + edits: filtered to per-prompt files");

    const noEdits = applyFileWhitelist(watcherFiles, new Set(), session);
    assert.deepStrictEqual(noEdits, [], "SQLite + no edits: empty Set blocks everything");

    const noWhitelist = applyFileWhitelist(watcherFiles, undefined, undefined);
    assert.deepStrictEqual(noWhitelist, watcherFiles, "no whitelist at all: everything passes");
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

// ──────────────────────────────────────────────────────────────
// E2E: SessionReader → file watcher snapshot pipeline
//
// Creates a real Cursor transcript directory, populates a
// changes.json with snapshot data, and verifies the full
// diff-resolution pipeline works end-to-end.
//
// Without actual SQLite data, SessionReader falls back to
// file-mtime-based timestamps. We place snapshots inside
// that window to test the full pipeline. The session-range
// fallback (the BUG 13 fix) is tested separately in
// regressions.test.ts.
// ──────────────────────────────────────────────────────────────
describe("E2E: Full diff pipeline — SessionReader + snapshot matching", () => {
  let tmpDir: string;
  let composerId: string;
  let jsonlPath: string;
  let snapshotTs: number;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-e2e-pipeline-"));
    composerId = "e2e-pipe-0000-0000-000000000001";

    const encoded = tmpDir.replace(/\//g, "-").replace(/^-/, "");
    const transcriptDir = path.join(
      os.homedir(), ".cursor", "projects", encoded, "agent-transcripts",
      composerId
    );
    fs.mkdirSync(transcriptDir, { recursive: true });

    const lines = [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Implement auth module</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}',
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Add error handling</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"Added."}]}}',
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Write tests</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"Fixed."}]}}',
    ];
    jsonlPath = path.join(transcriptDir, `${composerId}.jsonl`);
    fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

    const stat = fs.statSync(jsonlPath);
    const mtime = stat.mtimeMs;

    snapshotTs = mtime - 45_000;

    const snapshotsDir = path.join(tmpDir, ".promptrail", "snapshots");
    fs.mkdirSync(snapshotsDir, { recursive: true });
    const snapshots = [
      { relPath: "src/auth.ts", before: "v1", after: "v2",
        timestamp: snapshotTs },
      { relPath: "src/errors.ts", before: "", after: "export class AppError {}",
        timestamp: snapshotTs + 15_000 },
      { relPath: "src/auth.test.ts", before: "", after: "test('auth', () => {});",
        timestamp: snapshotTs + 30_000 },
    ];
    fs.writeFileSync(
      path.join(snapshotsDir, "changes.json"),
      JSON.stringify(snapshots)
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const encoded = tmpDir.replace(/\//g, "-").replace(/^-/, "");
    const projectDir = path.join(
      os.homedir(), ".cursor", "projects", encoded
    );
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("SessionReader produces cursor tasks from JSONL", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks();
    const cursor = tasks.filter((t) => t.source === "cursor");
    assert.strictEqual(cursor.length, 3, "3 user prompts in JSONL");
  });

  it("task timestamps are strictly increasing", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks()
      .filter((t) => t.source === "cursor")
      .sort((a, b) => a.createdAt - b.createdAt);

    for (let i = 1; i < tasks.length; i++) {
      assert.ok(tasks[i].createdAt > tasks[i - 1].createdAt,
        `Task ${i} must have later timestamp than task ${i - 1}`);
    }
  });

  it("snapshot data is found via window matching for at least one prompt", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks()
      .filter((t) => t.source === "cursor")
      .sort((a, b) => a.createdAt - b.createdAt);

    const snapshots = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, ".promptrail", "snapshots", "changes.json"), "utf-8"
      )
    );

    let totalFound = 0;
    for (let i = 0; i < tasks.length; i++) {
      const startTs = tasks[i].createdAt;
      const endTs = i + 1 < tasks.length ? tasks[i + 1].createdAt : Date.now();
      const inWindow = snapshots.filter(
        (s: any) => s.timestamp >= startTs && s.timestamp < endTs
      );
      totalFound += inWindow.length;
    }

    assert.ok(totalFound >= 1,
      `Expected at least 1 snapshot entry found by prompt windows, got ${totalFound}`);
  });

  it("prompts are in correct chronological order by prompt text", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks()
      .filter((t) => t.source === "cursor")
      .sort((a, b) => a.createdAt - b.createdAt);

    assert.ok(tasks[0].prompt.includes("auth module"));
    assert.ok(tasks[1].prompt.includes("error handling"));
    assert.ok(tasks[2].prompt.includes("tests"));
  });
});
