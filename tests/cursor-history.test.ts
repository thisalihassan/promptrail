import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { toEpochMs, CursorHistory } from "../src/core/cursor-history";
import {
  createMockDb,
  COMPOSER_ID,
  BASE_TIME,
} from "./fixtures/create-mock-db";

describe("toEpochMs", () => {
  it("returns number directly if positive", () => {
    assert.strictEqual(toEpochMs(1773100000000), 1773100000000);
  });

  it("returns 0 for zero", () => {
    assert.strictEqual(toEpochMs(0), 0);
  });

  it("returns 0 for negative numbers", () => {
    assert.strictEqual(toEpochMs(-1), 0);
  });

  it("converts numeric string to number", () => {
    assert.strictEqual(toEpochMs("1773100000000"), 1773100000000);
  });

  it("converts ISO date string to epoch ms", () => {
    const ts = toEpochMs("2026-03-10T10:00:00.000Z");
    assert.strictEqual(ts, new Date("2026-03-10T10:00:00.000Z").getTime());
  });

  it("returns 0 for null", () => {
    assert.strictEqual(toEpochMs(null), 0);
  });

  it("returns 0 for undefined", () => {
    assert.strictEqual(toEpochMs(undefined), 0);
  });

  it("returns 0 for empty string", () => {
    assert.strictEqual(toEpochMs(""), 0);
  });

  it("returns 0 for garbage string", () => {
    assert.strictEqual(toEpochMs("not-a-date"), 0);
  });

  it("returns 0 for boolean", () => {
    assert.strictEqual(toEpochMs(true), 0);
  });

  it("returns 0 for object", () => {
    assert.strictEqual(toEpochMs({}), 0);
  });

  it("handles BigInt-like numeric strings", () => {
    const result = toEpochMs("1773151585059");
    assert.strictEqual(result, 1773151585059);
  });
});

describe("CursorHistory with mock DB", () => {
  let tmpDir: string;
  let dbPath: string;
  let history: CursorHistory;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptrail-test-"));
    dbPath = path.join(tmpDir, "state.vscdb");
    createMockDb(dbPath);

    const origGetCursorUserDir = (CursorHistory as any).prototype;
    history = new CursorHistory("/mock/workspace");
    (history as any).dbPathOverride = dbPath;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getComposerSession", () => {
    it("returns undefined for non-existent session", () => {
      const session = history.getComposerSession("non-existent-id");
      assert.strictEqual(session, undefined);
    });
  });

  describe("V0 content", () => {
    it("returns undefined for non-existent session", () => {
      const v0 = history.getV0Content("non-existent", "src/app.ts");
      assert.strictEqual(v0, undefined);
    });
  });
});
