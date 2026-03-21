/**
 * End-to-end tests for the full Promptrail pipeline.
 *
 * These tests create real workspace directories with real files,
 * JSONL transcripts, and snapshot data, then run the actual Tracker
 * class through getTasks() → getTaskChangeset() → rollbackToTask().
 *
 * The vscode mock (via esbuild alias) stubs FileSystemWatcher so
 * FileWatcher won't actively watch, but it DOES load changes.json
 * from disk — which is exactly what happens in production when the
 * extension restarts.
 */
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Tracker } from "../src/core/tracker";

// ──────────────────────────────────────────────────────────────
// E2E: Claude Code — full pipeline
//
// Creates a workspace with:
//   - Claude JSONL session (3 prompts: edit, edit+write, informational)
//   - Real files on disk matching the JSONL edits
//
// Tests:
//   1. getTasks() returns correct prompts with correct filesChanged
//   2. getTaskChangeset() returns correct diffs
//   3. rollbackToTask() actually reverts files on disk
// ──────────────────────────────────────────────────────────────
describe("E2E: Claude Code full pipeline", () => {
  let wsRoot: string;
  let claudeDir: string;
  let tracker: Tracker;

  before(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-e2e-claude-"));

    // Create the source files as they would exist AFTER the AI made changes
    fs.mkdirSync(path.join(wsRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(wsRoot, "src", "auth.ts"),
      "const limiter = new RateLimiter(5, '1m');\n\nfunction login(user) {\n  limiter.check(user.ip);\n  try {\n    return db.query(user);\n  } catch (err) {\n    throw new AuthError(err);\n  }"
    );
    fs.writeFileSync(
      path.join(wsRoot, "src", "errors.ts"),
      "export class AuthError extends Error {\n  constructor(cause: unknown) {\n    super('Authentication failed');\n    this.cause = cause;\n  }\n}\n"
    );

    // Claude session JSONL
    const encoded = wsRoot.replace(/\//g, "-");
    claudeDir = path.join(os.homedir(), ".claude", "projects", encoded);
    fs.mkdirSync(claudeDir, { recursive: true });

    const jsonl = [
      '{"type":"user","message":{"content":[{"type":"text","text":"Add error handling to the login function"}]},"timestamp":"2026-03-10T10:00:00.000Z"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Adding try-catch."},{"type":"tool_use","name":"Edit","input":{"file_path":"' + wsRoot + '/src/auth.ts","old_string":"function login(user) {\\n  return db.query(user);","new_string":"function login(user) {\\n  try {\\n    return db.query(user);\\n  } catch (err) {\\n    throw new AuthError(err);\\n  }"}},{"type":"tool_use","name":"Write","input":{"file_path":"' + wsRoot + '/src/errors.ts","content":"export class AuthError extends Error {\\n  constructor(cause: unknown) {\\n    super(\'Authentication failed\');\\n    this.cause = cause;\\n  }\\n}\\n"}}]}}',
      '{"type":"user","message":{"content":[{"type":"text","text":"Now add rate limiting"}]},"timestamp":"2026-03-10T10:05:00.000Z"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"' + wsRoot + '/src/auth.ts","old_string":"function login(user) {","new_string":"const limiter = new RateLimiter(5, \'1m\');\\n\\nfunction login(user) {\\n  limiter.check(user.ip);"}}]}}',
      '{"type":"user","message":{"content":[{"type":"text","text":"What does the rate limiter do?"}]},"timestamp":"2026-03-10T10:10:00.000Z"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"It restricts login attempts to 5 per minute per IP."}]}}',
    ];
    fs.writeFileSync(
      path.join(claudeDir, "e2e-session-001.jsonl"),
      jsonl.join("\n") + "\n"
    );

    tracker = new Tracker(wsRoot);
  });

  after(() => {
    tracker.dispose();
    fs.rmSync(wsRoot, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("getTasks() returns 3 Claude prompts", () => {
    const tasks = tracker.getTasks();
    const claude = tasks.filter((t) => t.source === "claude");
    assert.strictEqual(claude.length, 3, `Expected 3 Claude tasks, got ${claude.length}`);
  });

  it("prompt 1 (error handling) has auth.ts and errors.ts in filesChanged", () => {
    const tasks = tracker.getTasks();
    const claude = tasks
      .filter((t) => t.source === "claude")
      .sort((a, b) => a.createdAt - b.createdAt);
    const prompt1 = claude[0];

    assert.ok(prompt1.prompt.includes("error handling"));
    assert.ok(prompt1.filesChanged.some((f) => f.includes("auth.ts")),
      `Expected auth.ts in filesChanged, got: ${prompt1.filesChanged}`);
    assert.ok(prompt1.filesChanged.some((f) => f.includes("errors.ts")),
      `Expected errors.ts in filesChanged, got: ${prompt1.filesChanged}`);
  });

  it("prompt 2 (rate limiting) has auth.ts in filesChanged", () => {
    const tasks = tracker.getTasks();
    const claude = tasks
      .filter((t) => t.source === "claude")
      .sort((a, b) => a.createdAt - b.createdAt);
    const prompt2 = claude[1];

    assert.ok(prompt2.prompt.includes("rate limiting"));
    assert.ok(prompt2.filesChanged.some((f) => f.includes("auth.ts")));
  });

  it("prompt 3 (informational) has no filesChanged", () => {
    const tasks = tracker.getTasks();
    const claude = tasks
      .filter((t) => t.source === "claude")
      .sort((a, b) => a.createdAt - b.createdAt);
    const prompt3 = claude[2];

    assert.ok(prompt3.prompt.includes("rate limiter"));
    assert.strictEqual(prompt3.filesChanged.length, 0);
  });

  it("getTaskChangeset() returns diffs for prompt 1", () => {
    const tasks = tracker.getTasks();
    const claude = tasks
      .filter((t) => t.source === "claude")
      .sort((a, b) => a.createdAt - b.createdAt);

    const changeset = tracker.getTaskChangeset(claude[0].id);
    assert.ok(changeset, "Should have changeset for edit prompt");
    assert.ok(changeset!.changes.length >= 1, "Should have at least 1 file change");

    const authChange = changeset!.changes.find((c) => c.relativePath.includes("auth.ts"));
    assert.ok(authChange, "Should have auth.ts change");
    assert.ok(authChange!.before!.includes("return db.query(user);"));
    assert.ok(authChange!.after!.includes("throw new AuthError(err);"));
  });

  it("getTaskChangeset() returns undefined for informational prompt", () => {
    const tasks = tracker.getTasks();
    const claude = tasks
      .filter((t) => t.source === "claude")
      .sort((a, b) => a.createdAt - b.createdAt);

    const changeset = tracker.getTaskChangeset(claude[2].id);
    assert.strictEqual(changeset, undefined);
  });

  it("rollbackToTask() reverts prompt 2 (rate limiting) on disk", async () => {
    const tasks = tracker.getTasks();
    const claude = tasks
      .filter((t) => t.source === "claude")
      .sort((a, b) => a.createdAt - b.createdAt);

    const authBefore = fs.readFileSync(path.join(wsRoot, "src", "auth.ts"), "utf-8");
    assert.ok(authBefore.includes("RateLimiter"), "File should have rate limiter before rollback");

    const result = await tracker.rollbackToTask(claude[1].id);
    assert.ok(result.success, `Rollback should succeed, got: ${JSON.stringify(result)}`);
    assert.ok(result.filesReverted.length > 0, "Should revert at least 1 file");

    const authAfter = fs.readFileSync(path.join(wsRoot, "src", "auth.ts"), "utf-8");
    assert.ok(!authAfter.includes("RateLimiter"),
      "Rate limiter should be removed after rollback");
    assert.ok(authAfter.includes("throw new AuthError"),
      "Prompt 1's error handling should be preserved");
  });
});

// ──────────────────────────────────────────────────────────────
// E2E: Cursor JSONL — without hooks or SQLite, file attribution
// comes only from toolFormerData/firstEditBubbleId. Pure JSONL
// sessions (no hooks, no SQLite) have empty filesChanged since
// the watcher-based attribution pipeline was removed.
//
// This documents the expected behavior: to get file attribution
// for Cursor sessions, hooks must be installed (`promptrail init`).
// ──────────────────────────────────────────────────────────────
describe("E2E: Cursor JSONL-only pipeline (no hooks)", () => {
  let wsRoot: string;
  let transcriptDir: string;
  let tracker: Tracker;
  const composerId = "e2e-cursor-aaaa-bbbb-cccccccccccc";

  before(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-e2e-cursor-"));

    const encoded = wsRoot.replace(/\//g, "-").replace(/^-/, "");
    transcriptDir = path.join(
      os.homedir(), ".cursor", "projects", encoded,
      "agent-transcripts", composerId
    );
    fs.mkdirSync(transcriptDir, { recursive: true });

    const lines = [
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Refactor the database module</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"Done refactoring."}]}}',
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>Add unit tests for the refactored code</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"Tests added."}]}}',
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>What is the test coverage now?</user_query>"}]}}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"Coverage is 85%."}]}}',
    ];
    fs.writeFileSync(
      path.join(transcriptDir, `${composerId}.jsonl`),
      lines.join("\n") + "\n"
    );

    tracker = new Tracker(wsRoot);
  });

  after(() => {
    tracker.dispose();
    fs.rmSync(wsRoot, { recursive: true, force: true });
    const encoded = wsRoot.replace(/\//g, "-").replace(/^-/, "");
    fs.rmSync(
      path.join(os.homedir(), ".cursor", "projects", encoded),
      { recursive: true, force: true }
    );
  });

  it("getTasks() returns 3 Cursor prompts", () => {
    const tasks = tracker.getTasks();
    const cursor = tasks.filter((t) => t.source === "cursor");
    assert.strictEqual(cursor.length, 3, `Expected 3 Cursor tasks, got ${cursor.length}`);
  });

  it("JSONL-only prompts have empty filesChanged (no hooks/SQLite)", () => {
    const tasks = tracker.getTasks();
    const cursor = tasks.filter((t) => t.source === "cursor");

    for (const t of cursor) {
      assert.strictEqual(t.filesChanged.length, 0,
        `JSONL-only prompt should have no file attribution, got: ${t.filesChanged}`);
    }
  });

  it("getTaskChangeset() returns undefined without edit data", () => {
    const tasks = tracker.getTasks();
    const cursor = tasks.filter((t) => t.source === "cursor");

    for (const t of cursor) {
      const changeset = tracker.getTaskChangeset(t.id);
      assert.strictEqual(changeset, undefined,
        "JSONL-only prompts have no edit data for changesets");
    }
  });
});

