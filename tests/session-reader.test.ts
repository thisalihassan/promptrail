import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SessionReader } from "../src/core/session-reader";

describe("SessionReader - Claude Code parsing", () => {
  let tmpDir: string;
  let claudeDir: string;
  let reader: SessionReader;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-claude-"));
    const encoded = tmpDir.replace(/\//g, "-");
    claudeDir = path.join(os.homedir(), ".claude", "projects", encoded);
    fs.mkdirSync(claudeDir, { recursive: true });

    const fixture = fs.readFileSync(
      path.join(__dirname, "fixtures", "claude-session.jsonl"),
      "utf-8"
    );
    fs.writeFileSync(path.join(claudeDir, "session-abc12345.jsonl"), fixture);

    reader = new SessionReader(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("extracts prompts from Claude JSONL", () => {
    const tasks = reader.readAllTasks();
    const claudeTasks = tasks.filter((t) => t.source === "claude");
    assert.ok(claudeTasks.length >= 3, `Expected >= 3 Claude tasks, got ${claudeTasks.length}`);
  });

  it("extracts file changes from tool_use blocks", () => {
    const tasks = reader.readAllTasks();
    const claudeTasks = tasks.filter((t) => t.source === "claude");
    const firstTask = claudeTasks.find((t) => t.prompt.includes("error handling"));
    assert.ok(firstTask, "Should find the error handling task");
    assert.ok(firstTask!.filesChanged.length >= 1, "Should have file changes");
  });

  it("captures Edit operations with old_string/new_string", () => {
    const tasks = reader.readAllTasks() as any[];
    const editTask = tasks.find((t: any) => t.edits && t.edits.length > 0);
    assert.ok(editTask, "Should have a task with edits");
    assert.ok(editTask.edits[0].oldString.includes("function login"));
    assert.ok(editTask.edits[0].newString.includes("function login"));
  });

  it("captures Write operations with content", () => {
    const tasks = reader.readAllTasks() as any[];
    const writeTask = tasks.find((t: any) => t.writes && t.writes.length > 0);
    assert.ok(writeTask, "Should have a task with writes");
    assert.ok(writeTask.writes[0].content.includes("AuthError"));
  });

  it("informational prompts have no file changes", () => {
    const tasks = reader.readAllTasks();
    const infoTask = tasks.find((t) => t.prompt.includes("rate limiter do"));
    assert.ok(infoTask, "Should find the info task");
    assert.strictEqual(infoTask!.filesChanged.length, 0);
  });

  it("tasks are in chronological order", () => {
    const tasks = reader.readAllTasks();
    const claudeTasks = tasks
      .filter((t) => t.source === "claude")
      .sort((a, b) => a.createdAt - b.createdAt);
    if (claudeTasks.length >= 2) {
      assert.ok(claudeTasks[0].createdAt < claudeTasks[1].createdAt);
    }
  });

  it("task IDs follow cc-<session>-<index> format", () => {
    const tasks = reader.readAllTasks();
    const claudeTasks = tasks.filter((t) => t.source === "claude");
    for (const t of claudeTasks) {
      assert.match(t.id, /^cc-[a-z0-9-]+-\d+$/, `Invalid ID: ${t.id}`);
    }
  });
});

describe("SessionReader - Cursor prompt extraction", () => {
  let tmpDir: string;
  let cursorDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-cur-"));
    const encoded = tmpDir.replace(/\//g, "-").replace(/^-/, "");
    cursorDir = path.join(
      os.homedir(), ".cursor", "projects", encoded,
      "agent-transcripts", "test-cursor-session"
    );
    fs.mkdirSync(cursorDir, { recursive: true });

    const fixture = fs.readFileSync(
      path.join(__dirname, "fixtures", "cursor-session.jsonl"),
      "utf-8"
    );
    fs.writeFileSync(path.join(cursorDir, "test-cursor-session.jsonl"), fixture);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(path.dirname(cursorDir)), { recursive: true, force: true });
  });

  it("extracts prompts from <user_query> tags", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks();
    const cursorTasks = tasks.filter((t) => t.source === "cursor");
    assert.ok(cursorTasks.length >= 3, `Expected >= 3, got ${cursorTasks.length}`);
    const prompts = cursorTasks.map((t) => t.prompt);
    assert.ok(prompts.some((p) => p.includes("connection pooling")));
    assert.ok(prompts.some((p) => p.includes("unit tests")));
  });

  it("skips system_reminder content from prompts", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks();
    const cursorTasks = tasks.filter((t) => t.source === "cursor");
    const hasSystemReminder = cursorTasks.some(
      (t) => t.prompt.includes("system_reminder") || t.prompt.includes("Plan mode")
    );
    assert.strictEqual(hasSystemReminder, false);
  });

  it("never skips user messages (index must match SQLite bubble count)", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks();
    const cursorTasks = tasks.filter((t) => t.source === "cursor");
    const hasOk = cursorTasks.some((t) => t.prompt === "ok");
    assert.strictEqual(hasOk, true, "short prompts like 'ok' must be included");
  });

  it("task IDs follow cur-<session>-<index> format", () => {
    const reader = new SessionReader(tmpDir);
    const tasks = reader.readAllTasks();
    const cursorTasks = tasks.filter((t) => t.source === "cursor");
    for (const t of cursorTasks) {
      assert.match(t.id, /^cur-[a-z0-9-]+-\d+$/, `Invalid ID: ${t.id}`);
    }
  });
});
