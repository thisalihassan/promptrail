/**
 * Selective revert: undo a single prompt's changes without affecting
 * changes from other prompts (like `git revert` vs `git reset`).
 *
 * Two strategies:
 *   1. Line-level: LCS diff between before/after → reverse-patch current
 *   2. String-level: for Claude edits with exact old_string/new_string pairs
 */

export interface DiffHunk {
  beforeLines: string[];
  afterLines: string[];
  contextBefore: string[];
  contextAfter: string[];
}

export interface RevertResult {
  content: string;
  applied: number;
  conflicts: ConflictInfo[];
}

export interface ConflictInfo {
  hunkIndex: number;
  description: string;
  searchSnippet: string;
}

export interface RollbackResult {
  success: boolean;
  filesReverted: Array<{
    path: string;
    status: "reverted" | "deleted" | "recreated";
  }>;
  conflicts: Array<{ path: string; reason: string }>;
}

// ── LCS-based line diff ──────────────────────────────────────

type EditOp = { type: "keep" | "delete" | "insert"; line: string };

const MAX_DIFF_CELLS = 9_000_000; // ~3000×3000 lines

export function diffLines(
  beforeLines: string[],
  afterLines: string[]
): EditOp[] {
  const m = beforeLines.length;
  const n = afterLines.length;

  if (m === 0)
    return afterLines.map((l) => ({ type: "insert" as const, line: l }));
  if (n === 0)
    return beforeLines.map((l) => ({ type: "delete" as const, line: l }));

  if (m * n > MAX_DIFF_CELLS) {
    return fallbackDiff(beforeLines, afterLines);
  }

  const dp = new Int32Array((m + 1) * (n + 1));
  const w = n + 1;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        dp[i * w + j] = dp[(i - 1) * w + (j - 1)] + 1;
      } else {
        dp[i * w + j] = Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)]);
      }
    }
  }

  const ops: EditOp[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      beforeLines[i - 1] === afterLines[j - 1]
    ) {
      ops.push({ type: "keep", line: beforeLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * w + (j - 1)] >= dp[(i - 1) * w + j])) {
      ops.push({ type: "insert", line: afterLines[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", line: beforeLines[i - 1] });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Fallback for very large files: greedy forward scan.
 * Less accurate than LCS but bounded memory.
 */
function fallbackDiff(
  beforeLines: string[],
  afterLines: string[]
): EditOp[] {
  const ops: EditOp[] = [];
  let i = 0,
    j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ type: "keep", line: beforeLines[i] });
      i++;
      j++;
      continue;
    }

    let foundAhead = -1;
    for (let k = j + 1; k < Math.min(j + 8, afterLines.length); k++) {
      if (beforeLines[i] === afterLines[k]) {
        foundAhead = k;
        break;
      }
    }

    if (foundAhead >= 0) {
      for (let k = j; k < foundAhead; k++) {
        ops.push({ type: "insert", line: afterLines[k] });
      }
      j = foundAhead;
    } else {
      ops.push({ type: "delete", line: beforeLines[i] });
      ops.push({ type: "insert", line: afterLines[j] });
      i++;
      j++;
    }
  }

  while (i < beforeLines.length) {
    ops.push({ type: "delete", line: beforeLines[i++] });
  }
  while (j < afterLines.length) {
    ops.push({ type: "insert", line: afterLines[j++] });
  }

  return ops;
}

// ── Hunk grouping ────────────────────────────────────────────

export function computeHunks(
  beforeContent: string,
  afterContent: string,
  contextSize = 3
): DiffHunk[] {
  const beforeLines = beforeContent.split("\n");
  const afterLines = afterContent.split("\n");
  const ops = diffLines(beforeLines, afterLines);

  const hunks: DiffHunk[] = [];
  let idx = 0;

  while (idx < ops.length) {
    if (ops[idx].type === "keep") {
      idx++;
      continue;
    }

    // Gather context before
    const ctxBefore: string[] = [];
    let cb = idx - 1;
    while (cb >= 0 && ops[cb].type === "keep" && ctxBefore.length < contextSize) {
      ctxBefore.unshift(ops[cb].line);
      cb--;
    }

    // Gather the changed region
    const beforeL: string[] = [];
    const afterL: string[] = [];
    while (idx < ops.length && ops[idx].type !== "keep") {
      if (ops[idx].type === "delete") beforeL.push(ops[idx].line);
      else afterL.push(ops[idx].line);
      idx++;
    }

    // Check if the next hunk is close enough to merge (avoid overlapping context)
    while (idx < ops.length) {
      let keepRun = 0;
      let scan = idx;
      while (scan < ops.length && ops[scan].type === "keep") {
        keepRun++;
        scan++;
      }
      if (scan < ops.length && keepRun <= 2 * contextSize) {
        // Bridge: include the keep lines in both sides
        for (let k = idx; k < scan; k++) {
          beforeL.push(ops[k].line);
          afterL.push(ops[k].line);
        }
        idx = scan;
        while (idx < ops.length && ops[idx].type !== "keep") {
          if (ops[idx].type === "delete") beforeL.push(ops[idx].line);
          else afterL.push(ops[idx].line);
          idx++;
        }
      } else {
        break;
      }
    }

    // Gather context after
    const ctxAfter: string[] = [];
    let ca = idx;
    while (ca < ops.length && ops[ca].type === "keep" && ctxAfter.length < contextSize) {
      ctxAfter.push(ops[ca].line);
      ca++;
    }

    hunks.push({
      beforeLines: beforeL,
      afterLines: afterL,
      contextBefore: ctxBefore,
      contextAfter: ctxAfter,
    });
  }

  return hunks;
}

