import { describe, expect, it } from "vitest";
import { textMatchesQueryTerm } from "../../src/search/utils.js";

describe("textMatchesQueryTerm", () => {
  it("matches camelCase auth identifiers via compact identifier matching", () => {
    expect(textMatchesQueryTerm("src/hooks/useAuth.tsx useAuth", "auth")).toBe(true);
    expect(textMatchesQueryTerm("src/pages/AuthCallback.tsx AuthCallback", "callback")).toBe(true);
  });

  it("does not match unrelated signed words as auth aliases", () => {
    expect(
      textMatchesQueryTerm(
        "src/lib/flow/handlers/brandKitHandler.ts getSignedLogoUrl",
        "signin"
      )
    ).toBe(false);
    expect(
      textMatchesQueryTerm(
        "src/lib/flow/handlers/brandKitHandler.ts getSignedLogoUrl",
        "signout"
      )
    ).toBe(false);
  });

  it("does not match embedded router substrings inside unrelated identifiers", () => {
    expect(
      textMatchesQueryTerm(
        "src/lib/api/openrouter.ts openrouter",
        "router"
      )
    ).toBe(false);
  });
});
