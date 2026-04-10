import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import { startLensServer } from "../../src/cli/lens.js";

const FIXTURE_HTML = "<!doctype html><html><body>hello lens</body></html>";

let tmpDir: string;
let htmlPath: string;
let server: Server | null = null;
let baseUrl = "";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "reporecall-lens-serve-"));
  htmlPath = join(tmpDir, "lens.html");
  writeFileSync(htmlPath, FIXTURE_HTML, "utf-8");
  // port: 0 requests an ephemeral free port from the OS
  const started = await startLensServer(htmlPath, 0);
  server = started.server;
  baseUrl = started.url.replace(/\/$/, "");
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolvePromise) => server!.close(() => resolvePromise()));
    server = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("lens --serve", () => {
  it("serves the generated HTML at GET /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toBe(FIXTURE_HTML);
  });

  it("also serves the HTML at /index.html and /lens.html", async () => {
    for (const path of ["/index.html", "/lens.html"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `path ${path}`).toBe(200);
      expect(await res.text()).toBe(FIXTURE_HTML);
    }
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("returns 405 for non-GET methods", async () => {
    const res = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("reflects freshly updated file content (no caching)", async () => {
    writeFileSync(htmlPath, "<!doctype html><p>updated</p>", "utf-8");
    const res = await fetch(`${baseUrl}/`);
    expect(await res.text()).toBe("<!doctype html><p>updated</p>");
  });

  it("returns 500 when the HTML file is missing", async () => {
    rmSync(htmlPath);
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(500);
  });

  it("binds to 127.0.0.1 (localhost)", () => {
    expect(baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
  });
});
