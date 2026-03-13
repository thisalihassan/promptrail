---
description: Show the diff (file changes) for a specific AI prompt. Use when the user asks what a prompt changed, wants to see a diff, or asks about changes from a specific prompt number or text.
---

# Diff

Show the file-level diff for a specific prompt.

The user will provide either a prompt number or search text as `$ARGUMENTS`.

```bash
promptrail diff $ARGUMENTS
```

This shows:
- Which files were added, modified, or deleted
- Line-by-line diff with additions (+) and removals (-)
- Prompt metadata (time, file count)

**Selector format:**
- By index: `promptrail diff 3` — diff for prompt #3
- By text: `promptrail diff "refactor auth"` — diff for prompt matching text

If the user doesn't specify a prompt, first run `promptrail timeline` to show available prompts, then ask which one they want to diff.

Present the diff output clearly. If the diff is large, summarize the key changes.
