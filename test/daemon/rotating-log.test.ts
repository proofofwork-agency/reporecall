import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RotatingLog } from "../../src/daemon/rotating-log.js";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("RotatingLog", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rotating-log-test-"));
    logPath = join(dir, "test.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes under threshold without rotation", async () => {
    const log = new RotatingLog(logPath, 1024, 3);
    await log.append("hello\n");
    await log.append("world\n");

    const content = readFileSync(logPath, "utf-8");
    expect(content).toBe("hello\nworld\n");
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it("rotates when size exceeded", async () => {
    const log = new RotatingLog(logPath, 20, 3); // 20 byte threshold
    await log.append("12345678901234567890"); // 20 bytes — fills it
    await log.append("overflow"); // triggers rotation

    expect(existsSync(`${logPath}.1`)).toBe(true);
    const rotatedContent = readFileSync(`${logPath}.1`, "utf-8");
    expect(rotatedContent).toBe("12345678901234567890");

    const newContent = readFileSync(logPath, "utf-8");
    expect(newContent).toBe("overflow");
  });

  it("renames old files in correct sequence", async () => {
    const log = new RotatingLog(logPath, 10, 3);

    await log.append("aaaaaaaaaa"); // 10 bytes
    await log.append("bbbbbbbbbb"); // rotates, current -> .1
    await log.append("cccccccccc"); // rotates, .1 -> .2, current -> .1
    await log.append("dddddddddd"); // rotates, .2 -> .3, .1 -> .2, current -> .1

    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("cccccccccc");
    expect(readFileSync(`${logPath}.2`, "utf-8")).toBe("bbbbbbbbbb");
    expect(readFileSync(`${logPath}.3`, "utf-8")).toBe("aaaaaaaaaa");
    expect(readFileSync(logPath, "utf-8")).toBe("dddddddddd");
  });

  it("respects max file count (oldest deleted)", async () => {
    const log = new RotatingLog(logPath, 10, 2); // max 2 old files

    await log.append("aaaaaaaaaa"); // fills
    await log.append("bbbbbbbbbb"); // rotates: current -> .1
    await log.append("cccccccccc"); // rotates: .1 -> .2, current -> .1
    await log.append("dddddddddd"); // rotates: .2 deleted, .1 -> .2, current -> .1

    expect(existsSync(`${logPath}.3`)).toBe(false);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("cccccccccc");
    expect(readFileSync(`${logPath}.2`, "utf-8")).toBe("bbbbbbbbbb");
    expect(readFileSync(logPath, "utf-8")).toBe("dddddddddd");
  });
});
