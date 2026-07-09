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
