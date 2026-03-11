import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  diffLines,
  computeHunks,
  applyReverseHunks,
  selectiveRevert,
  revertStringEdits,
} from "../src/core/selective-revert";

// ── diffLines ────────────────────────────────────────────────

describe("diffLines", () => {
  it("handles identical content", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "b", "c"]);
    assert.ok(ops.every((op) => op.type === "keep"));
    assert.strictEqual(ops.length, 3);
  });

  it("detects pure insertions", () => {
    const ops = diffLines(["a", "c"], ["a", "b", "c"]);
    const inserts = ops.filter((op) => op.type === "insert");
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].line, "b");
  });

  it("detects pure deletions", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "c"]);
    const deletes = ops.filter((op) => op.type === "delete");
    assert.strictEqual(deletes.length, 1);
    assert.strictEqual(deletes[0].line, "b");
  });

  it("detects replacements", () => {
    const ops = diffLines(["a", "OLD", "c"], ["a", "NEW", "c"]);
    const deletes = ops.filter((op) => op.type === "delete");
    const inserts = ops.filter((op) => op.type === "insert");
    assert.strictEqual(deletes.length, 1);
    assert.strictEqual(deletes[0].line, "OLD");
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].line, "NEW");
  });

  it("handles empty before", () => {
    const ops = diffLines([], ["a", "b"]);
    assert.strictEqual(ops.length, 2);
    assert.ok(ops.every((op) => op.type === "insert"));
  });

  it("handles empty after", () => {
    const ops = diffLines(["a", "b"], []);
    assert.strictEqual(ops.length, 2);
    assert.ok(ops.every((op) => op.type === "delete"));
  });
});

// ── computeHunks ─────────────────────────────────────────────

