# Contributing

Thanks for your interest. The project is pre-alpha; the most useful contributions right now are
bug reports about the design and tests against real providers you own.

## Ground rules

- Open an issue before a large change, so the direction is agreed first.
- Every input has a limit that fits its meaning and unit (see `ADDRESS_LIMITS`), and is validated
  at the boundary with a strict schema.
- Nothing is described as working until it was run against a real account. State what you tested.
- Never commit credentials, OAuth client secrets or real mail content.
- Tests and docs use reserved names only (`example.com`, `*.example`, `*.test`, `*.invalid`, RFC 2606),
  never your own address, domain, login or server. `scripts/check-identifiers.ts` fails `npm test`
  and CI on any other host; a public provider the code needs goes into its `PUBLIC_HOSTS`.
- Adapters touch only rules they created. They never modify the user's own rules.

## Before you open a pull request

```sh
npm ci
git config core.hooksPath .githooks   # once per clone: identity + gitleaks check on every commit
npm run typecheck && npm run lint && npm run format:check && npm test
```

The pre-commit hook needs [gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 on `PATH`.

`npm run ci:local` runs the same steps as CI against your last commit in a clean worktree and
reports all failures at once.

By contributing you agree that your contribution is licensed under Apache-2.0.
