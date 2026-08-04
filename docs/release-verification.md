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
`package.json` carries an `overrides` block, and that block *is* published — you
can read it in the installed `package.json`. But npm honors overrides only from
the root project being installed, never from an installed dependency. Our tree
therefore resolves the pinned versions while a consumer's tree resolves the
unpinned ones, and the repo can report zero advisories while a fresh
`npm install @proofofwork-agency/reporecall` reports several.

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
reports **no fix available**, and no currently released upstream version changes
that: `@huggingface/transformers` 4.2.0, the latest, still requires
`sharp ^0.34.5`. Bumping our dependency — including across the 3.x→4.x major —
would not clear the advisory.

Reporecall's entire use of that library is one call site,
`pipeline("feature-extraction", …)` in `src/indexer/local-embedder.ts`. No
Reporecall code path passes an image to transformers, imports `RawImage`, or
constructs a processor, and `sharp` is reached only through transformers'
image-decoding path. That is why we consider the CVEs unreachable in this usage —
argued from that call site rather than from a proof that libvips can never be
entered. Either way they will appear in your `npm audit`, which deserves to be
said out loud rather than discovered.

If your organization gates on `npm audit`, pin `sharp` yourself:

```json
{ "overrides": { "sharp": "0.35.3" } }
```

That is exactly what this repo does, and it is why the root audit is clean.
Revisit when `@huggingface/transformers` widens its `sharp` range.
