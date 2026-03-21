import { describe, it, expect } from "vitest";
import { sanitizeQuery } from "../../src/daemon/server.js";

describe("sanitizeQuery", () => {
  // --- Basic natural language ---

  it("passes through simple natural language", () => {
    expect(sanitizeQuery("how does authentication work")).toBe(
      "how does authentication work"
    );
  });

  it("joins multiple natural language lines", () => {
    expect(
      sanitizeQuery("how does authentication work\nwhat about authorization")
    ).toBe("how does authentication work what about authorization");
  });

  // --- Code-only input returns empty ---

  it("returns empty for import-only input", () => {
    expect(sanitizeQuery("import { foo } from 'bar'")).toBe("");
  });

  it("returns empty for const-only input", () => {
    expect(sanitizeQuery("const x = 1")).toBe("");
  });

  // --- Multi-line: NL first, code after (old break-based bug) ---

  it("strips code lines but keeps NL before AND after code", () => {
    const input = [
      "how does auth work",
      "import { foo } from 'bar'",
      "what about sessions",
    ].join("\n");
    // Old implementation would break at line 2 and lose "what about sessions".
    // New implementation skips code lines and keeps both NL lines.
    expect(sanitizeQuery(input)).toBe("how does auth work what about sessions");
  });

  // --- Backtick-fenced code blocks ---

  it("strips fenced code blocks and keeps surrounding NL", () => {
    const input = [
      "explain this function",
      "```typescript",
      "function hello() {",
      "  return 'world';",
      "}",
      "```",
      "how does it work",
    ].join("\n");
    const result = sanitizeQuery(input);
    expect(result).toContain("explain this function");
    expect(result).toContain("how does it work");
    expect(result).not.toContain("return");
    expect(result).not.toContain("hello");
  });

  it("strips bare fenced code blocks (no language tag)", () => {
    const input = "check this\n```\nconst x = 1;\n```\nplease";
    const result = sanitizeQuery(input);
    expect(result).toContain("check this");
    expect(result).toContain("please");
    expect(result).not.toContain("const");
  });

  // --- Inline code spans ---

  it("strips inline code spans", () => {
    const input = "what does `const x = foo()` do in the auth module";
    const result = sanitizeQuery(input);
    expect(result).not.toContain("const x");
    expect(result).toContain("what does");
    expect(result).toContain("auth module");
  });

  // --- Expanded code pattern coverage ---

  it("skips return statements", () => {
    expect(sanitizeQuery("return value")).toBe("");
  });

  it("skips export statements", () => {
    expect(sanitizeQuery("export default App")).toBe("");
  });

  it("skips if/for/while control flow", () => {
    expect(sanitizeQuery("if (x > 0) {")).toBe("");
    expect(sanitizeQuery("for (let i = 0; i < n; i++)")).toBe("");
    expect(sanitizeQuery("while (true)")).toBe("");
  });

  it("skips C preprocessor directives", () => {
    expect(sanitizeQuery("#include <stdio.h>")).toBe("");
    expect(sanitizeQuery("#define MAX 100")).toBe("");
  });

  // --- Symbol-heavy lines ---

  it("skips lines that are mostly symbols (length > 4)", () => {
    // Short symbol strings (<=4 chars) pass through since they're too
    // small to be meaningful code and the filter only activates for
    // strings longer than 4 characters to avoid false positives.
    expect(sanitizeQuery("{{{}}}")).toBe("");
    expect(sanitizeQuery("=====")).toBe("");
    expect(sanitizeQuery("}); }); });")).toBe("");
  });

  // --- Escaped quotes (should not confuse the parser) ---

  it("handles escaped quotes in otherwise NL text", () => {
    const input = 'how does the "auth" module handle user\'s login';
    const result = sanitizeQuery(input);
    expect(result).toContain("auth");
    expect(result).toContain("login");
  });

  // --- Truncation ---

  it("truncates to 500 characters", () => {
    const longQuery = "a ".repeat(300);
    expect(sanitizeQuery(longQuery).length).toBeLessThanOrEqual(500);
  });

  // --- Edge cases ---

  it("returns empty for empty string", () => {
    expect(sanitizeQuery("")).toBe("");
  });

  it("returns empty for whitespace-only input", () => {
    expect(sanitizeQuery("   \n  \n  ")).toBe("");
  });

  it("handles unclosed fenced code blocks gracefully", () => {
    // If fenced block is never closed, the regex won't match and lines
    // will be processed individually (code lines skipped by CODE_LINE_RE)
    const input = "explain this\n```\nconst x = 1;\nmore code here";
    const result = sanitizeQuery(input);
    expect(result).toContain("explain this");
    // "more code here" is not a recognized code pattern, so it passes through
    expect(result).toContain("more code here");
  });

  // --- System tag stripping ---

  it("strips <task-notification> block, preserving surrounding user text", () => {
    const input =
      "how does auth work <task-notification>some internal task info</task-notification> explain sessions";
    const result = sanitizeQuery(input);
    expect(result).toContain("how does auth work");
    expect(result).toContain("explain sessions");
    expect(result).not.toContain("internal task info");
  });

  it("strips <system-reminder> block, preserving surrounding user text", () => {
    const input = [
      "explain the search module",
      "<system-reminder>",
      "Claude Code instructions and context here",
      "with multiple lines of system content",
      "</system-reminder>",
      "what about ranking",
    ].join("\n");
    const result = sanitizeQuery(input);
    expect(result).toContain("explain the search module");
    expect(result).toContain("what about ranking");
    expect(result).not.toContain("Claude Code instructions");
  });

  it("returns empty when input is only system tags", () => {
    const input =
      "<system-reminder>all system content</system-reminder><task-notification>more system</task-notification>";
    expect(sanitizeQuery(input)).toBe("");
  });

  it("strips system tags but keeps user text and code fragments mixed in", () => {
    const input = [
      "how does the parser work",
      "<system-reminder>injected context block</system-reminder>",
      "<tool-result>tool call output here</tool-result>",
      "what about chunking",
    ].join("\n");
    const result = sanitizeQuery(input);
    expect(result).toContain("how does the parser work");
    expect(result).toContain("what about chunking");
    expect(result).not.toContain("injected context");
    expect(result).not.toContain("tool call output");
  });

  // --- Non-XML system boilerplate stripping ---

  it("strips 'Read the output file' task-output instructions", () => {
    const input = [
      "add logging to auth flow",
      "Read the output file to retrieve the result: /private/tmp/claude-task-abc123.txt",
      "/private/tmp/claude-task-abc123.txt",
    ].join("\n");
    const result = sanitizeQuery(input);
    expect(result).toContain("add logging to auth flow");
    expect(result).not.toContain("Read the output file");
    expect(result).not.toContain("/private/tmp");
  });

  it("strips bare temp-dir paths (/private/tmp, /var/folders, /tmp)", () => {
    const input = [
      "explain the search module",
      "/var/folders/xr/abc123/T/claude-output.json",
      "/tmp/some-temp-file.txt",
      "what about ranking",
    ].join("\n");
    const result = sanitizeQuery(input);
    expect(result).toContain("explain the search module");
    expect(result).toContain("what about ranking");
    expect(result).not.toContain("/var/folders");
    expect(result).not.toContain("/tmp/some");
  });

  it("returns empty when input is only system boilerplate", () => {
    const input = [
      "Read the output file to retrieve the result: /private/tmp/out.txt",
      "/private/tmp/out.txt",
    ].join("\n");
    expect(sanitizeQuery(input)).toBe("");
  });

  it("strips mixed XML tags and boilerplate, keeps user text", () => {
    const input = [
      "<system-reminder>system stuff here</system-reminder>",
      "Read the output file to retrieve the result: /private/tmp/task.txt",
      "/private/tmp/task.txt",
      "how does the auth middleware work",
    ].join("\n");
    const result = sanitizeQuery(input);
    expect(result).toBe("how does the auth middleware work");
  });

  it("strips trailing harness script contamination from Claude hook payloads", () => {
    const input = [
      "What MCP tools are exposed by the memory server in this repo?",
      "import json, pathlib, subprocess, tempfile, shutil, time",
      "REPO = pathlib.Path('/Users/example/project')",
      "if not CLAUDE: raise SystemExit('no claude')",
      "subprocess.run(['claude', '-p', 'hello prompt'], check=True)",
      "print(log.read_text())",
    ].join("\n");

    expect(sanitizeQuery(input)).toBe(
      "What MCP tools are exposed by the memory server in this repo?"
    );
  });
});
