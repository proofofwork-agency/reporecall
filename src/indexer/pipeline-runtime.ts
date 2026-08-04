import { mkdirSync } from "fs";
import { getLogger } from "../core/logger.js";
import type { ReadWriteLock } from "../core/rwlock.js";
import { resolveProjectPath } from "../core/path-safety.js";
import { freeEncoder } from "../search/context-assembler.js";
import { analyzeConventions } from "../analysis/conventions.js";
import { scanFiles } from "./file-scanner.js";
import type { EmbeddingProvider } from "./types.js";
import { MerkleTree } from "./merkle.js";
import { MetadataStore } from "../storage/metadata-store.js";
import { FTSStore } from "../storage/fts-store.js";
import { VectorStore } from "../storage/vector-store.js";
import {
  IndexingPipelineCore,
  type ChunkedFileRecord,
  type IndexProgress,
  type WindowProgressState,
} from "./pipeline-core.js";
export class IndexingPipelineRuntime extends IndexingPipelineCore {
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
    this.writeIndexCompletionStats();
    await this.vacuumIfNeeded("no-change verification");
    return { filesProcessed: 0, chunksCreated: 0 };
  }

  if (toDelete.length > 0) {
    const deletedPaths = toDelete.map((entry) => entry.path);
    this.metadata.removeFiles(deletedPaths);
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
  const degradedFiles = new Set<string>();
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
        await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, onProgress, degradedFiles);
        pendingWindowBytes = 0;
      }

      pendingWindow.push(record);
      pendingWindowBytes += record.textBytes;

      const shouldFlushNow =
        pendingWindow.length >= this.getFileBatchSize()
        || pendingWindowBytes >= this.getMaxChunkTextBytesPerWindow();
      if (shouldFlushNow) {
        await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, onProgress, degradedFiles);
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

  await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, onProgress, degradedFiles);

  const filteredPendingState: Record<string, string | { hash: string; mtimeMs: number }> = {};
  for (const [path, entry] of Object.entries(pendingState)) {
    const isChangedFile = toProcess.some((change) => change.path === path);
    // Exclude degraded files: their embeddings fell back to empty vectors,
    // so we leave their merkle state untouched to force a retry next run
    // rather than marking them as fully indexed.
    if ((!isChangedFile || successfulFiles.has(path)) && !degradedFiles.has(path)) {
      filteredPendingState[path] = entry;
    }
  }
  this.merkle.applyPendingState(filteredPendingState);
  this.merkle.save();

  if (degradedFiles.size > 0) {
    log.error(
      { degradedFileCount: degradedFiles.size },
      "Indexing completed but " + degradedFiles.size + " file(s) had embedding failures and were stored with empty vectors. " +
        "Vector search will return no results for these files until re-indexed successfully. Their merkle state was not committed so they will retry on the next index run."
    );
  }

  this.rebuildTargetCatalog();
  this.writeIndexCompletionStats();
  await this.vacuumIfNeeded("index completion");

  try {
    const conventions = analyzeConventions(this.metadata);
    this.metadata.setConventions(conventions);
  } catch (err) {
    log.warn(`Conventions analysis failed: ${err}`);
  }

  this.computeTopologyAnalysis(log);

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
  const degradedFiles = new Set<string>();
  const progressState: WindowProgressState = { discoveredChunks: 0, embeddedChunks: 0 };
  const counters = { filesProcessed: 0, chunksCreated: 0 };
  const pendingWindow: ChunkedFileRecord[] = [];
  let pendingWindowBytes = 0;
  const safePaths: Array<{ relativePath: string; absolutePath: string }> = [];

  for (const pathValue of paths) {
    const safePath = resolveProjectPath(this.config.projectRoot, pathValue, "existing");
    if (!safePath) {
      log.warn(`Path traversal blocked: ${pathValue} resolves outside project root`);
      continue;
    }
    const relPath = safePath.relativePath;
    safePaths.push({ relativePath: relPath, absolutePath: safePath.absolutePath });

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
        await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, undefined, degradedFiles);
        pendingWindowBytes = 0;
      }

      pendingWindow.push(record);
      pendingWindowBytes += record.textBytes;

      const shouldFlushNow =
        pendingWindow.length >= this.getFileBatchSize()
        || pendingWindowBytes >= this.getMaxChunkTextBytesPerWindow();
      if (shouldFlushNow) {
        await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, undefined, degradedFiles);
        pendingWindowBytes = 0;
      }
    } catch (err) {
      log.warn(`Failed to re-index ${relPath}: ${err}`);
    }
  }

  await this.flushWindow(pendingWindow, progressState, successfulFiles, counters, undefined, degradedFiles);

  this.rebuildTargetCatalog();
  for (const safePath of safePaths) {
    const relPath = safePath.relativePath;
    if (!successfulFiles.has(relPath)) continue;
    // Don't commit merkle state for degraded files — they need to retry.
    if (degradedFiles.has(relPath)) continue;
    try {
      await this.merkle.updateHash(relPath, safePath.absolutePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        /* file deleted mid-index */
      } else {
        getLogger().warn({ err, relPath }, "merkle.updateHash failed (non-ENOENT)");
      }
    }
  }
  this.merkle.save();
  this.writeIndexCompletionStats();
  await this.vacuumIfNeeded("incremental index completion");

  if (degradedFiles.size > 0) {
    log.error(
      { degradedFileCount: degradedFiles.size },
      "Incremental indexing completed but " + degradedFiles.size + " file(s) had embedding failures and were stored with empty vectors. " +
        "Vector search will return no results for these files until re-indexed successfully. Their merkle state was not committed so they will retry on the next index run."
    );
  }

  try {
    const conventions = analyzeConventions(this.metadata);
    this.metadata.setConventions(conventions);
  } catch (err) {
    log.warn(`Conventions analysis failed: ${err}`);
  }

  this.computeTopologyAnalysis(log);

  return counters;
}

async removeFiles(paths: string[]): Promise<void> {
  const log = getLogger();
  await this.ensureIndexFormat();
  const safePaths: string[] = [];
  for (const pathValue of paths) {
    const safePath = resolveProjectPath(this.config.projectRoot, pathValue, "allow-missing");
    if (!safePath) {
      log.warn(`Path traversal blocked in removeFiles: ${pathValue}`);
      continue;
    }
    safePaths.push(safePath.relativePath);
  }
  if (safePaths.length > 0) {
    this.metadata.removeFiles(safePaths);
    this.fts.bulkRemoveByFiles(safePaths);
    for (const relPath of safePaths) {
      this.merkle.removeFile(relPath);
    }
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

async vacuum(lock?: ReadWriteLock): Promise<void> {
  const run = async (): Promise<void> => {
    const log = getLogger();
    try {
      log.info("Starting SQLite vacuum (this may take a moment)...");

      const metaDb = this.metadata.getDb();
      metaDb.pragma("wal_checkpoint(TRUNCATE)");

      const ftsDb = this.fts.getDb();
      ftsDb.pragma("wal_checkpoint(TRUNCATE)");

      metaDb.exec("VACUUM");
      ftsDb.exec("VACUUM");

      log.info("SQLite vacuum completed successfully");
    } catch (err) {
      getLogger().warn({ err }, "SQLite vacuum failed");
    }
  };

  if (lock) {
    await lock.withWrite(run);
  } else {
    await run();
  }
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
