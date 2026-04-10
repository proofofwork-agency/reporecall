import { Command } from "commander";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createServer, type Server } from "http";
import { execFile } from "child_process";
import { detectProjectRoot } from "../core/project.js";
import { loadConfig } from "../core/config.js";
import { generateVisualization } from "../visualize/index.js";

function openInBrowser(target: string): void {
  const onError = (err: Error | null) => {
    if (err) console.log("Could not open browser. Open manually:", target);
  };
  if (process.platform === "darwin") {
    execFile("open", [target], onError);
  } else if (process.platform === "win32") {
    // `start` is a cmd.exe builtin, not an executable. The empty string
    // is the window title (required because start treats the first quoted
    // arg as the title), followed by the target path or URL.
    execFile("cmd", ["/c", "start", "", target], onError);
  } else {
    execFile("xdg-open", [target], onError);
  }
}

/**
 * Start a minimal HTTP server that serves a generated lens HTML file.
 * Exported for testing — the CLI wraps this with signal handlers and a
 * blocking wait. Callers are responsible for closing the returned server.
 */
export async function startLensServer(
  htmlPath: string,
  port: number,
): Promise<{ server: Server; url: string; port: number }> {
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    const url = req.url || "/";
    if (url === "/" || url === "/index.html" || url === "/lens.html") {
      try {
        const html = readFileSync(htmlPath, "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Failed to read dashboard: ${(err as Error).message}`);
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://localhost:${actualPort}/`;
  return { server, url, port: actualPort };
}

async function serveDashboard(htmlPath: string, port: number, open: boolean): Promise<void> {
  const { server, url } = await startLensServer(htmlPath, port);
  console.log(`Serving dashboard at ${url}`);
  console.log("Press Ctrl+C to stop.");

  if (open) {
    openInBrowser(url);
  }

  const shutdown = () => {
    console.log("\nShutting down server...");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive until the server closes.
  await new Promise<void>((resolvePromise) => {
    server.once("close", () => resolvePromise());
  });
}

export function lensCommand(): Command {
  return new Command("lens")
    .description("Generate interactive architecture dashboard")
    .option("--project <path>", "Project root path")
    .option("--output <path>", "Output HTML file path")
    .option("--open", "Open in default browser after generation")
    .option("--serve", "Serve the dashboard over HTTP on localhost")
    .option("--port <n>", "Port to serve on (with --serve)", "7878")
    .option("--json", "Output raw JSON data instead of HTML")
    .option("--max-hubs <n>", "Maximum hub nodes to include", "15")
    .option("--max-surprises <n>", "Maximum surprises to include", "20")
    .option("--max-communities <n>", "Maximum communities to include", "20")
    .action(async (options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd());

      const config = loadConfig(projectRoot);

      if (!existsSync(resolve(config.dataDir, "metadata.db"))) {
        console.log('No index found. Run "reporecall index" first.');
        return;
      }

      const { outputPath, data } = await generateVisualization({
        projectRoot,
        outputPath: options.output ? resolve(options.output) : undefined,
        maxHubs: parseInt(options.maxHubs, 10),
        maxSurprises: parseInt(options.maxSurprises, 10),
        maxCommunities: parseInt(options.maxCommunities, 10),
        json: !!options.json,
      });

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(`Dashboard generated: ${outputPath}`);
      console.log(
        `  ${data.meta.totalSymbols} symbols, ${data.meta.communityCount} communities, ` +
        `${data.meta.hubCount} hubs, ${data.meta.surpriseCount} surprises, ` +
        `${data.meta.wikiPageCount} wiki pages`
      );

      if (options.serve) {
        const port = parseInt(options.port, 10);
        if (!Number.isFinite(port) || port < 0 || port > 65535) {
          console.log(`Invalid port: ${options.port}`);
          process.exit(1);
        }
        await serveDashboard(outputPath, port, !!options.open);
        return;
      }

      if (options.open) {
        openInBrowser(outputPath);
      }
    });
}
