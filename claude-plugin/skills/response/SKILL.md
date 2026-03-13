---
description: View the AI's full response for a specific prompt. Use when the user wants to see what the AI replied, review a previous answer, or check tool calls from a specific prompt.
---

# Response

View the AI's full response for a specific prompt.

```bash
promptrail response $ARGUMENTS
```

This shows the complete assistant response including:
- Text replies
- Tool calls (with file paths and commands)
- All content in chronological order

**Selector format:**
- By index: `promptrail response 3` — response for prompt #3
- By text: `promptrail response "refactor auth"` — response for prompt matching text

If the user doesn't specify a prompt, first run `promptrail timeline` to show available prompts, then ask which one they want to view.

Claude Code responses are read directly from the session JSONL -- all data is always available.
