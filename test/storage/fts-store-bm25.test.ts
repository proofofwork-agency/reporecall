import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FTSStore } from "../../src/storage/fts-store.js";

describe("FTSStore BM25 column weighting", () => {
  let dataDir: string;
  let store: FTSStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-fts-bm25-"));
    store = new FTSStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // regression: name column (weight 10) must outrank kind column (weight 0.1)
  it("ranks a name-field match above a kind-only match for the same query term", () => {
    store.bulkUpsert([
      {
        id: "by-name",
        name: "billing",
        filePath: "src/by-name.ts",
        content: "helper utility string processing unrelated text",
        kind: "method",
      },
      {
        id: "by-kind",
        name: "generic",
        filePath: "src/by-kind.ts",
        content: "helper utility string processing unrelated text",
        kind: "billing",
      },
    ]);

    const results = store.search("billing", 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The chunk whose NAME contains "billing" must rank above the one whose
    // only match is in the low-weight kind column.
    const nameIdx = results.findIndex((r) => r.id === "by-name");
    const kindIdx = results.findIndex((r) => r.id === "by-kind");
    expect(nameIdx).toBeLessThan(kindIdx);
    expect(results[0].id).toBe("by-name");
  });

  it("confirms the weighting with multiple name vs kind pairs", () => {
    const chunks: Array<{
      id: string;
      name: string;
      filePath: string;
      content: string;
      kind: string;
    }> = [];
    for (let i = 0; i < 5; i++) {
      chunks.push({
        id: `name-${i}`,
        name: "billing",
        filePath: `src/name-${i}.ts`,
        content: "shared common text filler unrelated",
        kind: "method",
      });
      chunks.push({
        id: `kind-${i}`,
        name: "generic",
        filePath: `src/kind-${i}.ts`,
        content: "shared common text filler unrelated",
        kind: "billing",
      });
    }
    store.bulkUpsert(chunks);

    const results = store.search("billing", 20);
    // Every name-match should appear before every kind-only match
    const nameRanks = results
      .filter((r) => r.id.startsWith("name-"))
      .map((r) => results.indexOf(r));
    const kindRanks = results
      .filter((r) => r.id.startsWith("kind-"))
      .map((r) => results.indexOf(r));

    for (const nr of nameRanks) {
      for (const kr of kindRanks) {
        expect(nr).toBeLessThan(kr);
      }
    }
  });
});
