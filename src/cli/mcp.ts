import { Command } from "commander";
import { resolve } from "path";
import { detectProjectRoot } from "../core/project.js";
import { loadConfig } from "../core/config.js";
import { IndexingPipeline } from "../indexer/pipeline.js";
import { HybridSearch } from "../search/hybrid.js";
import { createMCPServer } from "../daemon/mcp-server.js";

export function mcpCommand(): Command {
  return new Command("mcp")
    .description("Start MCP server (stdio transport)")
    .option("--project <path>", "Project root path")
    .action(async (options) => {
      // Redirect console to stderr FIRST — before any code can write to stdout
      console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
      console.error = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd());

      const config = loadConfig(projectRoot);

      const pipeline = new IndexingPipeline(config);

      const search = new HybridSearch(
        pipeline.getEmbedder(),
        pipeline.getVectorStore(),
        pipeline.getFTSStore(),
        pipeline.getMetadataStore(),
        config
      );

      const server = createMCPServer(
        search,
        pipeline,
        pipeline.getMetadataStore(),
        config
      );

      await server.connect(
        new (await import("@modelcontextprotocol/sdk/server/stdio.js")).StdioServerTransport()
      );

      console.log("MCP server running on stdio");

      const shutdown = async () => {
        await server.close();
        pipeline.close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
