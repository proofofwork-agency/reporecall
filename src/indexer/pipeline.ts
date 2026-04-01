import { resolve, relative, isAbsolute, sep } from "path";
import { mkdirSync } from "fs";
import { stat } from "fs/promises";
import type { MemoryConfig } from "../core/config.js";
import { getLogger } from "../core/logger.js";
import { scanFiles } from "./file-scanner.js";
import { MerkleTree } from "./merkle.js";
import { createEmbedder, formatChunkForEmbedding } from "./embedder.js";
import type { EmbeddingProvider, EmbeddingVector } from "./types.js";
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
import { extractSemanticFeatures } from "../analysis/semantic-features.js";
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

interface ChunkedFileRecord {
  path: string;
  hash?: string;
  fileMtime: string;
  chunks: Array<CodeChunk & { fileMtime: string }>;
  callEdges: CallEdge[];
  importRecords: ImportRecord[];
  textBytes: number;
}

interface WindowProgressState {
  discoveredChunks: number;
  embeddedChunks: number;
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

function estimateChunkTextBytes(chunk: {
  kind: string;
  name: string;
  filePath: string;
  docstring?: string;
  content: string;
}): number {
  return Buffer.byteLength(
    `${chunk.kind}\n${chunk.name}\n${chunk.filePath}\n${chunk.docstring ?? ""}\n${chunk.content}`,
    "utf8"
  );
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

  private getFileBatchSize(): number {
    return Math.max(1, this.config.fileBatchSize ?? this.config.batchSize ?? 32);
  }

  private getEmbedBatchSize(): number {
    return Math.max(1, this.config.embedBatchSize ?? this.config.batchSize ?? 32);
  }

  private useAdaptiveBatching(): boolean {
    return this.config.adaptiveBatching !== false;
  }

  private getHeapSoftLimitBytes(): number {
    const limitMb = this.config.heapSoftLimitMb ?? 2048;
    return Math.max(128, limitMb) * 1024 * 1024;
  }

  private getMaxChunkTextBytesPerWindow(): number {
    return Math.max(128 * 1024, this.config.maxChunkTextBytesPerWindow ?? 2 * 1024 * 1024);
  }

  private getHeapUsedBytes(): number {
    return process.memoryUsage().heapUsed;
  }

  private shouldReduceEmbeddingPressure(windowTextBytes: number): boolean {
    if (!this.useAdaptiveBatching()) return false;
    return this.getHeapUsedBytes() >= this.getHeapSoftLimitBytes() * 0.88
      || windowTextBytes >= this.getMaxChunkTextBytesPerWindow() * 0.9;
  }

  private reduceBatchSize(batchSize: number): number {
    return Math.max(1, Math.floor(batchSize / 2));
  }

  private getAdaptiveEmbedBatchSize(windowChunkCount: number, windowTextBytes: number): number {
    let batchSize = this.getEmbedBatchSize();
    if (!this.useAdaptiveBatching()) return batchSize;
    if (windowChunkCount >= 96) batchSize = Math.min(batchSize, 8);
    if (windowChunkCount >= 48) batchSize = Math.min(batchSize, 12);
    if (windowTextBytes >= this.getMaxChunkTextBytesPerWindow()) batchSize = Math.min(batchSize, 8);
    if (this.getHeapUsedBytes() >= this.getHeapSoftLimitBytes() * 0.82) batchSize = Math.min(batchSize, 6);
    return Math.max(1, batchSize);
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

  private async forceFullReindex(onProgress?: (progress: IndexProgress) => void): Promise<{ filesProcessed: number; chunksCreated: number }> {
    const log = getLogger();
    log.info("Existing local index is inconsistent — forcing a full rebuild");
    this.metadata.resetIndexData();
    this.fts.resetAll();
    await this.vectors.resetAll();
    this.merkle.clear();
    this.metadata.setStat("index_format_version", INDEX_FORMAT_VERSION);
    return this.indexAll(onProgress, true);
  }

  private async chunkChangedFile(changePath: string, hash?: string): Promise<ChunkedFileRecord | null> {
    const absPath = resolve(this.config.projectRoot, changePath);
    const fileMtime = (await stat(absPath)).mtime.toISOString();
    const { chunks, callEdges, rawImports } = await chunkFileWithCalls(absPath, this.config.projectRoot);
    const storedChunks = chunks.map((chunk) => ({ ...chunk, fileMtime }));
    return {
      path: changePath,
      hash,
      fileMtime,
      chunks: storedChunks,
      callEdges,
      importRecords: buildImportRecords(rawImports, changePath, this.config.projectRoot),
      textBytes: storedChunks.reduce((sum, chunk) => sum + estimateChunkTextBytes(chunk), 0),
    };
  }

  private async embedWindowChunks(
    chunks: Array<CodeChunk & { fileMtime: string }>,
    windowTextBytes: number,
    progressState: WindowProgressState,
    onProgress?: (progress: IndexProgress) => void
  ): Promise<Array<{ chunk: CodeChunk & { fileMtime: string }; vector: EmbeddingVector }>> {
    const log = getLogger();
    const keywordMode = this.config.embeddingProvider === "keyword" || !this.embedder.isEnabled();
    if (keywordMode) {
      progressState.embeddedChunks += chunks.length;
      return chunks.map((chunk) => ({ chunk, vector: [] }));
    }

    const embeddedChunks: Array<{ chunk: CodeChunk & { fileMtime: string }; vector: EmbeddingVector }> = [];
    let batchSize = this.getAdaptiveEmbedBatchSize(chunks.length, windowTextBytes);
    let index = 0;

    while (index < chunks.length) {
      if (this.shouldReduceEmbeddingPressure(windowTextBytes) && batchSize > 1) {
        const reduced = this.reduceBatchSize(batchSize);
        if (reduced < batchSize) {
          log.info({
            batchSize,
            reducedBatchSize: reduced,
            heapUsedMb: Math.round(this.getHeapUsedBytes() / 1024 / 1024),
          }, "Reducing embedding batch size under memory pressure");
          batchSize = reduced;
        }
      }

      const batch = chunks.slice(index, index + batchSize);
      const texts = batch.map(formatChunkForEmbedding);

      try {
        const vectors = await this.embedder.embed(texts);
        for (let vectorIndex = 0; vectorIndex < batch.length; vectorIndex += 1) {
          const batchChunk = batch[vectorIndex];
          const batchVector = vectors[vectorIndex];
          if (!batchChunk || !batchVector) continue;
          embeddedChunks.push({ chunk: batchChunk, vector: batchVector });
        }
        index += batch.length;
      } catch (err) {
        if (this.useAdaptiveBatching() && batchSize > 1) {
          const reduced = this.reduceBatchSize(batchSize);
          if (reduced < batchSize) {
            log.warn({
              err,
              batchSize,
              reducedBatchSize: reduced,
            }, "Embedding batch failed — retrying with smaller batch");
            batchSize = reduced;
            continue;
          }
        }

        log.warn({ err, batchSize, failedChunks: batch.length }, "Embedding batch failed — falling back to keyword vectors for batch");
        for (const chunk of batch) {
          embeddedChunks.push({ chunk, vector: [] });
        }
        index += batch.length;
      }

      progressState.embeddedChunks += batch.length;
      onProgress?.({
        phase: "embedding",
        current: progressState.embeddedChunks,
        total: Math.max(progressState.discoveredChunks, progressState.embeddedChunks),
        message: `Embedded ${progressState.embeddedChunks}/${Math.max(progressState.discoveredChunks, progressState.embeddedChunks)} chunks`,
      });
    }

    return embeddedChunks;
  }

  private async persistWindow(
    records: ChunkedFileRecord[],
    progressState: WindowProgressState,
    onProgress?: (progress: IndexProgress) => void
  ): Promise<{ filesProcessed: number; chunksCreated: number; filePaths: string[] }> {
    if (records.length === 0) {
      return { filesProcessed: 0, chunksCreated: 0, filePaths: [] };
    }

    const log = getLogger();
    const now = new Date().toISOString();
    const windowChunks = records.flatMap((record) => record.chunks);
    const windowCallEdges = records.flatMap((record) => record.callEdges);
    const windowImports = records.flatMap((record) => record.importRecords);
    const windowTextBytes = records.reduce((sum, record) => sum + record.textBytes, 0);
    const filePaths = records.map((record) => record.path);

    log.info({
      files: records.length,
      chunks: windowChunks.length,
      textBytes: windowTextBytes,
      heapUsedMb: Math.round(this.getHeapUsedBytes() / 1024 / 1024),
    }, "Processing indexing window");

    const embeddedChunks = await this.embedWindowChunks(windowChunks, windowTextBytes, progressState, onProgress);

    onProgress?.({
      phase: "storing",
      current: progressState.embeddedChunks,
      total: Math.max(progressState.discoveredChunks, progressState.embeddedChunks),
      message: `Persisting ${records.length} files`,
    });

    for (const filePath of filePaths) {
      this.metadata.removeChunksForFile(filePath);
      this.metadata.removeCallEdgesForFile(filePath);
      this.metadata.removeImportsForFile(filePath);
    }
    this.fts.bulkRemoveByFiles(filePaths);
    await this.vectors.removeByFiles(filePaths);

    const metadataChunks = embeddedChunks.map(({ chunk }) => ({
      ...chunk,
      indexedAt: now,
      fileMtime: chunk.fileMtime,
    }));

    if (metadataChunks.length > 0) {
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
    }

    if (windowImports.length > 0) {
      this.metadata.upsertImports(windowImports);
    }

    for (const edge of windowCallEdges) {
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

    if (windowCallEdges.length > 0) {
      this.metadata.upsertCallEdges(windowCallEdges);
    }

    if (metadataChunks.length > 0) {
      const callerCounts = new Map<string, number>();
      for (const chunk of metadataChunks) {
        callerCounts.set(
          chunk.id,
          this.metadata.findCallers(chunk.name, 200, chunk.filePath, chunk.id).length
        );
      }
      const semanticFeatures = extractSemanticFeatures(metadataChunks, windowCallEdges, callerCounts);
      this.metadata.replaceChunkFeatures(semanticFeatures.chunkFeatures);
      this.metadata.replaceFileFeatures(semanticFeatures.fileFeatures);
      this.metadata.replaceChunkTags(semanticFeatures.chunkTags);
    }

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

    for (const record of records) {
      if (record.hash) {
        this.metadata.upsertFile(record.path, record.hash);
      }
    }

    return {
      filesProcessed: records.length,
      chunksCreated: metadataChunks.length,
      filePaths,
    };
  }

  private async flushWindow(
    window: ChunkedFileRecord[],
    progressState: WindowProgressState,
    successfulFiles: Set<string>,
    counters: { filesProcessed: number; chunksCreated: number },
    onProgress?: (progress: IndexProgress) => void
  ): Promise<void> {
    if (window.length === 0) return;
    const result = await this.persistWindow(window, progressState, onProgress);
    counters.filesProcessed += result.filesProcessed;
    counters.chunksCreated += result.chunksCreated;
    for (const filePath of result.filePaths) successfulFiles.add(filePath);
    window.length = 0;
    this.rebuildTargetCatalog();
  }

  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    _isRetry = false
  ): Promise<{ filesProcessed: number; chunksCreated: number }> {
    const log = getLogger();
    await this.ensureIndexFormat();

    onProgress?.({
      phase: "scanning",
      current: 0,
      total: 0,
      message: "Scanning files...",
    });
    const files = await scanFiles(this.config);
    log.info(`Found ${files.length} files`);

    const existingStats = this.metadata.getStats();
    const lastIndexedAt = this.metadata.getStat("lastIndexedAt");
    const indexLooksInconsistent =
      files.length > 0
      && (
        (existingStats.totalChunks > 0 && existingStats.totalFiles === 0)
        || (existingStats.totalChunks > 0 && !lastIndexedAt)
      );
    if (!_isRetry && indexLooksInconsistent) {
      return this.forceFullReindex(onProgress);
    }

    const { changes, pendingState } = await this.merkle.computeChanges(
      files.map((file) => ({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
      }))
    );

    const toProcess = changes.filter((change) => change.type !== "deleted");
    const toDelete = changes.filter((change) => change.type === "deleted");

    log.info(`Changes: ${toProcess.length} to process, ${toDelete.length} to delete`);

    if (toProcess.length === 0 && toDelete.length === 0) {
      const storeChunkCount = this.metadata.getStats().totalChunks;
      const storeFileCount = this.metadata.getStats().totalFiles;
      const indexedAt = this.metadata.getStat("lastIndexedAt");
      if (
        !_isRetry
        && files.length > 0
        && (
          storeChunkCount === 0
          || storeFileCount === 0
          || !indexedAt
        )
      ) {
        log.info("Merkle says no changes but stores are empty — forcing full re-index");
        return this.forceFullReindex(onProgress);
      }

      onProgress?.({
        phase: "done",
        current: 0,
        total: 0,
        message: "No changes detected",
      });
      return { filesProcessed: 0, chunksCreated: 0 };
    }

    if (toDelete.length > 0) {
      const deletedPaths = toDelete.map((entry) => entry.path);
      for (const deletedPath of deletedPaths) {
        this.metadata.removeFile(deletedPath);
      }
      this.fts.bulkRemoveByFiles(deletedPaths);
      await this.vectors.removeByFiles(deletedPaths);
    }

    onProgress?.({
      phase: "chunking",
      current: 0,
      total: toProcess.length,
      message: `Chunking ${toProcess.length} files...`,
    });

    const successfulFiles = new Set<string>();
    const progressState: WindowProgressState = { discoveredChunks: 0, embeddedChunks: 0 };
    const counters = { filesProcessed: 0, chunksCreated: 0 };
    const pendingWindow: ChunkedFileRecord[] = [];
    let pendingWindowBytes = 0;

    for (let index = 0; index < toProcess.length; index += 1) {
      const change = toProcess[index];
      if (!change) continue;

      try {
        const record = await this.chunkChangedFile(change.path, change.hash);
        if (!record) continue;
        progressState.discoveredChunks += record.chunks.length;

        const wouldOverflowWindow =
          pendingWindow.length > 0
          && (
            pendingWindow.length >= this.getFileBatchSize()
            || pendingWindowBytes + record.textBytes > this.getMaxChunkTextBytesPerWindow()
          );

        if (wouldOverflowWindow) {
          await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, onProgress);
          pendingWindowBytes = 0;
        }

        pendingWindow.push(record);
        pendingWindowBytes += record.textBytes;

        const shouldFlushNow =
          pendingWindow.length >= this.getFileBatchSize()
          || pendingWindowBytes >= this.getMaxChunkTextBytesPerWindow();
        if (shouldFlushNow) {
          await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, onProgress);
          pendingWindowBytes = 0;
        }
      } catch (err) {
        log.warn(`Failed to chunk ${change.path}: ${err}`);
      }

      onProgress?.({
        phase: "chunking",
        current: index + 1,
        total: toProcess.length,
        message: `Chunked ${change.path}`,
      });
    }

    await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, onProgress);

