import { resolve } from "path";
import { mkdirSync } from "fs";
import { stat } from "fs/promises";
import type { MemoryConfig } from "../core/config.js";
import { getLogger } from "../core/logger.js";
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
import { resolveCallTarget } from "../analysis/resolve.js";
import { extractSemanticFeatures } from "../analysis/semantic-features.js";
import { buildTargetCatalog, INDEX_FORMAT_VERSION } from "../search/targets.js";
import { buildAdjacencyGraph } from "../analysis/graph-builder.js";
import { detectCommunities } from "../analysis/community-detection.js";
import { findGodNodes, findSurprises, suggestQuestions } from "../analysis/topology-analysis.js";
import type { TopologySnapshot } from "../storage/community-store.js";
import type { ReadWriteLock } from "../core/rwlock.js";
import { resolveCurrentCommit } from "../core/staleness.js";

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

export interface ChunkedFileRecord {
  path: string;
  hash?: string;
  fileMtime: string;
  chunks: Array<CodeChunk & { fileMtime: string }>;
  callEdges: CallEdge[];
  importRecords: ImportRecord[];
  textBytes: number;
}

export interface WindowProgressState {
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

export abstract class IndexingPipelineCore {
  abstract indexAll(
    onProgress?: (progress: IndexProgress) => void,
    isRetry?: boolean
  ): Promise<{ filesProcessed: number; chunksCreated: number }>;
  abstract vacuum(lock?: ReadWriteLock): Promise<void>;

  protected static readonly VACUUM_FREE_BYTES_THRESHOLD = 16 * 1024 * 1024;
  protected static readonly VACUUM_FREE_RATIO_THRESHOLD = 0.25;

  protected config: MemoryConfig;
  protected embedder: EmbeddingProvider;
  protected metadata: MetadataStore;
  protected fts: FTSStore;
  protected vectors: VectorStore;
  protected merkle: MerkleTree;

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

  protected writeIndexCompletionStats(now = new Date().toISOString()): void {
    this.metadata.setStat("lastIndexedAt", now);
    this.metadata.setStat("indexedCommit", resolveCurrentCommit(this.config.projectRoot) ?? "");
  }

  protected async vacuumIfNeeded(reason: string): Promise<void> {
    const before = this.metadata.getStorageStats();
    const freeRatio = before.metadataDbPageBytes > 0
      ? before.metadataDbFreeBytes / before.metadataDbPageBytes
      : 0;
    if (
      before.metadataDbFreeBytes < IndexingPipelineCore.VACUUM_FREE_BYTES_THRESHOLD
      && freeRatio < IndexingPipelineCore.VACUUM_FREE_RATIO_THRESHOLD
    ) {
      return;
    }

    const log = getLogger();
    log.info(
      {
        reason,
        metadataDbBytes: before.metadataDbBytes,
        metadataDbFreeBytes: before.metadataDbFreeBytes,
        targetAliasCount: before.targetAliasCount,
      },
      "SQLite metadata free pages above threshold; vacuuming"
    );
    await this.vacuum();
    const after = this.metadata.getStorageStats();
    log.info(
      {
        metadataDbBytes: after.metadataDbBytes,
        metadataDbFreeBytes: after.metadataDbFreeBytes,
        targetAliasCount: after.targetAliasCount,
      },
      "SQLite metadata compaction check complete"
    );
  }

  protected getFileBatchSize(): number {
    return Math.max(1, this.config.fileBatchSize ?? this.config.batchSize ?? 32);
  }

  protected getEmbedBatchSize(): number {
    return Math.max(1, this.config.embedBatchSize ?? this.config.batchSize ?? 32);
  }

  protected useAdaptiveBatching(): boolean {
    return this.config.adaptiveBatching !== false;
  }

  protected getHeapSoftLimitBytes(): number {
    const limitMb = this.config.heapSoftLimitMb ?? 2048;
    return Math.max(128, limitMb) * 1024 * 1024;
  }

  protected getMaxChunkTextBytesPerWindow(): number {
    return Math.max(128 * 1024, this.config.maxChunkTextBytesPerWindow ?? 2 * 1024 * 1024);
  }

  protected getHeapUsedBytes(): number {
    return process.memoryUsage().heapUsed;
  }

  protected shouldReduceEmbeddingPressure(windowTextBytes: number): boolean {
    if (!this.useAdaptiveBatching()) return false;
    return this.getHeapUsedBytes() >= this.getHeapSoftLimitBytes() * 0.88
      || windowTextBytes >= this.getMaxChunkTextBytesPerWindow() * 0.9;
  }

