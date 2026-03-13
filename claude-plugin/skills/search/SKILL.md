---
description: Search across all AI prompts and responses using full-text search. Use when the user wants to find a previous conversation, check if they already asked something, or search for a specific topic across sessions.
---

# Search

Full-text search across all prompts and responses in this project.

```bash
promptrail search "query" --source claude
```

Optional filter:
- `--model <substring>` — filter by model (e.g. `--model sonnet`)

Pass `--source claude` to search only Claude Code sessions.

Examples:
- `promptrail search "shadow DB"` — find all mentions of shadow DB
- `promptrail search "toEpochMs"` — find code symbol references
- `promptrail search "auth" --model sonnet` — search with model filter

Results show:
- Matching prompt text with highlighted keywords
- Matching response snippets (if the response matched)
- Session metadata (model, time ago)

Results are ranked by relevance via FTS5. The search covers both what you asked and what the AI replied.

If no results are found, the query may be too specific. Try shorter or broader terms.