    const filteredPendingState: Record<string, string | { hash: string; mtimeMs: number }> = {};
    for (const [path, entry] of Object.entries(pendingState)) {
      const isChangedFile = toProcess.some((change) => change.path === path);
      if (!isChangedFile || successfulFiles.has(path)) {
        filteredPendingState[path] = entry;
      }
    }
    this.merkle.applyPendingState(filteredPendingState);
    this.merkle.save();

    this.rebuildTargetCatalog();
    const now = new Date().toISOString();
    this.metadata.setStat("lastIndexedAt", now);

    try {
      const conventions = analyzeConventions(this.metadata);
      this.metadata.setConventions(conventions);
    } catch (err) {
      log.warn(`Conventions analysis failed: ${err}`);
    }

    onProgress?.({
      phase: "done",
      current: counters.chunksCreated,
      total: counters.chunksCreated,
      message: `Indexed ${counters.filesProcessed} files, ${counters.chunksCreated} chunks`,
    });

    return counters;
  }

  async indexChanged(paths: string[]): Promise<{
    filesProcessed: number;
    chunksCreated: number;
  }> {
    const log = getLogger();
    await this.ensureIndexFormat();

    const successfulFiles = new Set<string>();
    const progressState: WindowProgressState = { discoveredChunks: 0, embeddedChunks: 0 };
    const counters = { filesProcessed: 0, chunksCreated: 0 };
    const pendingWindow: ChunkedFileRecord[] = [];
    let pendingWindowBytes = 0;

    for (const pathValue of paths) {
      const relPath = isAbsolute(pathValue) ? relative(this.config.projectRoot, pathValue) : pathValue;
      const absPath = resolve(this.config.projectRoot, relPath);

      if (!absPath.startsWith(this.config.projectRoot + sep) && absPath !== this.config.projectRoot) {
        log.warn(`Path traversal blocked: ${pathValue} resolves outside project root`);
        continue;
      }

      try {
        const record = await this.chunkChangedFile(relPath);
        if (!record) continue;
        progressState.discoveredChunks += record.chunks.length;

        const wouldOverflowWindow =
          pendingWindow.length > 0
          && (
            pendingWindow.length >= this.getFileBatchSize()
            || pendingWindowBytes + record.textBytes > this.getMaxChunkTextBytesPerWindow()
          );

        if (wouldOverflowWindow) {
          await this.flushWindow(pendingWindow, progressState, successfulFiles, counters);
          pendingWindowBytes = 0;
        }

        pendingWindow.push(record);
        pendingWindowBytes += record.textBytes;

        const shouldFlushNow =
          pendingWindow.length >= this.getFileBatchSize()
          || pendingWindowBytes >= this.getMaxChunkTextBytesPerWindow();
        if (shouldFlushNow) {
          await this.flushWindow(pendingWindow, progressState, successfulFiles, counters);
          pendingWindowBytes = 0;
        }
      } catch (err) {
        log.warn(`Failed to re-index ${relPath}: ${err}`);
      }
    }

    await this.flushWindow(pendingWindow, progressState, successfulFiles, counters);

    this.rebuildTargetCatalog();
    for (const pathValue of paths) {
      const relPath = isAbsolute(pathValue) ? relative(this.config.projectRoot, pathValue) : pathValue;
      const absPath = resolve(this.config.projectRoot, relPath);
      if (!successfulFiles.has(relPath)) continue;
      try {
        await this.merkle.updateHash(relPath, absPath);
      } catch {
        // file may have been deleted
      }
    }
    this.merkle.save();
    this.metadata.setStat("lastIndexedAt", new Date().toISOString());

    try {
      const conventions = analyzeConventions(this.metadata);
      this.metadata.setConventions(conventions);
    } catch (err) {
      log.warn(`Conventions analysis failed: ${err}`);
    }

    return counters;
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
      getLogger().warn({ err }, "[Pipeline] vectors.close() failed in sync close");
    });
  }

  async closeAsync(): Promise<void> {
    freeEncoder();
    this.fts.close();
    this.metadata.close();
    await this.vectors.close();
  }

  async closeAndClearMerkle(): Promise<void> {
    await this.closeAsync();
    this.merkle.clear();
  }

  async reinit(): Promise<void> {
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
