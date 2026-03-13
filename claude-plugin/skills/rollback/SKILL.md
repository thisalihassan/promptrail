---
description: Rollback (undo) the file changes from a specific AI prompt. Use when the user wants to undo, revert, or rollback changes from a specific prompt. IMPORTANT - this is destructive, always confirm with the user first.
---

# Rollback

Undo a specific prompt's file changes using exact string-matching reversal.

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

Claude Code rollback works by finding the exact `old_string`/`new_string` pairs from the JSONL tool_use blocks and reversing them. If a later prompt modified the same strings, conflicts are reported per-file.

File creations (`Write` tool) are deleted if the content hasn't changed since. If later prompts modified the created file, a conflict is reported.
