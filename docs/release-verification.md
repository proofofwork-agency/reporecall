# Release And Verification

Reporecall releases are managed through release-please.

Day to day:

- Merge `feat:` and `fix:` changes to `main`.
- The release-please workflow maintains a release PR.
- Merging the release PR creates a GitHub release.
- The publish workflow publishes the npm package from the release event.

Before pushing or publishing, run:

```bash
make ci-precheck
```

The CI and publish gates run:

- `npm ci`
- `npm run lint`
- `npm test -- --run`
- `npm run build`
- `npm run smoke`
- `npm audit --omit=dev --audit-level=high`
- `npm pack --dry-run`

Do not soft-fail security, test, build, or packaging gates.

## Two audits, because they measure different trees

`npm audit` at the repo root does **not** tell you what a user gets. The root
`package.json` carries an `overrides` block, and npm overrides apply only to the
project that declares them — they are not published and do not reach anyone
installing this package. The repo can therefore report zero advisories while a
fresh `npm install @proofofwork-agency/reporecall` reports several.

That is not hypothetical. It was true through v0.9.1 and went unnoticed because
`scripts/packed-demo.mjs` — the only step that installs the tarball the way a user
would — passed `--no-audit`. `npm run demo:packed` now audits that install root
and prints the counts on every release, so the gap cannot become invisible again.
It fails only on `critical`, because a `high` with no upstream fix is a disclosure
problem rather than something a release can solve.

### Known consumer advisories

As of v0.9.1: **3 high, 0 critical.**

`@huggingface/transformers` depends on `sharp` `^0.34.5`, and every `sharp` below
0.35.0 inherits four libvips CVEs
([GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)). npm
reports **no fix available**: the latest `@huggingface/transformers` (4.2.0) still
requires `sharp ^0.34.5`, so no version of this package can resolve it.

Reporecall uses `@huggingface/transformers` only for local **text** embeddings.
`sharp` is that library's image-decoding path and is never invoked by any
Reporecall code path, so the CVEs are not reachable in this usage — but they will
appear in your `npm audit` output, and that deserves to be said out loud rather
than discovered.

If your organization gates on `npm audit`, pin `sharp` yourself:

```json
{ "overrides": { "sharp": "0.35.3" } }
```

That is exactly what this repo does, and it is why the root audit is clean.
Revisit when `@huggingface/transformers` widens its `sharp` range.
