import { describe, it, expect } from "vitest";
import { relative, extname } from "path";

// Test that the ignore filtering logic works correctly
// This tests the pattern matching without creating actual file watchers

describe("watcher ignore filtering", () => {
  it("should filter files by extension", () => {
    const extensionSet = new Set([".ts", ".js", ".py"]);
    const testPaths = [
      { path: "src/app.ts", expected: true },
      { path: "src/app.js", expected: true },
      { path: "src/app.py", expected: true },
      { path: "src/image.png", expected: false },
      { path: "data.csv", expected: false },
    ];

    for (const { path, expected } of testPaths) {
      const ext = extname(path);
      expect(extensionSet.has(ext), `${path} should ${expected ? "" : "not "}pass extension filter`).toBe(expected);
    }
  });

  it("should filter ignored patterns", async () => {
    const ignore = (await import("ignore")).default;
    const ig = ignore();
    ig.add(["node_modules", ".git", ".memory", "dist", "build"]);

    const shouldIgnore = [
      "node_modules/foo/bar.ts",
      ".git/HEAD",
      "dist/index.js",
    ];
    const shouldPass = [
      "src/app.ts",
      "lib/utils.ts",
    ];

    for (const p of shouldIgnore) {
      expect(ig.ignores(p), `${p} should be ignored`).toBe(true);
    }
    for (const p of shouldPass) {
      expect(ig.ignores(p), `${p} should not be ignored`).toBe(false);
    }
  });
});
