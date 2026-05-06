---
name: summarize-changes
description: Summarizes uncommitted changes and flags anything risky. Use when the user asks what changed, wants a commit message, or asks to review their diff.
---

## Current changes

!`git diff HEAD`

!`git diff --cached`

!`git status --short`

## Instructions

Summarize the changes above in 2-3 bullet points, then list any risks you notice:

- Missing error handling
- Hardcoded values
- Tests that need updating
- Breaking changes to public APIs
- Security concerns (unsanitized input, exposed secrets)

If no changes exist, say "No uncommitted changes found."