describe("computeHunks", () => {
  it("produces no hunks for identical content", () => {
    const hunks = computeHunks("a\nb\nc", "a\nb\nc");
    assert.strictEqual(hunks.length, 0);
  });

  it("produces one hunk for a single-line change", () => {
    const hunks = computeHunks("a\nOLD\nc", "a\nNEW\nc");
    assert.strictEqual(hunks.length, 1);
    assert.deepStrictEqual(hunks[0].beforeLines, ["OLD"]);
    assert.deepStrictEqual(hunks[0].afterLines, ["NEW"]);
  });

  it("captures context lines", () => {
    const before = "1\n2\n3\nOLD\n5\n6\n7";
    const after = "1\n2\n3\nNEW\n5\n6\n7";
    const hunks = computeHunks(before, after, 2);
    assert.strictEqual(hunks.length, 1);
    assert.deepStrictEqual(hunks[0].contextBefore, ["2", "3"]);
    assert.deepStrictEqual(hunks[0].contextAfter, ["5", "6"]);
  });

  it("produces separate hunks for distant changes", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i}`);
    before[3] = "OLD1";
    before[16] = "OLD2";
    const after = [...before];
    after[3] = "NEW1";
    after[16] = "NEW2";

    const hunks = computeHunks(before.join("\n"), after.join("\n"), 2);
    assert.strictEqual(hunks.length, 2);
  });
});

// ── selectiveRevert — core scenarios ─────────────────────────

describe("selectiveRevert", () => {
  it("no-op when before === after", () => {
    const result = selectiveRevert("same", "same", "current");
    assert.strictEqual(result.content, "current");
    assert.strictEqual(result.applied, 0);
  });

  it("fast path: current === after → restore before", () => {
    const result = selectiveRevert("before", "after", "after");
    assert.strictEqual(result.content, "before");
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(result.conflicts.length, 0);
  });

  it("reverts a middle prompt without affecting later changes (the feature request scenario)", () => {
    // Prompt 1-3 left the file as "state3"
    // Prompt 4 changed line 5 from "original" to "prompt4_change"
    // Prompt 5 changed line 10 from "another" to "prompt5_change"
    // Reverting prompt 4 should undo line 5 but keep line 10

    const lines = Array.from({ length: 15 }, (_, i) => `line${i}`);

    const beforePrompt4 = [...lines];
    beforePrompt4[5] = "original";
    beforePrompt4[10] = "another";

    const afterPrompt4 = [...beforePrompt4];
    afterPrompt4[5] = "prompt4_change";

    const afterPrompt5 = [...afterPrompt4];
    afterPrompt5[10] = "prompt5_change";

    const result = selectiveRevert(
      beforePrompt4.join("\n"),
      afterPrompt4.join("\n"),
      afterPrompt5.join("\n")
    );

    const resultLines = result.content.split("\n");
    assert.strictEqual(resultLines[5], "original", "prompt 4 change should be reverted");
    assert.strictEqual(resultLines[10], "prompt5_change", "prompt 5 change should be preserved");
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(result.conflicts.length, 0);
  });

  it("reverts additions in a middle prompt", () => {
    const before = "line1\nline2\nline3";
    const after = "line1\nline2\nADDED_BY_PROMPT4\nline3";
    const current = "line1\nline2\nADDED_BY_PROMPT4\nline3\nADDED_BY_PROMPT5";

    const result = selectiveRevert(before, after, current);
    assert.strictEqual(result.content, "line1\nline2\nline3\nADDED_BY_PROMPT5");
    assert.strictEqual(result.conflicts.length, 0);
  });

  it("reverts deletions in a middle prompt", () => {
    const before = "line1\nDELETED_LINE\nline3";
    const after = "line1\nline3";
    const current = "line1\nline3\nADDED_LATER";

    const result = selectiveRevert(before, after, current);
    assert.strictEqual(result.content, "line1\nDELETED_LINE\nline3\nADDED_LATER");
    assert.strictEqual(result.conflicts.length, 0);
  });

  it("reverts multi-line replacement in a middle prompt", () => {
    const before = "header\nold_line1\nold_line2\nfooter";
    const after = "header\nnew_line1\nnew_line2\nnew_line3\nfooter";
    const current = "header\nnew_line1\nnew_line2\nnew_line3\nfooter\nextra";

    const result = selectiveRevert(before, after, current);
    assert.strictEqual(result.content, "header\nold_line1\nold_line2\nfooter\nextra");
    assert.strictEqual(result.conflicts.length, 0);
  });

  it("reports conflict when later prompt modified the same lines", () => {
    const before = "line1\nORIGINAL\nline3";
    const after = "line1\nCHANGED_BY_4\nline3";
    // Prompt 5 changed the same line again
    const current = "line1\nCHANGED_BY_5\nline3";

    const result = selectiveRevert(before, after, current);
    assert.ok(result.conflicts.length > 0, "should report a conflict");
  });

  it("handles multiple independent hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);

    const before = [...lines];
    const after = [...lines];
    after[2] = "changed_top";
    after[17] = "changed_bottom";

    const current = [...after];
    current[10] = "later_middle_change";

    const result = selectiveRevert(
      before.join("\n"),
      after.join("\n"),
      current.join("\n")
    );

    const resultLines = result.content.split("\n");
    assert.strictEqual(resultLines[2], "line2", "top change reverted");
    assert.strictEqual(resultLines[17], "line17", "bottom change reverted");
    assert.strictEqual(resultLines[10], "later_middle_change", "middle change preserved");
    assert.strictEqual(result.applied, 2);
  });

  it("handles reverting when prompt added lines at the very end", () => {
    const before = "line1\nline2";
    const after = "line1\nline2\nadded";
    const current = "line1\nline2\nadded";

    const result = selectiveRevert(before, after, current);
    assert.strictEqual(result.content, "line1\nline2");
    assert.strictEqual(result.conflicts.length, 0);
  });

  it("handles reverting when prompt added lines at the very beginning", () => {
    const before = "line1\nline2";
    const after = "added\nline1\nline2";
    const current = "added\nline1\nline2\nextra";

    const result = selectiveRevert(before, after, current);
    assert.strictEqual(result.content, "line1\nline2\nextra");
    assert.strictEqual(result.conflicts.length, 0);
  });
});

// ── revertStringEdits (Claude) ───────────────────────────────

describe("revertStringEdits", () => {
  it("reverts a single string replacement", () => {
    const current = "function bar() { return 1; }";
    const edits = [{ oldString: "foo", newString: "bar" }];

    const result = revertStringEdits(current, edits);
    assert.strictEqual(result.content, "function foo() { return 1; }");
    assert.strictEqual(result.applied, 1);
  });

  it("reverts multiple edits in the same file", () => {
    const current = "import { b } from 'mod';\nconsole.log(b);";
    const edits = [
      { oldString: "a", newString: "b" },
      { oldString: "a", newString: "b" },
    ];

    const result = revertStringEdits(current, edits);
    // Both 'b' should be reverted to 'a' (processed in reverse order)
    assert.strictEqual(result.content, "import { a } from 'mod';\nconsole.log(a);");
    assert.strictEqual(result.applied, 2);
  });

  it("reports conflict when newString not found in current", () => {
    const current = "completely different content";
    const edits = [{ oldString: "foo", newString: "bar" }];

    const result = revertStringEdits(current, edits);
    assert.strictEqual(result.applied, 0);
    assert.strictEqual(result.conflicts.length, 1);
  });

  it("handles partial conflicts (some edits succeed, others conflict)", () => {
    const current = "hello world bar";
    const edits = [
      { oldString: "foo", newString: "bar" },
      { oldString: "baz", newString: "qux" },
    ];

    const result = revertStringEdits(current, edits);
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(result.conflicts.length, 1);
    assert.ok(result.content.includes("foo"));
  });
});

// ── Real-world simulation ────────────────────────────────────

describe("real-world selective revert", () => {
  it("5-prompt scenario: revert prompt 4 preserving 1-3 and 5", () => {
    // Simulating a real coding session
    const v0 = [
      "import React from 'react';",
      "",
      "function App() {",
      "  return <div>Hello</div>;",
      "}",
      "",
      "export default App;",
    ].join("\n");

    // After prompt 1-3: added state and a button
    const v3 = [
      "import React, { useState } from 'react';",
      "",
      "function App() {",
      "  const [count, setCount] = useState(0);",
      "  return (",
      "    <div>",
      "      <h1>Counter: {count}</h1>",
      "      <button onClick={() => setCount(count + 1)}>+</button>",
      "    </div>",
      "  );",
      "}",
      "",
      "export default App;",
    ].join("\n");

    // After prompt 4: added a reset button (THIS is what we want to revert)
    const v4 = [
      "import React, { useState } from 'react';",
      "",
      "function App() {",
      "  const [count, setCount] = useState(0);",
      "  return (",
      "    <div>",
      "      <h1>Counter: {count}</h1>",
      "      <button onClick={() => setCount(count + 1)}>+</button>",
      "      <button onClick={() => setCount(0)}>Reset</button>",
      "    </div>",
      "  );",
      "}",
      "",
      "export default App;",
    ].join("\n");

    // After prompt 5: added styling
    const v5 = [
      "import React, { useState } from 'react';",
      "import './App.css';",
      "",
      "function App() {",
      "  const [count, setCount] = useState(0);",
      "  return (",
      "    <div className=\"app\">",
      "      <h1>Counter: {count}</h1>",
      "      <button onClick={() => setCount(count + 1)}>+</button>",
      "      <button onClick={() => setCount(0)}>Reset</button>",
      "    </div>",
      "  );",
      "}",
      "",
      "export default App;",
    ].join("\n");

    // Selectively revert prompt 4 (v3 → v4) from current state v5
    const result = selectiveRevert(v3, v4, v5);

    assert.strictEqual(result.conflicts.length, 0, "no conflicts expected");
    assert.ok(result.applied > 0, "should have applied hunks");

    // The reset button (prompt 4) should be gone
    assert.ok(!result.content.includes("Reset"), "Reset button should be removed");
    // The import (prompt 5) should remain
    assert.ok(result.content.includes("import './App.css'"), "prompt 5 import preserved");
    // The className (prompt 5) should remain
    assert.ok(result.content.includes('className="app"'), "prompt 5 className preserved");
    // The counter logic (prompts 1-3) should remain
    assert.ok(result.content.includes("useState"), "useState preserved");
    assert.ok(result.content.includes("setCount(count + 1)"), "increment button preserved");
  });
});
