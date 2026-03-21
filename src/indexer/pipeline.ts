import { resolve, relative, isAbsolute, sep } from "path";
import { mkdirSync } from "fs";
import { stat } from "fs/promises";
import type { MemoryConfig } from "../core/config.js";
import { getLogger } from "../core/logger.js";
import { scanFiles } from "./file-scanner.js";
import { MerkleTree } from "./merkle.js";
import { createEmbedder, formatChunkForEmbedding } from "./embedder.js";
import type { EmbeddingProvider } from "./types.js";
import { chunkFileWithCalls } from "../parser/chunker.js";
import { MetadataStore } from "../storage/metadata-store.js";
import { FTSStore } from "../storage/fts-store.js";
import { VectorStore } from "../storage/vector-store.js";
import type { CodeChunk } from "../parser/types.js";
import type { CallEdge } from "../analysis/call-graph.js";
import { resolveImportPath } from "../analysis/imports.js";
import type { ImportRecord } from "../storage/import-store.js";
import { analyzeConventions } from "../analysis/conventions.js";
import { resolveCallTarget } from "../analysis/resolve.js";
import { freeEncoder } from "../search/context-assembler.js";
import { buildTargetCatalog, INDEX_FORMAT_VERSION } from "../search/targets.js";

export interface IndexProgress {
  phase: "scanning" | "chunking" | "embedding" | "storing" | "done";
  current: number;
  total: number;
  message: string;
}

export interface PipelineDependencies {
  embedder?: EmbeddingProvider;
  metadata?: MetadataStore;
  fts?: FTSStore;
  vectors?: VectorStore;
  merkle?: MerkleTree;
}

function buildImportRecords(
  rawImports: Array<{ importedName: string; sourceModule: string; isDefault: boolean; isNamespace: boolean }>,
  relPath: string,
  projectRoot: string
): ImportRecord[] {
  return rawImports.map((raw) => ({
    filePath: relPath,
    importedName: raw.importedName,
    sourceModule: raw.sourceModule,
    resolvedPath: resolveImportPath(raw.sourceModule, relPath, projectRoot),
    isDefault: raw.isDefault,
    isNamespace: raw.isNamespace,
  }));
}

export class IndexingPipeline {
  private config: MemoryConfig;
  private embedder: EmbeddingProvider;
  private metadata: MetadataStore;
  private fts: FTSStore;
  private vectors: VectorStore;
  private merkle: MerkleTree;

