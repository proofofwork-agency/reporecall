import Parser from "web-tree-sitter";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
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
  const candidates = [
    resolve("node_modules", "tree-sitter-wasms", "out", `${wasmName}.wasm`),
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "node_modules",
      "tree-sitter-wasms",
      "out",
      `${wasmName}.wasm`
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
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
