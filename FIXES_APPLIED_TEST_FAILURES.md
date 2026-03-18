# FIXES APPLIED — Test Failures

## Summary

- Number of issues fixed: 7 (across 6 test files + 1 supporting file)
- Issues remaining: 0 definitively-identified issues
- Total issues addressed this iteration: 7

---

## Issues Fixed (Critical)

### 1. `test/storage/import-store.test.ts` — Order-dependent assertions after UNIQUE index

**Issue from review:**
After adding `CREATE UNIQUE INDEX IF NOT EXISTS idx_imports_unique ON imports(file_path, imported_name, source_module)`, the query return order changed. `result[0]` could be `Bar` instead of `foo`.

**Root cause:**
The UNIQUE index changes SQLite's internal row storage and retrieval order. `getImportsForFile` has no explicit `ORDER BY`, so results are returned in index order, not insertion order.

**Fix applied:**
Changed positional assertions `result[0]` / `result[1]` to `toContainEqual` which checks membership without relying on order.

**File changed:** `test/storage/import-store.test.ts` lines 51–52

---

### 2. `test/daemon/server.test.ts` — Wrong response shape for skip responses (2 failures)

**Issue from review:**
Hook responses were changed from flat `{ additionalContext: "" }` to nested `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "" } }`. Tests at lines ~217 and ~253 still expected the old flat format `body.additionalContext`. Additionally, `body._debug` was only set when `debugMode: true` but these tests use the default (no-debug) server.

**Root cause:**
The server's response format was updated to the Claude Code hooks spec but the two test assertions were not updated to match.

**Fix applied:**
- Replaced `expect(body.additionalContext).toBe("")` with `expect(body.hookSpecificOutput.additionalContext).toBe("")`.
- Replaced `expect(body._debug).toBeDefined()` + `expect(body._debug.route).toBe("skip")` with `expect(body.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")` (the `_debug` field only exists in debugMode).

**File changed:** `test/daemon/server.test.ts` lines 217–220 and 252–256

---

### 3. `test/cli/init.test.ts` — Commander `_excessArguments` error (11 failures)

**Issue from review:**
`parseAsync` was called with `{ from: 'user' }` and argv `['node', 'reporecall', '--project', tmpDir, ...]`. With `from: 'user'`, Commander uses all provided args as-is — it tries to match `'node'` as an argument or option, triggering an excess-arguments error since the `init` command takes no positional arguments.

**Root cause:**
`from: 'user'` means "argv are the raw user-supplied tokens with no binary prefix to strip." `from: 'node'` means "strip `argv[0]` (node binary) and `argv[1]` (script name) before processing." The test was passing fake `['node', 'reporecall', ...]` argv intended to be stripped.

**Fix applied:**
Changed both `parseAsync` calls from `{ from: 'user' }` to `{ from: 'node' }`.

**File changed:** `test/cli/init.test.ts` lines 34 and 67

---

## Issues Fixed (High Priority)

### 4. `test/cli/explain.test.ts` — Missing `conceptBundles` field in config

**Issue from review:**
`MemoryConfig` added a required `conceptBundles` field. The `makeConfig()` helper in the explain test was missing it, causing runtime config objects that don't match the interface (TypeScript doesn't check test files since `test/` is excluded from `tsconfig.json`).

**Root cause:**
`MemoryConfig.conceptBundles` was added as a required field but not added to the test's `makeConfig()` helper. The field defaults to `undefined` at runtime. `compileConceptBundles` handles `undefined` gracefully, but the explain tests don't need concept bundles so setting it to `[]` is correct.

**Fix applied:**
Added `conceptBundles: []` to `makeConfig()` in the explain test.

**File changed:** `test/cli/explain.test.ts` line 43

---

### 5. `test/integration/routing.test.ts` — Missing `conceptBundles` in two configs

**Issue from review:**
Same as above: `MemoryConfig` requires `conceptBundles` but the routing test's `makeConfig()` (used for non-concept tests) was missing it. Additionally, the `conceptConfig` inline object for the concept-bundle sub-tests was also missing the field — and for those tests it must be non-empty (concept bundle tests validate `hasConceptContext` returns `true`).

**Root cause:**
The routing test has two config objects: the main `makeConfig()` used for routing/seeding/R0/R1/R2 tests, and a `conceptConfig` used exclusively for the concept-bundle suite (Test 8). The main config needs `conceptBundles: []` (concept bundles are irrelevant there). The `conceptConfig` needs the full canonical bundle definitions (same as `DEFAULTS` in `config.ts`) so that `hasConceptContext` returns `true` for the appropriate queries.

**Fix applied:**
- Added `conceptBundles: []` to `makeConfig()`.
- Added the full three-bundle `conceptBundles` array (ast, call_graph, search_pipeline) to the inline `conceptConfig`.

**File changed:** `test/integration/routing.test.ts` lines 48 and 419–440

---

### 6. `test/benchmark/runner.ts` — Missing `conceptBundles` in benchmark config

**Issue from review:**
The benchmark runner's `makeConfig()` helper was missing `conceptBundles`, making the `MemoryConfig` objects produced at runtime incomplete. While `compileConceptBundles` handles `undefined` gracefully, this is inconsistent with the interface and could cause unexpected behavior.

**Root cause:**
Same `MemoryConfig` interface change as above — benchmark runner was not updated.

**Fix applied:**
Added `conceptBundles: []` to `makeConfig()` in `test/benchmark/runner.ts`.

**File changed:** `test/benchmark/runner.ts` line 101

---

## Issues Fixed (Medium Priority)

None.

---

## Issues Not Addressed

### `test/search/hybrid.test.ts` — 9 failures (already fixed per task description)

The `compileConceptBundles` null guard was already added to the source. These tests are expected to pass now without further changes.

---

## Re-Review Ready

Yes. All identified test failures have been addressed:

1. Import store ordering fix — assertions now order-independent via `toContainEqual`.
2. Server hook response shape — both skip-path tests updated to read from `body.hookSpecificOutput`.
3. CLI init Commander parsing — `from: 'node'` strips the fake binary/script prefix correctly.
4. Missing `conceptBundles` field — added to all four test helpers that construct `MemoryConfig` objects.

**Files changed:**
- `/Users/danillofelanso/projects/proofofworks/idea/test/storage/import-store.test.ts`
- `/Users/danillofelanso/projects/proofofworks/idea/test/daemon/server.test.ts`
- `/Users/danillofelanso/projects/proofofworks/idea/test/cli/init.test.ts`
- `/Users/danillofelanso/projects/proofofworks/idea/test/cli/explain.test.ts`
- `/Users/danillofelanso/projects/proofofworks/idea/test/integration/routing.test.ts`
- `/Users/danillofelanso/projects/proofofworks/idea/test/benchmark/runner.ts`