// ── Pattern search in current file ───────────────────────────

function findPattern(
  lines: string[],
  pattern: string[],
  startHint = 0
): number {
  if (pattern.length === 0) return -1;
  if (pattern.length > lines.length) return -1;

  // Search near the hint first, then expand outward
  const maxOffset = lines.length;
  for (let offset = 0; offset < maxOffset; offset++) {
    for (const dir of [1, -1]) {
      const start = startHint + offset * dir;
      if (start < 0 || start + pattern.length > lines.length) continue;

      let match = true;
      for (let k = 0; k < pattern.length; k++) {
        if (lines[start + k] !== pattern[k]) {
          match = false;
          break;
        }
      }
      if (match) return start;
    }
  }
  return -1;
}

// ── Apply reverse hunks ─────────────────────────────────────

export function applyReverseHunks(
  currentContent: string,
  hunks: DiffHunk[]
): RevertResult {
  if (hunks.length === 0) {
    return { content: currentContent, applied: 0, conflicts: [] };
  }

  let currentLines = currentContent.split("\n");
  let applied = 0;
  const conflicts: ConflictInfo[] = [];

  // Process hunks from bottom to top to preserve line indices
  const sortedHunks = [...hunks].reverse();

  for (let hi = 0; hi < sortedHunks.length; hi++) {
    const hunk = sortedHunks[hi];
    const originalIdx = hunks.length - 1 - hi;

    // Build search pattern: contextBefore + afterLines + contextAfter
    const fullPattern = [
      ...hunk.contextBefore,
      ...hunk.afterLines,
      ...hunk.contextAfter,
    ];

    // Estimate where the hunk should be (rough middle of file as fallback)
    const hint = Math.max(
      0,
      Math.floor(currentLines.length * ((hunks.length - 1 - hi) / hunks.length))
    );

    let matchIdx = findPattern(currentLines, fullPattern, hint);

    if (matchIdx >= 0) {
      // Replace afterLines with beforeLines, preserving context
      const replaceStart = matchIdx + hunk.contextBefore.length;
      currentLines.splice(
        replaceStart,
        hunk.afterLines.length,
        ...hunk.beforeLines
      );
      applied++;
      continue;
    }

    // Fallback: try without contextAfter
    if (hunk.contextAfter.length > 0) {
      const reducedPattern = [...hunk.contextBefore, ...hunk.afterLines];
      matchIdx = findPattern(currentLines, reducedPattern, hint);
      if (matchIdx >= 0) {
        const replaceStart = matchIdx + hunk.contextBefore.length;
        currentLines.splice(
          replaceStart,
          hunk.afterLines.length,
          ...hunk.beforeLines
        );
        applied++;
        continue;
      }
    }

    // Fallback: try with just afterLines (no context)
    if (hunk.afterLines.length > 0) {
      matchIdx = findPattern(currentLines, hunk.afterLines, hint);
      if (matchIdx >= 0) {
        currentLines.splice(matchIdx, hunk.afterLines.length, ...hunk.beforeLines);
        applied++;
        continue;
      }
    }

    // Could not find the hunk — conflict
    const snippet = hunk.afterLines.slice(0, 3).join("\n");
    conflicts.push({
      hunkIndex: originalIdx,
      description:
        "Could not find the original changes in the current file (likely modified by a later prompt)",
      searchSnippet: snippet.slice(0, 200),
    });
  }

  return {
    content: currentLines.join("\n"),
    applied,
    conflicts,
  };
}

// ── High-level selective revert ─────────────────────────────

export function selectiveRevert(
  before: string,
  after: string,
  current: string
): RevertResult {
  if (before === after) {
    return { content: current, applied: 0, conflicts: [] };
  }

  // Fast path: no subsequent changes, simple restore
  if (current === after) {
    return { content: before, applied: 1, conflicts: [] };
  }

  const hunks = computeHunks(before, after);
  if (hunks.length === 0) {
    return { content: current, applied: 0, conflicts: [] };
  }

  return applyReverseHunks(current, hunks);
}

// ── Claude string-level revert ──────────────────────────────

export function revertStringEdits(
  currentContent: string,
  edits: Array<{ oldString: string; newString: string }>
): RevertResult {
  let content = currentContent;
  let applied = 0;
  const conflicts: ConflictInfo[] = [];

  // Apply in reverse order (last edit first) to avoid offset issues
  const reversed = [...edits].reverse();

  for (let i = 0; i < reversed.length; i++) {
    const edit = reversed[i];
    const originalIdx = edits.length - 1 - i;

    const pos = content.indexOf(edit.newString);
    if (pos >= 0) {
      content =
        content.slice(0, pos) +
        edit.oldString +
        content.slice(pos + edit.newString.length);
      applied++;
    } else {
      conflicts.push({
        hunkIndex: originalIdx,
        description:
          "The text introduced by this edit was not found (likely modified by a later prompt)",
        searchSnippet: edit.newString.slice(0, 200),
      });
    }
  }

  return { content, applied, conflicts };
}
