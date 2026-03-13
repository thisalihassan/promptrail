---
description: List all Claude Code sessions for this project. Use when the user asks about sessions, wants to see which sessions exist, or asks about session history.
---

# Sessions

List all Claude Code sessions for this project.

```bash
promptrail sessions --source claude
```

Optional filter:
- `--model <substring>` — filter by model name (e.g. `--model sonnet`)

Pass `--source claude` to list only Claude Code sessions.

This shows each session with:
- Session ID (truncated)
- Number of prompts
- Last activity time
- Model used

Present the output in a clean format. If the user wants details about a specific session, suggest using the timeline skill to see all prompts.
