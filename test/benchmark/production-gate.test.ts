import { describe, expect, it } from "vitest";
import {
  extractSelectedFiles,
  normalizeMode,
  scorePromptResult,
  type ProductionQuery,
} from "../../scripts/benchmarks/production-gate-lib.js";

describe("production gate helpers", () => {
  it("extracts selected files from selectedFiles first and falls back to chunks", () => {
    expect(extractSelectedFiles({
      selectedFiles: [{ filePath: "src/a.ts" }, { filePath: "src/a.ts" }, { filePath: "src/b.ts" }],
      chunks: [{ filePath: "src/c.ts" }],
    })).toEqual(["src/a.ts", "src/b.ts"]);

    expect(extractSelectedFiles({
      chunks: [{ filePath: "src/c.ts" }, { filePath: "src/d.ts" }],
    })).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("normalizes local query modes and legacy routes", () => {
    expect(normalizeMode({ queryMode: "bug" })).toBe("bug");
    expect(normalizeMode({ route: "R0" })).toBe("lookup");
    expect(normalizeMode({ route: "R1" })).toBe("trace");
    expect(normalizeMode({ route: "R2" })).toBe("architecture");
  });

  it("scores prompts with must-include and must-not-include rules", () => {
    const query: ProductionQuery = {
      id: "auth-redirect",
      query: "why does auth redirect fail",
      expectedMode: "bug",
      relevance: {
        "src/pages/AuthCallback.tsx": 3,
        "src/hooks/useAuth.tsx": 2,
      },
      mustInclude: ["src/pages/AuthCallback.tsx"],
      mustNotInclude: ["src/controllers/CreditController.ts"],
    };

    const pass = scorePromptResult(query, {
      queryMode: "bug",
      selectedFiles: [
        { filePath: "src/pages/AuthCallback.tsx" },
        { filePath: "src/hooks/useAuth.tsx" },
      ],
    });
    expect(pass.verdict).toBe("pass");
    expect(pass.modeMatched).toBe(true);

    const partial = scorePromptResult(query, {
      route: "R2",
      chunks: [
        { filePath: "src/pages/AuthCallback.tsx" },
        { filePath: "src/components/AuthModal.tsx" },
      ],
    });
    expect(partial.verdict).toBe("partial");
    expect(partial.modeMatched).toBe(false);

    const fail = scorePromptResult(query, {
      queryMode: "bug",
      selectedFiles: [
        { filePath: "src/controllers/CreditController.ts" },
      ],
    });
    expect(fail.verdict).toBe("fail");
    expect(fail.mustNotIncludeHits).toEqual(["src/controllers/CreditController.ts"]);
  });
});
