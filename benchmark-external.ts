#!/usr/bin/env npx tsx

import { writeFileSync } from "fs";
import { join } from "path";
import {
  printExternalResults,
  runExternalBenchmark,
} from "./test/benchmark/external-runner.js";

type Provider = "keyword" | "semantic";

async function main() {
  const args = process.argv.slice(2);
  let outputPath: string | undefined;
  let fixturePath: string | undefined;
  let providerArg: Provider = "keyword";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
      continue;
    }
    if (args[i] === "--provider" && args[i + 1]) {
      providerArg = args[i + 1] as Provider;
      i++;
      continue;
    }
    if (args[i] === "--fixture" && args[i + 1]) {
      fixturePath = args[i + 1];
      i++;
    }
  }

  const validProviders = ["keyword", "semantic"];
  if (!validProviders.includes(providerArg)) {
    console.error(`Invalid provider: ${providerArg}. Use: keyword or semantic`);
    process.exit(1);
  }

  const results = await runExternalBenchmark(providerArg, fixturePath);
  printExternalResults(results);

  const jsonPath = outputPath ?? join(process.cwd(), "external-benchmark-results.json");
  writeFileSync(jsonPath, JSON.stringify({ timestamp: new Date().toISOString(), external: results }, null, 2));
  console.log(`\nResults written to: ${jsonPath}`);
}

main().catch((err) => {
  console.error("External benchmark failed:", err);
  process.exit(1);
});