// ──────────────────────────────────────────────────────────────
// BUG 23: getTaskResponse returns undefined for hook-sourced Cursor tasks.
//
// Root cause: getTaskResponse parsed the taskId to extract a short
// composerId prefix (e.g. "3aa7e65b"), then called
// findComposerIdByPrefix() which queries the sessions table.
// Hook-only conversations never create a row in sessions, so
// findComposerIdByPrefix returned undefined and the method bailed
// out immediately — before ever attempting the hook_responses lookup.
//
// The task already carries sessionId (full conversationId) and
// generationId from parseCursorFromHooks. The fix resolves the hook
// response using those fields first, only falling through to the
// sessions/bubbles path for legacy SQLite-snapshotted sessions.
// ──────────────────────────────────────────────────────────────
describe("BUG 23: getTaskResponse for hook-sourced Cursor tasks", () => {
  let wsRoot: string;
  let tracker: Tracker;

  before(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-e2e-bug23-"));

    const dbPath = path.join(wsRoot, ".promptrail", "promptrail.db");
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
      .run("abcdef12-0000-0000-0000-000000000001", "gen-aaa", "fix the login bug", "claude-3-5", 1000);
    rawDb.prepare(`INSERT INTO hook_edits (conversationId, generationId, filePath, oldString, newString, timestamp) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("abcdef12-0000-0000-0000-000000000001", "gen-aaa", "src/login.ts", "return false;", "return checkCredentials(u, p);", 1100);
    rawDb.prepare(`INSERT INTO hook_responses (conversationId, generationId, responseText, model, timestamp) VALUES (?, ?, ?, ?, ?)`)
      .run("abcdef12-0000-0000-0000-000000000001", "gen-aaa", "I updated login.ts to call checkCredentials.", "claude-3-5", 1200);
    rawDb.close();

    tracker = new Tracker(wsRoot);
  });

  after(() => {
    tracker.dispose();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it("getTasks() finds the hook-sourced task", () => {
    const tasks = tracker.getTasks();
    const hook = tasks.filter((t) => t.source === "cursor");
    assert.strictEqual(hook.length, 1, "Should have 1 hook-sourced Cursor task");
    assert.ok(hook[0].prompt.includes("fix the login bug"));
  });

  it("getTaskResponse() returns the response text for a hook-sourced task", () => {
    const tasks = tracker.getTasks();
    const hookTask = tasks.find((t) => t.source === "cursor");
    assert.ok(hookTask, "hook task must exist");

    const resp = tracker.getTaskResponse(hookTask.id);
    assert.ok(resp, `getTaskResponse returned undefined for hook task ${hookTask.id}`);
    assert.ok(
      resp!.includes("checkCredentials"),
      `Response should contain the hook response text, got: ${resp}`
    );
    assert.ok(resp!.includes("fix the login bug"), "Response should echo the prompt");
  });

  it("getTaskResponse() returns undefined for a task with no response", () => {
    const tasks = tracker.getTasks();
    const hookTask = tasks.find((t) => t.source === "cursor");
    assert.ok(hookTask);

    // Invent a non-existent task ID derived from the same session
    const fakeId = hookTask.id.replace(/-\d+$/, "-99");
    const resp = tracker.getTaskResponse(fakeId);
    assert.strictEqual(resp, undefined, "Should return undefined for unknown task");
  });
});
