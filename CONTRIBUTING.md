# Contributing to Reporecall

Reporecall is a local-first codebase context engine for coding agents. Keep changes focused, source-grounded, and easy to verify.

## Local Setup

```bash
npm ci
npm run build
npm test -- --run
```

Use `make ci-precheck` before pushing. It mirrors the CI gates that run on pull requests.

## Development

Reporecall requires Node.js `>=20` (declared in `package.json` `engines`). Canonical workflow:

```bash
npm ci            # install dependencies
npm run lint      # type-check (tsc --noEmit)
npm test -- --run # run the test suite (Vitest, single run)
npm run build     # build with tsup
```

## Pull Requests

- Use one logical change per PR.
- Include tests for behavior changes.
- Run `make ci-precheck` and include anything you could not verify.
- Use conventional commit-style titles such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, or `chore:`.
- Update `CHANGELOG.md` or relevant docs for user-facing changes.

## Dependencies

Dependency changes need a short justification in the PR:

- why the package or version is needed;
- whether it adds native code, install-time downloads, or runtime network access;
- why existing dependencies are not enough.

Security fixes are welcome. Production dependency advisories at `high` or `critical` severity must be fixed or explicitly justified before release.