  protected reduceBatchSize(batchSize: number): number {
    return Math.max(1, Math.floor(batchSize / 2));
  }

  protected getAdaptiveEmbedBatchSize(windowChunkCount: number, windowTextBytes: number): number {
    let batchSize = this.getEmbedBatchSize();
    if (!this.useAdaptiveBatching()) return batchSize;
    if (windowChunkCount >= 96) batchSize = Math.min(batchSize, 8);
    if (windowChunkCount >= 48) batchSize = Math.min(batchSize, 12);
    if (windowTextBytes >= this.getMaxChunkTextBytesPerWindow()) batchSize = Math.min(batchSize, 8);
    if (this.getHeapUsedBytes() >= this.getHeapSoftLimitBytes() * 0.82) batchSize = Math.min(batchSize, 6);
    return Math.max(1, batchSize);
  }

  protected async ensureIndexFormat(): Promise<void> {
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

  protected lastTopologyAt = 0;
  protected readonly TOPOLOGY_COOLDOWN_MS = 30_000;

  protected recordTopologyStatus(
    status: "computed" | "skipped" | "failed",
    reason: string,
    details: Record<string, string | number> = {}
  ): void {
    this.metadata.setStat("topologyLastStatus", status);
    this.metadata.setStat("topologyLastReason", reason);
    this.metadata.setStat("topologyLastAt", new Date().toISOString());
    for (const [key, value] of Object.entries(details)) {
      this.metadata.setStat(`topologyLast${key[0]!.toUpperCase()}${key.slice(1)}`, String(value));
    }
  }

  protected computeTopologyAnalysis(log: ReturnType<typeof getLogger>): void {
    if (this.config.topologyEnabled === false) {
      this.recordTopologyStatus("skipped", "disabled");
      return;
    }
    const now = Date.now();
    if (now - this.lastTopologyAt < this.TOPOLOGY_COOLDOWN_MS) return;
    this.lastTopologyAt = now;
    try {
      const stats = this.metadata.getStats();
      const maxChunks = this.config.topologyMaxChunks ?? 50_000;
      if (stats.totalChunks > maxChunks) {
        this.recordTopologyStatus("skipped", "too_many_chunks", {
          totalChunks: stats.totalChunks,
          maxChunks,
        });
        log.warn({
          totalChunks: stats.totalChunks,
          topologyMaxChunks: maxChunks,
        }, "Skipping topology analysis for large index");
        return;
      }
      if (this.getHeapUsedBytes() >= this.getHeapSoftLimitBytes() * 0.92) {
        this.recordTopologyStatus("skipped", "memory_pressure", {
          heapUsedMb: Math.round(this.getHeapUsedBytes() / 1024 / 1024),
          heapSoftLimitMb: Math.round(this.getHeapSoftLimitBytes() / 1024 / 1024),
        });
        log.warn({
          heapUsedMb: Math.round(this.getHeapUsedBytes() / 1024 / 1024),
          heapSoftLimitMb: Math.round(this.getHeapSoftLimitBytes() / 1024 / 1024),
        }, "Skipping topology analysis under memory pressure");
        return;
      }
      const graph = buildAdjacencyGraph(this.metadata);
      if (graph.nodeCount < 5 || graph.edgeCount < 3) {
        this.recordTopologyStatus("skipped", "insufficient_graph", {
          nodeCount: graph.nodeCount,
          edgeCount: graph.edgeCount,
        });
        return;
      }

      const communities = detectCommunities(graph);
      const godNodes = findGodNodes(graph, communities);
      const surprises = findSurprises(graph, communities);
      const questions = suggestQuestions(graph, communities);
      const now = new Date().toISOString();

      const snapshot: TopologySnapshot = {
        communities: [...communities.communities.entries()].map(([id, members]) => ({
          id: `c_${id}`,
          nodeCount: members.length,
          cohesion: communities.cohesion.get(id) ?? 0,
          label: communities.labels.get(id) ?? null,
          computedAt: now,
        })),
        memberships: [...communities.membership.entries()].map(([chunkId, cid]) => ({
          chunkId,
          communityId: `c_${cid}`,
        })),
        surprises,
        godNodes,
        questions,
        computedAt: now,
      };

      this.metadata.replaceTopology(snapshot);
      this.recordTopologyStatus("computed", "ok", {
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        communities: communities.communities.size,
      });
      log.info(`Topology: ${communities.communities.size} communities, ${godNodes.length} hubs, ${surprises.length} surprises`);
    } catch (err) {
      this.recordTopologyStatus("failed", "error");
      log.warn(`Topology analysis failed: ${err}`);
    }
  }

  protected rebuildTargetCatalog(): void {
    const { targets, aliases } = buildTargetCatalog(
      this.metadata.getAllChunks(),
      this.config.implementationPaths
    );
    this.metadata.replaceAllTargets(targets, aliases);
  }

  protected async forceFullReindex(onProgress?: (progress: IndexProgress) => void): Promise<{ filesProcessed: number; chunksCreated: number }> {
    const log = getLogger();
    log.info("Existing local index is inconsistent — forcing a full rebuild");
    this.metadata.resetIndexData();
    this.fts.resetAll();
    await this.vectors.resetAll();
    this.merkle.clear();
    this.metadata.setStat("index_format_version", INDEX_FORMAT_VERSION);
    return this.indexAll(onProgress, true);
  }

  protected async chunkChangedFile(changePath: string, hash?: string): Promise<ChunkedFileRecord | null> {
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

  protected async embedWindowChunks(
    chunks: Array<CodeChunk & { fileMtime: string }>,
    windowTextBytes: number,
    progressState: WindowProgressState,
    onProgress?: (progress: IndexProgress) => void
  ): Promise<{ results: Array<{ chunk: CodeChunk & { fileMtime: string }; vector: EmbeddingVector }>; degraded: boolean }> {
    const log = getLogger();
    const keywordMode = this.config.embeddingProvider === "keyword" || !this.embedder.isEnabled();
    if (keywordMode) {
      progressState.embeddedChunks += chunks.length;
      // Keyword mode intentionally produces empty vectors — this is not degradation.
      return { results: chunks.map((chunk) => ({ chunk, vector: [] })), degraded: false };
    }

    const embeddedChunks: Array<{ chunk: CodeChunk & { fileMtime: string }; vector: EmbeddingVector }> = [];
    let degraded = false;
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

        log.error(
          { err, batchSize, failedChunks: batch.length },
          "Embedding batch failed — storing empty vectors as fallback. " +
            "Vector retrieval will be degraded for these chunks until the next successful reindex."
        );
        degraded = true;
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

    return { results: embeddedChunks, degraded };
  }

  protected async persistWindow(
    records: ChunkedFileRecord[],
    progressState: WindowProgressState,
    onProgress?: (progress: IndexProgress) => void
  ): Promise<{ filesProcessed: number; chunksCreated: number; filePaths: string[]; degraded: boolean }> {
    if (records.length === 0) {
      return { filesProcessed: 0, chunksCreated: 0, filePaths: [], degraded: false };
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

    const { results: embeddedChunks, degraded } = await this.embedWindowChunks(windowChunks, windowTextBytes, progressState, onProgress);

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

    // Dedup: resolveCallTarget is a pure read-only lookup, so identical
    // (targetName, filePath, receiver, literalTargets) edges resolve identically.
    // Cache per-window to skip redundant SQL for repeated call targets.
    const edgeResolutionCache = new Map<string, ReturnType<typeof resolveCallTarget>>();
    for (const edge of windowCallEdges) {
      const cacheKey = `${edge.targetName}\0${edge.filePath}\0${edge.receiver ?? ""}\0${(edge.literalTargets ?? []).join("\u0001")}`;
      let resolution: ReturnType<typeof resolveCallTarget>;
      if (edgeResolutionCache.has(cacheKey)) {
        resolution = edgeResolutionCache.get(cacheKey) ?? null;
      } else {
        resolution = resolveCallTarget(
          {
            targetName: edge.targetName,
            filePath: edge.filePath,
            receiver: edge.receiver,
            literalTargets: edge.literalTargets,
          },
          this.metadata
        );
        edgeResolutionCache.set(cacheKey, resolution);
      }
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
      degraded,
    };
  }

  protected async flushWindow(
    window: ChunkedFileRecord[],
    progressState: WindowProgressState,
    successfulFiles: Set<string>,
    counters: { filesProcessed: number; chunksCreated: number },
    onProgress?: (progress: IndexProgress) => void,
    degradedFiles?: Set<string>
  ): Promise<void> {
    if (window.length === 0) return;
    const result = await this.persistWindow(window, progressState, onProgress);
    counters.filesProcessed += result.filesProcessed;
    counters.chunksCreated += result.chunksCreated;
    for (const filePath of result.filePaths) successfulFiles.add(filePath);
    // Track files whose embeddings fell back to empty vectors so the caller
    // can skip committing their merkle state (forcing a retry next run).
    if (result.degraded && degradedFiles) {
      for (const filePath of result.filePaths) degradedFiles.add(filePath);
    }
    window.length = 0;
  }

}
