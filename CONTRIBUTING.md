# Contributing

Thanks for taking a look. byoa is small on purpose; the fastest way to get a change merged is to
keep it that way.

## Ground rules

- **No runtime dependencies.** The core uses only Node built-ins. A PR that adds a runtime
  dependency to `dependencies` needs a very good reason and a discussion first.
- **No build step.** Source is TypeScript run directly via Node's type-stripping. That means no
  `enum`, no `namespace`, no constructor parameter properties (the tsconfig's
  `erasableSyntaxOnly` enforces it).
- **Typecheck is part of the test run.** `npm test` runs `tsc --noEmit` first; a PR that does not
  typecheck is not mergeable.
- **Tests accompany behaviour.** New tool, provider or sandbox rule → a test that would fail
  without it. Sandbox tests should run against real bubblewrap when it is available.
- **Security is a feature, not a follow-up.** If your change touches the sandbox, the environment
  allowlist, path containment, or redaction, say so in the PR and add a regression test.

## Workflow

```bash
npm install
npm test
```

Then:

1. Fork and branch from `main`.
2. Make the change, with tests.
3. Run `npm test` and make sure it passes with no skips you introduced.
4. Open a PR describing **what changed and how you verified it**. Include the command you ran.

## Style

- Match the surrounding code: small modules, comments that explain *why*, honest names.
- No dead configuration. If a field cannot be honoured, remove it or make the limitation visible.
- Errors should tell a human what to do next.

## AI attribution

This project is AI-generated with OpenCode. Contributions written with an AI assistant are
welcome; state which model was used in the PR description so the record stays accurate.

## Reporting bugs

Open an issue with: what you ran, what happened, what you expected, and your OS, Node version and
`bwrap --version` (or "none"). For security issues, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.
