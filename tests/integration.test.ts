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
