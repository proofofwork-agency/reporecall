import Parser from "web-tree-sitter";
import { resolve, dirname, join } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { LANGUAGE_CONFIGS } from "./languages.js";
import { getLogger } from "../core/logger.js";

let initPromise: Promise<void> | undefined;
const loadedLanguages = new Map<string, Promise<Parser.Language | undefined>>();

export async function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

function findWasmPath(wasmName: string): string | undefined {
  const wasmFile = `${wasmName}.wasm`;

  // 1. Try require.resolve — works with npm, pnpm, yarn (all layouts)
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("tree-sitter-wasms/package.json");
    const candidate = join(dirname(pkgJson), "out", wasmFile);
    if (existsSync(candidate)) return candidate;
  } catch {
    // package not resolvable from here — fall through
  }

  // 2. Fallback: cwd-relative (classic npm flat layout)
  const cwdCandidate = resolve("node_modules", "tree-sitter-wasms", "out", wasmFile);
  if (existsSync(cwdCandidate)) return cwdCandidate;

  // 3. Fallback: relative to this file's package (npm nested node_modules)
  const pkgCandidate = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "node_modules",
    "tree-sitter-wasms",
    "out",
    wasmFile
  );
  if (existsSync(pkgCandidate)) return pkgCandidate;

  return undefined;
}

export async function getLanguage(
  languageName: string
): Promise<Parser.Language | undefined> {
  if (!loadedLanguages.has(languageName)) {
    loadedLanguages.set(languageName, (async () => {
      await initTreeSitter();
      const config = LANGUAGE_CONFIGS[languageName];
      if (!config) return undefined;
      const wasmPath = findWasmPath(config.wasmName);
      if (!wasmPath) return undefined;
      try {
        return await Parser.Language.load(wasmPath);
      } catch (err) {
        getLogger().warn(`Failed to load WASM grammar for "${languageName}": ${err}`);
        loadedLanguages.delete(languageName);
        return undefined;
      }
    })());
  }
  return loadedLanguages.get(languageName)!;
}

export function createParser(language: Parser.Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
