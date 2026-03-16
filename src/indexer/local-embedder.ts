import type { EmbeddingProvider } from "./types.js";

/** Callable subset of the HuggingFace feature-extraction pipeline. */
type FeatureExtractionPipeline = (texts: string[], options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;

// Module-level pipeline cache keyed by model name — stores the Promise to avoid races
const pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

export class LocalEmbedder implements EmbeddingProvider {
  private model: string;
  private dims: number;

  constructor(model = "Xenova/all-MiniLM-L6-v2", dimensions = 384) {
    this.model = model;
    this.dims = dimensions;
  }

  dimensions(): number {
    return this.dims;
  }

  isEnabled(): boolean {
    return true;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    const cached = pipelineCache.get(this.model);
    if (cached) return cached;

    const p = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return await pipeline("feature-extraction", this.model, {
        dtype: "q8",
      }) as unknown as FeatureExtractionPipeline;
    })();

    pipelineCache.set(this.model, p);

    try {
      return await p;
    } catch (err) {
      pipelineCache.delete(this.model);
      throw err;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.getPipeline();
    const output = await pipe(texts, { pooling: "mean", normalize: true });
    const data = output.data as Float32Array;
    if (data.length !== texts.length * this.dims) {
      throw new Error(
        `Embedding dimension mismatch: expected ${texts.length * this.dims} values, got ${data.length}`
      );
    }
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(Array.from(data.slice(i * this.dims, (i + 1) * this.dims)));
    }
    return results;
  }
}