  constructor(config: MemoryConfig, deps?: PipelineDependencies) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });

    this.embedder = deps?.embedder ?? createEmbedder(
      config.embeddingProvider,
      config.embeddingModel,
      config.ollamaUrl,
      config.embeddingDimensions
    );
    this.metadata = deps?.metadata ?? new MetadataStore(config.dataDir);
    this.fts = deps?.fts ?? new FTSStore(config.dataDir);
    this.vectors = deps?.vectors ?? new VectorStore(config.dataDir, config.embeddingDimensions);
    this.merkle = deps?.merkle ?? new MerkleTree(config.dataDir);
  }

  private async ensureIndexFormat(): Promise<void> {
    const currentVersion = this.metadata.getStat("index_format_version");
    if (currentVersion === INDEX_FORMAT_VERSION) return;

    const log = getLogger();
    log.info(`Index format mismatch (${currentVersion ?? "none"} -> ${INDEX_FORMAT_VERSION}) — rebuilding local index`);
    this.metadata.resetIndexData();
    this.fts.resetAll();
    await this.vectors.resetAll();
    this.merkle.clear();
    this.metadata.setStat("index_format_version", INDEX_FORMAT_VERSION);
  }

  private rebuildTargetCatalog(): void {
    const { targets, aliases } = buildTargetCatalog(
      this.metadata.getAllChunks(),
      this.config.implementationPaths
    );
    this.metadata.replaceAllTargets(targets, aliases);
  }

  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    _isRetry = false
  ): Promise<{ filesProcessed: number; chunksCreated: number }> {
    const log = getLogger();
    await this.ensureIndexFormat();

    // Phase 1: Scan files
    onProgress?.({
      phase: "scanning",
      current: 0,
      total: 0,
      message: "Scanning files...",
    });
    const files = await scanFiles(this.config);
    log.info(`Found ${files.length} files`);

    // Phase 2: Detect changes
    const { changes, pendingState } = await this.merkle.computeChanges(
      files.map((f) => ({
        relativePath: f.relativePath,
        absolutePath: f.absolutePath,
      }))
    );

    const toProcess = changes.filter((c) => c.type !== "deleted");
    const toDelete = changes.filter((c) => c.type === "deleted");

    log.info(
      `Changes: ${toProcess.length} to process, ${toDelete.length} to delete`
    );

    if (toProcess.length === 0 && toDelete.length === 0) {
      // Cross-check: if Merkle says no changes but stores are empty,
      // the index is stale — force a full re-index
      const storeChunkCount = this.metadata.getStats().totalChunks;
      if (!_isRetry && storeChunkCount === 0 && files.length > 0) {
        log.info("Merkle says no changes but stores are empty — forcing full re-index");
        this.merkle.clear();
        return this.indexAll(onProgress, true);
      }

      onProgress?.({
        phase: "done",
        current: 0,
        total: 0,
        message: "No changes detected",
      });
      return { filesProcessed: 0, chunksCreated: 0 };
    }

    // Phase 3: Remove deleted files (batch)
    if (toDelete.length > 0) {
      const deletedPaths = toDelete.map((d) => d.path);
      for (const delPath of deletedPaths) {
        this.metadata.removeFile(delPath);
      }
      this.fts.bulkRemoveByFiles(deletedPaths);
      await this.vectors.removeByFiles(deletedPaths);
    }

    // Phase 4: Chunk changed files
    onProgress?.({
      phase: "chunking",
      current: 0,
      total: toProcess.length,
      message: `Chunking ${toProcess.length} files...`,
    });

    const allChunks: Array<CodeChunk & { fileMtime: string }> = [];
    const allCallEdges: CallEdge[] = [];
    const allImportRecords: ImportRecord[] = [];
    const successfulFiles = new Set<string>();

    for (let i = 0; i < toProcess.length; i++) {
      const change = toProcess[i];
      if (!change) continue;
      const absPath = resolve(this.config.projectRoot, change.path);

      try {
        const fileMtime = (await stat(absPath)).mtime.toISOString();
        const { chunks, callEdges, rawImports } = await chunkFileWithCalls(absPath, this.config.projectRoot);
        for (const chunk of chunks) {
          allChunks.push({ ...chunk, fileMtime });
        }
        allCallEdges.push(...callEdges);

        // Resolve and collect import records
        allImportRecords.push(...buildImportRecords(rawImports, change.path, this.config.projectRoot));

        successfulFiles.add(change.path);
      } catch (err) {
        log.warn(`Failed to chunk ${change.path}: ${err}`);
      }

      onProgress?.({
        phase: "chunking",
        current: i + 1,
        total: toProcess.length,
        message: `Chunked ${change.path}`,
      });
    }

    log.info(`Created ${allChunks.length} chunks, ${allCallEdges.length} call edges`);

    const isKeywordMode = this.config.embeddingProvider === "keyword";

    // Phase 5: Embed in batches (skip for keyword mode)
    const embeddedChunks: Array<{
      chunk: CodeChunk & { fileMtime: string };
      vector: number[];
    }> = [];

    if (isKeywordMode) {
      for (const chunk of allChunks) {
        embeddedChunks.push({ chunk, vector: [] });
      }
      log.info("Keyword mode: skipping embedding");
    } else {
      onProgress?.({
        phase: "embedding",
        current: 0,
        total: allChunks.length,
        message: `Embedding ${allChunks.length} chunks...`,
      });

      const batchSize = this.config.batchSize;

      for (let i = 0; i < allChunks.length; i += batchSize) {
        const batch = allChunks.slice(i, i + batchSize);
        const texts = batch.map(formatChunkForEmbedding);

        try {
          const vectors = await this.embedder.embed(texts);
          for (let j = 0; j < batch.length; j++) {
            const batchChunk = batch[j];
            const batchVector = vectors[j];
            if (!batchChunk || !batchVector) continue;
            embeddedChunks.push({ chunk: batchChunk, vector: batchVector });
          }
        } catch (err) {
          log.warn(`Embedding batch failed, falling back to keyword-only for ${batch.length} chunks: ${err}`);
          for (const chunk of batch) {
            embeddedChunks.push({ chunk, vector: [] });
          }
        }

        onProgress?.({
          phase: "embedding",
          current: Math.min(i + batchSize, allChunks.length),
          total: allChunks.length,
          message: `Embedded ${Math.min(i + batchSize, allChunks.length)}/${allChunks.length} chunks`,
        });
      }
    }

    // Phase 6: Store
    onProgress?.({
      phase: "storing",
      current: 0,
      total: embeddedChunks.length,
      message: "Storing chunks...",
    });

    const now = new Date().toISOString();

    // Delete old data for successfully chunked+embedded files before inserting new data
    for (const filePath of successfulFiles) {
      this.metadata.removeChunksForFile(filePath);
      this.metadata.removeCallEdgesForFile(filePath);
      this.metadata.removeImportsForFile(filePath);
      this.fts.removeByFile(filePath);
    }
    await this.vectors.removeByFiles(Array.from(successfulFiles));

    // Store in metadata + FTS using bulk operations
    const metadataChunks = embeddedChunks.map(({ chunk }) => ({
      ...chunk,
      indexedAt: now,
      fileMtime: chunk.fileMtime,
    }));
    this.metadata.bulkUpsertChunks(metadataChunks);
    this.fts.bulkUpsert(
      embeddedChunks.map(({ chunk }) => ({
        id: chunk.id,
        name: chunk.name,
        filePath: chunk.filePath,
        content: chunk.content,
        kind: chunk.kind,
      }))
    );

    // Store import records (before call edges so resolution can query them)
    if (allImportRecords.length > 0) {
      this.metadata.upsertImports(allImportRecords);
    }

    this.rebuildTargetCatalog();

    // Resolve call edge targets using stored imports and chunks
    for (const edge of allCallEdges) {
      const resolution = resolveCallTarget(
        {
          targetName: edge.targetName,
          filePath: edge.filePath,
          receiver: edge.receiver,
          literalTargets: edge.literalTargets,
        },
        this.metadata
      );
      if (resolution) {
        edge.targetFilePath = resolution.filePath;
        edge.targetId = resolution.targetId;
        edge.targetKind = resolution.targetKind;
        edge.resolutionSource = resolution.resolutionSource;
      }
    }

    // Store call edges (after resolution so target_file_path is populated)
    if (allCallEdges.length > 0) {
      this.metadata.upsertCallEdges(allCallEdges);
    }

    // Store vectors (skip for keyword mode)
    if (!isKeywordMode) {
      const vectorRecords = embeddedChunks
        .filter(({ vector }) => vector.length > 0)
        .map(({ chunk, vector }) => ({
          id: chunk.id,
          vector,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        }));

      if (vectorRecords.length > 0) {
        await this.vectors.upsert(vectorRecords);
      }
    }

    // Update file hashes only for successful files
    for (const change of toProcess) {
      if (successfulFiles.has(change.path) && change.hash) {
        this.metadata.upsertFile(change.path, change.hash);
      }
    }

    // Apply pending merkle state filtered to successful files and save
    const filteredPendingState: Record<string, string | { hash: string; mtimeMs: number }> = {};
    for (const [path, entry] of Object.entries(pendingState)) {
      // Keep existing state for unchanged files + successful files only
      const isChangedFile = toProcess.some((c) => c.path === path);
      if (!isChangedFile || successfulFiles.has(path)) {
        filteredPendingState[path] = entry;
      }
    }
    this.merkle.applyPendingState(filteredPendingState);
    this.merkle.save();
    this.metadata.setStat("lastIndexedAt", now);

    // Analyze conventions
    try {
      const conventions = analyzeConventions(this.metadata);
      this.metadata.setConventions(conventions);
    } catch (err) {
      log.warn(`Conventions analysis failed: ${err}`);
    }

    onProgress?.({
      phase: "done",
      current: embeddedChunks.length,
      total: embeddedChunks.length,
      message: `Indexed ${successfulFiles.size} files, ${embeddedChunks.length} chunks`,
    });

    return {
      filesProcessed: successfulFiles.size,
      chunksCreated: embeddedChunks.length,
    };
  }

  async indexChanged(paths: string[]): Promise<{
    filesProcessed: number;
    chunksCreated: number;
  }> {
    const log = getLogger();
    await this.ensureIndexFormat();
    let totalChunks = 0;
    const successPaths = new Set<string>();

    for (const p of paths) {
      const relPath = isAbsolute(p) ? relative(this.config.projectRoot, p) : p;
      const absPath = resolve(this.config.projectRoot, relPath);

      // Validate path is within project root to prevent path traversal
      if (!absPath.startsWith(this.config.projectRoot + sep) && absPath !== this.config.projectRoot) {
        log.warn(`Path traversal blocked: ${p} resolves outside project root`);
        continue;
      }

      try {
        const fileMtime = (await stat(absPath)).mtime.toISOString();
        const { chunks, callEdges, rawImports } = await chunkFileWithCalls(absPath, this.config.projectRoot);
        if (chunks.length === 0) {
          this.metadata.removeChunksForFile(relPath);
          this.fts.removeByFile(relPath);
          await this.vectors.removeByFile(relPath);
          await this.merkle.updateHash(relPath, absPath);
          continue;
        }

        const isKeywordMode = this.config.embeddingProvider === "keyword";
        const now = new Date().toISOString();

        let vectors: number[][] | undefined;
        if (!isKeywordMode) {
          try {
            const texts = chunks.map(formatChunkForEmbedding);
            vectors = await this.embedder.embed(texts);
          } catch (err) {
            log.warn(`Embedding failed for ${relPath}, falling back to keyword-only: ${err}`);
          }
        }

        if (!isKeywordMode && !vectors) {
          log.warn(`Skipping ${relPath}: embedding failed and not in keyword mode`);
          continue;
        }

        // Delete old data AFTER embedding succeeds, BEFORE storing new data
        this.metadata.removeChunksForFile(relPath);
        this.metadata.removeCallEdgesForFile(relPath);
        this.metadata.removeImportsForFile(relPath);
        this.fts.removeByFile(relPath);
        await this.vectors.removeByFile(relPath);

        // Bulk upsert chunks and FTS entries
        const validChunks = chunks.filter((c): c is NonNullable<typeof c> => c != null);
        this.metadata.bulkUpsertChunks(
          validChunks.map((chunk) => ({ ...chunk, indexedAt: now, fileMtime }))
        );
        this.fts.bulkUpsert(
          validChunks.map((chunk) => ({
            id: chunk.id,
            name: chunk.name,
            filePath: chunk.filePath,
            content: chunk.content,
            kind: chunk.kind,
          }))
        );

        // Store import records (before call edges so resolution can query them)
        if (rawImports.length > 0) {
          this.metadata.upsertImports(buildImportRecords(rawImports, relPath, this.config.projectRoot));
        }

        this.rebuildTargetCatalog();

        // Resolve call edge targets using stored imports and chunks
        for (const edge of callEdges) {
          const resolution = resolveCallTarget(
            {
              targetName: edge.targetName,
              filePath: edge.filePath,
              receiver: edge.receiver,
              literalTargets: edge.literalTargets,
            },
            this.metadata
          );
          if (resolution) {
            edge.targetFilePath = resolution.filePath;
            edge.targetId = resolution.targetId;
            edge.targetKind = resolution.targetKind;
            edge.resolutionSource = resolution.resolutionSource;
          }
        }

        if (callEdges.length > 0) {
          this.metadata.upsertCallEdges(callEdges);
        }

        if (!isKeywordMode && vectors) {
          const resolvedVectors = vectors;
          await this.vectors.upsert(
            chunks.flatMap((chunk, i) => {
              const vector = resolvedVectors[i];
              if (!vector) return [];
              return [{
                id: chunk.id,
                vector,
                filePath: chunk.filePath,
                name: chunk.name,
                kind: chunk.kind,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
              }];
            })
          );
        }

        totalChunks += chunks.length;
        successPaths.add(relPath);
        log.info(`Re-indexed ${relPath}: ${chunks.length} chunks`);
      } catch (err) {
        log.warn(`Failed to re-index ${relPath}: ${err}`);
      }
    }

    // Update merkle state only for successfully re-indexed files
    for (const p of paths) {
      const relPath = isAbsolute(p) ? relative(this.config.projectRoot, p) : p;
      const absPath = resolve(this.config.projectRoot, relPath);
      if (!successPaths.has(relPath)) continue;
      try {
        await this.merkle.updateHash(relPath, absPath);
      } catch {
        // file may have been deleted
      }
    }
    this.merkle.save();

    this.metadata.setStat("lastIndexedAt", new Date().toISOString());
    return { filesProcessed: successPaths.size, chunksCreated: totalChunks };
  }

  async removeFiles(paths: string[]): Promise<void> {
    const log = getLogger();
    await this.ensureIndexFormat();
    const safePaths: string[] = [];
    for (const relPath of paths) {
      const absPath = resolve(this.config.projectRoot, relPath);
      if (!absPath.startsWith(this.config.projectRoot + sep) && absPath !== this.config.projectRoot) {
        log.warn(`Path traversal blocked in removeFiles: ${relPath}`);
        continue;
      }
      this.metadata.removeFile(relPath);
      this.fts.removeByFile(relPath);
      this.merkle.removeFile(relPath);
      safePaths.push(relPath);
    }
    if (safePaths.length > 0) {
      await this.vectors.removeByFiles(safePaths);
      this.rebuildTargetCatalog();
    }
    this.merkle.save();
  }

  getMetadataStore(): MetadataStore {
    return this.metadata;
  }

  getFTSStore(): FTSStore {
    return this.fts;
  }

  getVectorStore(): VectorStore {
    return this.vectors;
  }

  getEmbedder(): EmbeddingProvider {
    return this.embedder;
  }

  close(): void {
    freeEncoder();
    this.metadata.close();
    this.fts.close();
    this.vectors.close().catch((err) => {
      getLogger().warn({ err }, '[Pipeline] vectors.close() failed in sync close');
    });
  }

  /** Async close that awaits vector store shutdown to prevent native teardown races. */
  async closeAsync(): Promise<void> {
    freeEncoder();
    // Close SQLite stores first (synchronous) while event loop is still alive
    this.fts.close();
    this.metadata.close();
    // Await async LanceDB close last to prevent libc++abi mutex errors
    await this.vectors.close();
  }

  /** Close stores AND wipe merkle state — used only by clear_index */
  async closeAndClearMerkle(): Promise<void> {
    await this.closeAsync();
    this.merkle.clear();
  }

  async reinit(): Promise<void> {
    // Close existing stores before creating new ones to release file
    // descriptors and SQLite connections.  VectorStore.close() is async so we
    // must await it; MetadataStore and FTSStore have synchronous close methods.
    const oldVectors = this.vectors;
    this.metadata.close();
    this.fts.close();
    await oldVectors.close();

    mkdirSync(this.config.dataDir, { recursive: true });
    this.metadata = new MetadataStore(this.config.dataDir);
    this.fts = new FTSStore(this.config.dataDir);
    this.vectors = new VectorStore(this.config.dataDir, this.config.embeddingDimensions);
    this.merkle = new MerkleTree(this.config.dataDir);
  }
}
