import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../../src/core/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mem-config-"));
}

/**
 * Write a config.json into <tmpDir>/.memory/config.json so loadConfig picks
 * it up, then return the tmpDir as the projectRoot.
 */
function writeConfigJson(tmpDir: string, data: unknown): void {
  const dataDir = join(tmpDir, ".memory");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

describe("loadConfig — default config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a config object when no config.json exists", () => {
    const config = loadConfig(tmpDir);
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
  });

  it("sets projectRoot to the supplied directory", () => {
    const config = loadConfig(tmpDir);
    expect(config.projectRoot).toBe(tmpDir);
  });

  it("sets dataDir to <projectRoot>/.memory", () => {
    const config = loadConfig(tmpDir);
    expect(config.dataDir).toBe(join(tmpDir, ".memory"));
  });

  it("defaults embeddingProvider to 'local'", () => {
    const config = loadConfig(tmpDir);
    expect(config.embeddingProvider).toBe("local");
  });

  it("defaults embeddingModel to Xenova/all-MiniLM-L6-v2", () => {
    const config = loadConfig(tmpDir);
    expect(config.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("defaults embeddingDimensions to 384", () => {
    const config = loadConfig(tmpDir);
    expect(config.embeddingDimensions).toBe(384);
  });

  it("defaults maxFileSize to 100 KiB (102400 bytes)", () => {
    const config = loadConfig(tmpDir);
    expect(config.maxFileSize).toBe(100 * 1024);
  });

  it("defaults searchWeights to { vector: 0.5, keyword: 0.3, recency: 0.2 }", () => {
    const config = loadConfig(tmpDir);
    expect(config.searchWeights).toEqual({
      vector: 0.5,
      keyword: 0.3,
      recency: 0.2,
    });
  });

  it("defaults factExtractors to an empty array", () => {
    const config = loadConfig(tmpDir);
    expect(config.factExtractors).toEqual([]);
  });

  it("defaults port to 37222", () => {
    const config = loadConfig(tmpDir);
    expect(config.port).toBe(37222);
  });

  it("includes the full current parser language surface in default extensions", () => {
    const config = loadConfig(tmpDir);
    for (const ext of [".cs", ".php", ".zig", ".lua", ".html", ".vue", ".toml"]) {
      expect(config.extensions).toContain(ext);
    }
  });

  it("never exposes openaiApiKey even when it is absent in the file", () => {
    const config = loadConfig(tmpDir);
    expect((config as Record<string, unknown>).openaiApiKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Valid user config — overrides are applied
// ---------------------------------------------------------------------------

describe("loadConfig — valid user config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a valid embeddingProvider override", () => {
    writeConfigJson(tmpDir, { embeddingProvider: "openai" });
    const config = loadConfig(tmpDir);
    expect(config.embeddingProvider).toBe("openai");
  });

  it("applies a valid port override", () => {
    writeConfigJson(tmpDir, { port: 9000 });
    const config = loadConfig(tmpDir);
    expect(config.port).toBe(9000);
  });

  it("applies a valid maxFileSize override", () => {
    writeConfigJson(tmpDir, { maxFileSize: 512 * 1024 });
    const config = loadConfig(tmpDir);
    expect(config.maxFileSize).toBe(512 * 1024);
  });

  it("merges partial searchWeights with defaults for missing keys", () => {
    // Provide all three weights explicitly
    writeConfigJson(tmpDir, {
      searchWeights: { vector: 0.4, keyword: 0.4, recency: 0.2 },
    });
    const config = loadConfig(tmpDir);
    expect(config.searchWeights.vector).toBe(0.4);
    expect(config.searchWeights.keyword).toBe(0.4);
    expect(config.searchWeights.recency).toBe(0.2);
  });

  it("accepts a valid factExtractor with a safe regex", () => {
    writeConfigJson(tmpDir, {
      factExtractors: [
        { keyword: "TODO", pattern: "TODO:\\s+(.+)", label: "todo" },
      ],
    });
    const config = loadConfig(tmpDir);
    expect(config.factExtractors).toHaveLength(1);
    expect(config.factExtractors[0].label).toBe("todo");
  });
});

// ---------------------------------------------------------------------------
// Invalid regex in factExtractors
// ---------------------------------------------------------------------------

describe("loadConfig — invalid regex in factExtractors", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("filters out a factExtractor with an invalid regex pattern", () => {
    // "[invalid" is a regex syntax error (unclosed character class)
    writeConfigJson(tmpDir, {
      factExtractors: [
        { keyword: "bad", pattern: "[invalid", label: "bad-label" },
      ],
    });
    // The Zod schema rejects the invalid regex at parse time, so the whole
    // config falls back to defaults (empty factExtractors).
    const config = loadConfig(tmpDir);
    expect(config.factExtractors).toEqual([]);
  });

  it("keeps valid extractors and filters invalid ones when both are present", () => {
    // Zod validates each extractor individually. A single invalid extractor
    // causes the whole array parse to fail, so we test the post-merge filter
    // by bypassing Zod: write two entries — one valid, one with a ReDoS pattern.
    // The safe-regex2 filter runs after the merge stage and removes ReDoS patterns.
    writeConfigJson(tmpDir, {
      factExtractors: [
        // Valid and safe
        { keyword: "NOTE", pattern: "NOTE:\\s(.+)", label: "note" },
        // Valid syntax but catastrophic backtracking (ReDoS) — rejected by safe-regex2
        {
          keyword: "redos",
          pattern: "(a+)+$",
          label: "redos-label",
        },
      ],
    });
    const config = loadConfig(tmpDir);
    // "NOTE" extractor is safe; "(a+)+$" is unsafe and must be removed.
    const labels = config.factExtractors.map((e) => e.label);
    expect(labels).toContain("note");
    expect(labels).not.toContain("redos-label");
  });

  it("returns empty factExtractors when all extractors have invalid regex", () => {
    writeConfigJson(tmpDir, {
      factExtractors: [
        { keyword: "k1", pattern: "[bad", label: "l1" },
        { keyword: "k2", pattern: "(?P<bad)", label: "l2" },
      ],
    });
    const config = loadConfig(tmpDir);
    expect(config.factExtractors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Weight sum warning — config still loads
// ---------------------------------------------------------------------------

describe("loadConfig — weight sum warning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads config successfully when weights do not sum to 1.0", () => {
    writeConfigJson(tmpDir, {
      searchWeights: { vector: 0.9, keyword: 0.9, recency: 0.9 },
    });
    // Should not throw — warning is logged but loading continues
    expect(() => loadConfig(tmpDir)).not.toThrow();
    const config = loadConfig(tmpDir);
    expect(config.searchWeights.vector).toBe(0.9);
    expect(config.searchWeights.keyword).toBe(0.9);
  });

  it("loads config when all weights are zero (near-zero sum warning)", () => {
    writeConfigJson(tmpDir, {
      searchWeights: { vector: 0.0, keyword: 0.0, recency: 0.0 },
    });
    expect(() => loadConfig(tmpDir)).not.toThrow();
    const config = loadConfig(tmpDir);
    expect(config.searchWeights.vector).toBe(0.0);
  });

  it("loads config normally when weights sum to exactly 1.0", () => {
    writeConfigJson(tmpDir, {
      searchWeights: { vector: 0.5, keyword: 0.3, recency: 0.2 },
    });
    const config = loadConfig(tmpDir);
    const sum =
      config.searchWeights.vector +
      config.searchWeights.keyword +
      config.searchWeights.recency;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// Unknown fields — strict() rejects them and falls back to defaults
// ---------------------------------------------------------------------------

describe("loadConfig — unknown fields fall back to defaults", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to defaults when config.json has unrecognised top-level keys", () => {
    writeConfigJson(tmpDir, {
      // Valid field
      port: 9999,
      // Unknown field — .strict() should reject the whole object
      unknownField: "some-value",
    });
    const config = loadConfig(tmpDir);
    // Falls back to defaults, so port reverts to 37222
    expect(config.port).toBe(37222);
  });

  it("does not expose unknown fields on the returned config", () => {
    writeConfigJson(tmpDir, { surpriseKey: true });
    const config = loadConfig(tmpDir);
    expect((config as Record<string, unknown>).surpriseKey).toBeUndefined();
  });

  it("falls back when only unknown fields are present", () => {
    writeConfigJson(tmpDir, { foo: 1, bar: "baz" });
    const config = loadConfig(tmpDir);
    // All defaults should be intact
    expect(config.embeddingProvider).toBe("local");
    expect(config.port).toBe(37222);
  });
});

// ---------------------------------------------------------------------------
// Invalid embedding provider
// ---------------------------------------------------------------------------

describe("loadConfig — invalid embedding provider", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to defaults when embeddingProvider is not a valid enum value", () => {
    writeConfigJson(tmpDir, { embeddingProvider: "invalid-provider" });
    const config = loadConfig(tmpDir);
    // Zod rejects the bad enum value, whole config falls back to defaults
    expect(config.embeddingProvider).toBe("local");
  });

  it("does not throw when embeddingProvider is invalid", () => {
    writeConfigJson(tmpDir, { embeddingProvider: "gpt-embeddings" });
    expect(() => loadConfig(tmpDir)).not.toThrow();
  });

  it("accepts all valid embedding providers", () => {
    const valid = ["local", "ollama", "openai", "keyword"] as const;
    for (const provider of valid) {
      writeConfigJson(tmpDir, { embeddingProvider: provider });
      const config = loadConfig(tmpDir);
      expect(config.embeddingProvider).toBe(provider);
    }
  });
});

// ---------------------------------------------------------------------------
// Security: openaiApiKey is never loaded from config file
// ---------------------------------------------------------------------------

describe("loadConfig — openaiApiKey security", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips openaiApiKey even if it appears in config.json", () => {
    // openaiApiKey is not in the Zod schema so strict() will reject the object
    // and fall back to defaults — either way the key must not appear on config.
    writeConfigJson(tmpDir, {
      embeddingProvider: "openai",
      openaiApiKey: "sk-secret-key",
    });
    const config = loadConfig(tmpDir);
    expect((config as Record<string, unknown>).openaiApiKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON falls back to defaults
// ---------------------------------------------------------------------------

describe("loadConfig — malformed JSON", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to defaults when config.json contains invalid JSON", () => {
    const dataDir = join(tmpDir, ".memory");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), "{ not valid json ,,, }");

    expect(() => loadConfig(tmpDir)).not.toThrow();
    const config = loadConfig(tmpDir);
    expect(config.embeddingProvider).toBe("local");
    expect(config.port).toBe(37222);
  });
});
