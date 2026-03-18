import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { chunkFileWithCalls } from "../../src/parser/chunker.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");

/**
 * Multi-language chunker tests.
 *
 * Each test verifies that tree-sitter can parse the fixture file
 * and extract the expected chunks for that language's extractableTypes.
 */

describe("multi-language chunker", () => {
  // ── TSX ────────────────────────────────────────────────────────────
  it("should chunk TSX with functions, classes, interfaces, enums", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.tsx"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("formatLabel");
    expect(names).toContain("ButtonGroup");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("tsx");
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  // ── JavaScript ─────────────────────────────────────────────────────
  it("should chunk JavaScript with functions, arrow functions, classes", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.js"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("calculateTotal");
    expect(names).toContain("ShoppingCart");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("javascript");
    }
  });

  // ── Go ─────────────────────────────────────────────────────────────
  it("should chunk Go with functions, methods, type declarations", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.go"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("NewConfig");
    expect(names).toContain("main");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("go");
    }
  });

  // ── Rust ───────────────────────────────────────────────────────────
  it("should chunk Rust with functions, structs, enums, traits, impls", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.rs"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("distance");
    expect(names).toContain("Point");
    expect(names).toContain("Shape");
    expect(names).toContain("Drawable");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("rust");
    }
  });

  // ── Java ───────────────────────────────────────────────────────────
  it("should chunk Java with classes, interfaces, enums, methods", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.java"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("UserAccount");
    expect(names).toContain("Authenticatable");
    expect(names).toContain("Role");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("java");
    }
  });

  // ── Ruby ───────────────────────────────────────────────────────────
  it("should chunk Ruby with classes, modules, methods", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.rb"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("HttpClient");
    expect(names).toContain("Logging");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("ruby");
    }
  });

  // ── C ──────────────────────────────────────────────────────────────
  it("should chunk C with functions, structs, enums, typedefs", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.c"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    // C declarator names include the full signature
    expect(names.some((n) => n.includes("create_node"))).toBe(true);
    expect(names.some((n) => n.includes("list_append"))).toBe(true);
    expect(names.some((n) => n.includes("list_free"))).toBe(true);
    // Structs and enums should be found
    expect(names).toContain("Node");
    expect(names).toContain("Status");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("c");
    }
  });

  // ── C++ ────────────────────────────────────────────────────────────
  it("should chunk C++ with functions, classes, structs, enums, namespaces", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.cpp"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    // C++ declarator names include the full signature
    expect(names.some((n) => n.includes("renderScene"))).toBe(true);
    expect(names).toContain("geometry");
    expect(names).toContain("Canvas");
    expect(names).toContain("Vec2");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("cpp");
    }
  });

  // ── C# ─────────────────────────────────────────────────────────────
  it("should chunk C# with classes, interfaces, structs, enums, methods", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.cs"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("TaskItem");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("csharp");
    }
  });

  // ── PHP ────────────────────────────────────────────────────────────
  it("should chunk PHP with functions, classes, interfaces, traits", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.php"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("Article");
    expect(names).toContain("slugify");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("php");
    }
  });

  // ── Swift ──────────────────────────────────────────────────────────
  it("should chunk Swift with functions, classes, structs, protocols, enums", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.swift"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("WeatherStation");
    expect(names).toContain("createStation");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("swift");
    }
  });

  // ── Kotlin ─────────────────────────────────────────────────────────
  it("should chunk Kotlin with functions, classes, objects, interfaces", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.kt"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("EmailValidator");
    expect(names).toContain("AppConfig");
    expect(names).toContain("retry");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("kotlin");
    }
  });

  // ── Scala ──────────────────────────────────────────────────────────
  it("should chunk Scala with functions, classes, objects, traits", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.scala"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("EventBus");
    expect(names).toContain("Registry");
    expect(names).toContain("Serializable");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("scala");
    }
  });

  // ── Zig ────────────────────────────────────────────────────────────
  it("should chunk Zig with functions and test declarations", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.zig"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("fibonacci");
    // Test declarations should extract the test name from the string
    expect(names).toContain("fibonacci returns correct values");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("zig");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  // ── Bash ───────────────────────────────────────────────────────────
  it("should chunk Bash with function definitions", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.sh"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("deploy");
    expect(names).toContain("cleanup");
    expect(names).toContain("check_health");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("bash");
    }
  });

  // ── Lua ────────────────────────────────────────────────────────────
  it("should chunk Lua with function declarations and definitions", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.lua"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);
    const names = chunks.map((c) => c.name);

    expect(names).toContain("vec_add");
    expect(names).toContain("vec_scale");

    for (const chunk of chunks) {
      expect(chunk.language).toBe("lua");
    }
  });

  // ── HTML ───────────────────────────────────────────────────────────
  it("should chunk HTML with elements", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.html"),
      FIXTURES
    );

    // HTML may produce a whole-file chunk or element-level chunks
    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect(chunk.language).toBe("html");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  // ── Vue ────────────────────────────────────────────────────────────
  it("should chunk Vue with template, script, style elements", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.vue"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect(chunk.language).toBe("vue");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  // ── CSS ────────────────────────────────────────────────────────────
  it("should chunk CSS with rule sets, media queries, keyframes", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.css"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect(chunk.language).toBe("css");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  // ── TOML ───────────────────────────────────────────────────────────
  it("should chunk TOML with tables and table arrays", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.toml"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect(chunk.language).toBe("toml");
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  // ── Cross-language invariants ──────────────────────────────────────
  it("should produce stable IDs across all languages", async () => {
    const languages = [
      "sample.tsx", "sample.js", "sample.go", "sample.rs",
      "sample.java", "sample.rb", "sample.c", "sample.cpp",
      "sample.cs", "sample.php", "sample.swift", "sample.kt",
      "sample.scala", "sample.zig", "sample.sh", "sample.lua",
      "sample.html", "sample.vue", "sample.css", "sample.toml",
    ];

    for (const file of languages) {
      const { chunks: run1 } = await chunkFileWithCalls(
        resolve(FIXTURES, file),
        FIXTURES
      );
      const { chunks: run2 } = await chunkFileWithCalls(
        resolve(FIXTURES, file),
        FIXTURES
      );

      expect(run1.map((c) => c.id)).toEqual(run2.map((c) => c.id));
    }
  });

  it("every chunk should have required fields regardless of language", async () => {
    const languages = [
      "sample.tsx", "sample.js", "sample.go", "sample.rs",
      "sample.java", "sample.rb", "sample.c", "sample.cpp",
      "sample.cs", "sample.php", "sample.swift", "sample.kt",
      "sample.scala", "sample.zig", "sample.sh", "sample.lua",
      "sample.html", "sample.vue", "sample.css", "sample.toml",
    ];

    for (const file of languages) {
      const { chunks } = await chunkFileWithCalls(
        resolve(FIXTURES, file),
        FIXTURES
      );

      for (const chunk of chunks) {
        expect(chunk.id, `${file}: missing id`).toBeTruthy();
        expect(chunk.filePath, `${file}: missing filePath`).toBeTruthy();
        expect(chunk.content.length, `${file}: empty content`).toBeGreaterThan(0);
        expect(chunk.startLine, `${file}: invalid startLine`).toBeGreaterThan(0);
        expect(chunk.endLine, `${file}: endLine < startLine`).toBeGreaterThanOrEqual(chunk.startLine);
        expect(chunk.kind, `${file}: missing kind`).toBeTruthy();
        expect(chunk.name, `${file}: missing name`).toBeTruthy();
      }
    }
  });
});
