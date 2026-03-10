---
description: Rollback (undo) the file changes from a specific AI prompt. Use when the user wants to undo, revert, or rollback changes from a specific prompt. IMPORTANT - this is destructive, always confirm with the user first.
---

# Rollback

Restore files to their state before a specific AI prompt's changes were applied.

**IMPORTANT: This is a destructive operation. Always confirm with the user before executing.**

The user will provide either a prompt number or search text as `$ARGUMENTS`.

Before rolling back:
1. First show what will be affected by running: `promptrail diff $ARGUMENTS`
2. Tell the user exactly which files will be restored/deleted
3. Ask for explicit confirmation
4. Only then execute:

```bash
promptrail rollback $ARGUMENTS
```

**Selector format:**
- By index: `promptrail rollback 5` — rollback prompt #5
- By text: `promptrail rollback "add auth"` — rollback prompt matching text

After rollback, the files are restored to their pre-prompt state. This only works for prompts that have snapshot data (file watcher must have been active).

If rollback says "No snapshot data", explain that the file watcher wasn't active during that prompt's execution, so before/after content wasn't captured.
