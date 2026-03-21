import { describe, expect, it } from "vitest";
import { parseMemoryFile } from "../../src/memory/parser.js";

describe("parseMemoryFile", () => {
  it("parses valid frontmatter with all required fields", () => {
    const raw = `---
name: feedback_no_coauthor
description: Do not add Co-Authored-By Claude tag to commits
type: feedback
---

Do not add the Co-Authored-By line when creating commits.

**Why:** User explicitly requested this.
**How to apply:** Skip the Co-Authored-By trailer in all commit messages.
`;

    const result = parseMemoryFile(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("feedback_no_coauthor");
    expect(result!.description).toBe("Do not add Co-Authored-By Claude tag to commits");
    expect(result!.type).toBe("feedback");
    expect(result!.content).toContain("Do not add the Co-Authored-By line");
    expect(result!.content).toContain("**Why:**");
  });

  it("returns null for missing frontmatter", () => {
    const raw = "Just some plain text without frontmatter.";
    expect(parseMemoryFile(raw)).toBeNull();
  });

  it("returns null for missing required fields", () => {
    const raw = `---
name: test
description: test desc
---

Content here.
`;
    // Missing type field
    expect(parseMemoryFile(raw)).toBeNull();
  });

  it("returns null for invalid type", () => {
    const raw = `---
name: test
description: test desc
type: invalid_type
---

Content here.
`;
    expect(parseMemoryFile(raw)).toBeNull();
  });

  it("returns null for empty content", () => {
    const raw = `---
name: test
description: test desc
type: user
---
`;
    expect(parseMemoryFile(raw)).toBeNull();
  });

  it("parses all valid memory types", () => {
    for (const type of ["user", "feedback", "project", "reference"]) {
      const raw = `---
name: test_${type}
description: Test ${type} memory
type: ${type}
---

Some content for ${type}.
`;
      const result = parseMemoryFile(raw);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(type);
    }
  });

  it("handles extra whitespace in frontmatter", () => {
    const raw = `---
name:   spaced_name
description:   A description with spaces
type:   feedback
---

Content body.
`;
    const result = parseMemoryFile(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("spaced_name");
    expect(result!.description).toBe("A description with spaces");
  });

  it("handles quoted frontmatter values", () => {
    const raw = `---
name: "quoted_name"
description: "A description with \\"quotes\\""
type: "project"
---

Quoted content.
`;

    const result = parseMemoryFile(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("quoted_name");
    expect(result!.description).toBe('A description with "quotes"');
    expect(result!.type).toBe("project");
  });

  it("parses optional memory metadata fields", () => {
    const raw = `---
name: "feedback_no_coauthor"
description: "Do not add Co-Authored-By Claude tag to commits"
type: "feedback"
class: "rule"
scope: "global"
status: "active"
summary: "Do not add coauthor trailer"
sourceKind: "reporecall_local"
fingerprint: "abc123"
pinned: "true"
relatedFiles: ["src/cli/init.ts", "src/daemon/mcp-server.ts"]
relatedSymbols: handlePromptContext, createMCPServer
supersedesId: "old-id"
confidence: "0.85"
reason: "Imported from local project notes"
---

Memory body.
`;

    const result = parseMemoryFile(raw);
    expect(result).not.toBeNull();
    expect(result!.class).toBe("rule");
    expect(result!.scope).toBe("global");
    expect(result!.status).toBe("active");
    expect(result!.summary).toBe("Do not add coauthor trailer");
    expect(result!.sourceKind).toBe("reporecall_local");
    expect(result!.fingerprint).toBe("abc123");
    expect(result!.pinned).toBe(true);
    expect(result!.relatedFiles).toEqual(["src/cli/init.ts", "src/daemon/mcp-server.ts"]);
    expect(result!.relatedSymbols).toEqual(["handlePromptContext", "createMCPServer"]);
    expect(result!.supersedesId).toBe("old-id");
    expect(result!.confidence).toBe(0.85);
    expect(result!.reason).toBe("Imported from local project notes");
  });
});
