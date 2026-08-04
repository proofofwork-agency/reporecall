import { describe, it, expect, vi } from "vitest";
import { extname } from "path";
import { FileWatcher } from "../../src/daemon/watcher.js";

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

  it("quiesces pending callbacks without closing the native watcher", () => {
    const callback = vi.fn();
    const watcher = new FileWatcher({} as never, callback);
    const internals = watcher as unknown as {
      stopped: boolean;
      pendingChanges: Array<{ path: string; type: "change" }>;
      debounceTimer: ReturnType<typeof setTimeout> | undefined;
      maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
    };
    internals.pendingChanges = [{ path: "src/app.ts", type: "change" }];
    internals.debounceTimer = setTimeout(callback, 10_000);
    internals.maxWaitTimer = setTimeout(callback, 10_000);

    watcher.prepareToStop();

    expect(internals.stopped).toBe(true);
    expect(internals.pendingChanges).toEqual([]);
    expect(internals.debounceTimer).toBeUndefined();
    expect(internals.maxWaitTimer).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });
});
