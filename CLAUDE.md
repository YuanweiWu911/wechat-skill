# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This is a personal sandbox for learning, practicing, and prototyping Claude Code custom skills. There is no application code, build system, or test suite.

## Skill development

Custom skills live under `.claude/skills/<skill-name>/SKILL.md`. Each skill is a directory containing at minimum a `SKILL.md` with YAML frontmatter (`name`, `description`, and optional fields) followed by Markdown instructions.

When creating or editing a skill:
- Use `` !`command` `` syntax to inject live shell output into the skill content before Claude sees it
- Prefer `disable-model-invocation: true` for skills with side effects; omit it for skills Claude should auto-load
- Reference scripts or supporting files via `${CLAUDE_SKILL_DIR}`

Skills are hot-reloaded: changes to `.claude/skills/` take effect within the current session.
