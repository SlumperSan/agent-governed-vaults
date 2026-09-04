# First-party project skills

These are protocol source, not vendored tooling, so they live here and are tracked. The repo's
convention (see `.gitignore`) keeps `.claude/skills/` ignored because that directory holds symlinks
into `.agents/skills/` for third-party skills installed with `npx skills add`, and an un-ignored
`.claude/skills/` would let a concurrent session's `git add` sweep vendored tooling into a PR.

Claude Code discovers project skills at `.claude/skills/<name>/SKILL.md`, and follows symlinks, so
after a fresh clone link each one:

```
for S in skills/*/; do S=$(basename "$S"); ln -s "../../skills/$S" ".claude/skills/$S"; done
```

| skill | when it loads |
|---|---|
| `rwally-claims-contract` | before writing or editing any public copy — pinned strings, banned shapes, punctuation-changes-scope |
| `rwally-design-system` | before designing or building any `apps/site-next` component — CSP envelope, tokens, motion grammar, budgets |
| `visual-verify-loop` | before calling any UI change done — build, serve, screenshot, network, trace, guards |
