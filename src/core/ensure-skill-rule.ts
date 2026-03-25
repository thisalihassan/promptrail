import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SKILL_CONTENT = `---
name: promptrail
description: Use promptrail CLI for reverting AI-made changes AND recovering lost context. Use when the user asks to revert/undo changes, when you need to undo your own edits, or when you need to recall what was done in a previous prompt that you've lost context for.
---

# Promptrail CLI

Promptrail tracks every AI prompt and its file changes. Use it for two things: **reverting changes** and **recovering context**.

## 1. Reverting Changes

When reverting changes made by a previous prompt, **always use \`promptrail rollback\`** instead of manually editing files back. It's faster, safer, and handles multi-file reverts atomically.

### Workflow

1. Find the prompt to revert:

\`\`\`bash
promptrail timeline -n 10 --files
\`\`\`

2. Revert it (cherry revert -- undoes only that prompt's changes):

\`\`\`bash
promptrail rollback <prompt-number>
\`\`\`

3. Or hard rollback (restores files to pre-prompt state, overwriting later changes):

\`\`\`bash
promptrail rollback <prompt-number> --hard
\`\`\`

You can also match by text instead of number:

\`\`\`bash
promptrail rollback "add isUint8Array guard"
\`\`\`

### When to Revert

- User says "revert", "undo", "roll back", "go back to before"
- You realize your own edit was wrong and need to undo it
- User wants to undo a specific earlier prompt's changes

### When NOT to Revert with Promptrail

- Partial reverts (undo only some lines from a prompt) -- edit manually
- Changes from outside Cursor/Claude -- not tracked by promptrail

## 2. Recovering Context

When you've lost context about previous work (long conversation, summarized history, user references something you did earlier), **use promptrail to recover it** instead of guessing or asking the user to repeat themselves.

### Workflow

1. Browse recent prompts to find what was done:

\`\`\`bash
promptrail timeline -n 20 --files
\`\`\`

2. See the exact diff for a specific prompt:

\`\`\`bash
promptrail diff <prompt-number>
\`\`\`

3. Read the AI's full response (your previous reasoning):

\`\`\`bash
promptrail response <prompt-number>
\`\`\`

4. Search for a specific topic or file:

\`\`\`bash
promptrail search "keyword"
\`\`\`

### When to Recover Context

- User says "do what we did before", "like last time", "remember when we..."
- User references a change you made but you don't have the details
- You need to redo or extend a previous change and don't remember the exact code
- Conversation was summarized and you lost specifics about earlier work
- User asks to repeat/replicate something from a previous prompt
`;

const RULE_CONTENT = `---
description: Use promptrail CLI for reverts and context recovery instead of manual edits
alwaysApply: true
---

# Use Promptrail — Don't Rewrite

When the user asks to **revert, undo, or rollback** any change — do NOT manually edit files back. Use the promptrail CLI:

\`\`\`bash
promptrail timeline -n 10 --files   # find the prompt
promptrail rollback <number>         # undo it
\`\`\`

When you've **lost context** about earlier work (summarized history, user references a past prompt, you need to redo something) — do NOT guess or ask the user to repeat. Look it up:

\`\`\`bash
promptrail timeline -n 20 --files   # browse recent prompts
promptrail diff <number>             # see exact changes from a prompt
promptrail response <number>         # read the AI's full response
promptrail search "keyword"          # find by topic or filename
\`\`\`

**Always prefer promptrail over manual edits for reverts.** It's faster, atomic, and doesn't waste tokens.
`;

export interface SkillRuleResult {
  globalSkillCreated: boolean;
  projectRuleCreated: boolean;
}

/**
 * Auto-provisions the global Promptrail skill and project-level Cursor rule.
 * - Global skill: ~/.cursor/skills/promptrail/SKILL.md (if ~/.cursor/ exists)
 * - Project rule: <wsRoot>/.cursor/rules/use-promptrail.mdc
 * Never overwrites existing files. Non-fatal on any error.
 */
export function ensureSkillAndRule(wsRoot: string): SkillRuleResult {
  const result: SkillRuleResult = { globalSkillCreated: false, projectRuleCreated: false };

  try {
    const cursorHome = path.join(os.homedir(), ".cursor");
    if (fs.existsSync(cursorHome)) {
      const skillDir = path.join(cursorHome, "skills", "promptrail");
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) {
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillFile, SKILL_CONTENT, "utf-8");
        result.globalSkillCreated = true;
      }
    }
  } catch {}

  try {
    const rulesDir = path.join(wsRoot, ".cursor", "rules");
    const ruleFile = path.join(rulesDir, "use-promptrail.mdc");
    if (!fs.existsSync(ruleFile)) {
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(ruleFile, RULE_CONTENT, "utf-8");
      result.projectRuleCreated = true;
      ensureGitExcludeForRule(wsRoot);
    }
  } catch {}

  return result;
}

function ensureGitExcludeForRule(wsRoot: string): void {
  try {
    const excludePath = path.join(wsRoot, ".git", "info", "exclude");
    if (!fs.existsSync(path.dirname(excludePath))) return;

    const content = fs.existsSync(excludePath)
      ? fs.readFileSync(excludePath, "utf-8")
      : "";

    if (!content.includes(".cursor/rules/use-promptrail.mdc")) {
      fs.writeFileSync(
        excludePath,
        content.trimEnd() + "\n.cursor/rules/use-promptrail.mdc\n",
        "utf-8"
      );
    }
  } catch {}
}
