import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FTSStore } from "../../src/storage/fts-store.js";

describe("FTSStore", () => {
  let dataDir: string;
  let store: FTSStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-fts-"));
    store = new FTSStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps a single exact phrase match instead of falling back to broad OR search", () => {
    store.bulkUpsert([
      {
        id: "css",
        name: "styles.css",
        filePath: "src/styles.css",
        content: '.alpha::after { content: "CSS_UNIQUE_TOKEN"; }',
        kind: "rule_set",
      },
      {
        id: "ruby",
        name: "main.rb",
        filePath: "src/main.rb",
        content: 'def alpha; "RB_UNIQUE_TOKEN"; end',
        kind: "method",
      },
    ]);

    const results = store.search("CSS_UNIQUE_TOKEN", 10);
    expect(results.map((r) => r.id)).toEqual(["css"]);
  });

  it("keeps a single all-terms match for multi-word queries", () => {
    store.bulkUpsert([
      {
        id: "vue",
        name: "App.vue",
        filePath: "src/App.vue",
        content: '<template><div>VUE UNIQUE TOKEN</div></template>',
        kind: "component",
      },
      {
        id: "ts",
        name: "index.ts",
        filePath: "src/index.ts",
        content: "const value = 'token';",
        kind: "function_declaration",
      },
    ]);

    const results = store.search("VUE UNIQUE TOKEN", 10);
    expect(results.map((r) => r.id)).toEqual(["vue"]);
  });
});
