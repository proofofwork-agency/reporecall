import { describe, it, expect } from "vitest";
import { escapeSqlString } from "../../src/storage/vector-store.js";

describe("escapeSqlString", () => {
  it("returns plain strings unchanged", () => {
    expect(escapeSqlString("hello")).toBe("hello");
    expect(escapeSqlString("src/auth.ts")).toBe("src/auth.ts");
  });

  it("doubles single quotes", () => {
    expect(escapeSqlString("it's")).toBe("it''s");
    expect(escapeSqlString("'quoted'")).toBe("''quoted''");
  });

  it("handles multiple single quotes in a row", () => {
    expect(escapeSqlString("a'''b")).toBe("a''''''b");
  });

  it("strips null bytes", () => {
    expect(escapeSqlString("abc\x00def")).toBe("abcdef");
  });

  it("strips newlines and carriage returns", () => {
    expect(escapeSqlString("line1\nline2")).toBe("line1line2");
    expect(escapeSqlString("line1\r\nline2")).toBe("line1line2");
  });

  it("strips tabs and other C0 control characters", () => {
    expect(escapeSqlString("a\tb")).toBe("ab");
    expect(escapeSqlString("a\x01\x02\x03b")).toBe("ab");
  });

  it("strips C1 control characters (U+007F-U+009F)", () => {
    expect(escapeSqlString("a\x7fb")).toBe("ab");
    expect(escapeSqlString("a\x80\x9fb")).toBe("ab");
  });

  it("preserves unicode beyond C1 range", () => {
    expect(escapeSqlString("cafe\u0301")).toBe("cafe\u0301");
    expect(escapeSqlString("src/\u00e9tude.ts")).toBe("src/\u00e9tude.ts");
  });

  it("does NOT use backslash escaping (backslash is literal in DuckDB SQL)", () => {
    // A backslash in the input should remain as-is, not be doubled
    expect(escapeSqlString("C:\\Users\\test")).toBe("C:\\Users\\test");
  });

  it("does NOT double-escape double quotes (irrelevant for single-quoted literals)", () => {
    expect(escapeSqlString('say "hello"')).toBe('say "hello"');
  });

  it("handles the injection attempt: value ending with escaped quote", () => {
    // An attacker tries: file' OR 1=1 --
    const malicious = "file' OR 1=1 --";
    const escaped = escapeSqlString(malicious);
    // The single quote is doubled, making it a literal quote inside the string
    expect(escaped).toBe("file'' OR 1=1 --");
    // When used as: filePath = '<escaped>', it becomes:
    // filePath = 'file'' OR 1=1 --'  which is the literal string "file' OR 1=1 --"
  });

  it("handles combined injection with control chars and quotes", () => {
    const malicious = "test\n' OR '1'='1";
    const escaped = escapeSqlString(malicious);
    expect(escaped).toBe("test'' OR ''1''=''1");
  });

  it("throws on non-string input", () => {
    expect(() => escapeSqlString(null as unknown as string)).toThrow(
      "expected a string value"
    );
    expect(() => escapeSqlString(undefined as unknown as string)).toThrow(
      "expected a string value"
    );
    expect(() => escapeSqlString(42 as unknown as string)).toThrow(
      "expected a string value"
    );
  });

  it("handles empty string", () => {
    expect(escapeSqlString("")).toBe("");
  });
});
