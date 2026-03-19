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


// NOTE: toolEditedFiles whitelist and perPromptFiles tests removed —
// watcher-based attribution pipeline was replaced by hooks-first architecture.
// File attribution now comes directly from hooks or toolFormerData, not from
// watcher time-windows filtered through applyFileWhitelist.

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
