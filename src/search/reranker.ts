import { getLogger } from "../core/logger.js";
import type { SearchResult } from "./types.js";

/** Callable subset of the HuggingFace feature-extraction pipeline we rely on at runtime. */
type RerankerPipeline = (inputs: Array<{ text: string; text_pair: string }>) => Promise<Array<{ score: number }> | Array<Array<{ score: number }>>>;

export class LocalReranker {
  private pipe: RerankerPipeline | undefined;
  private model: string;
  private failed = false;

  constructor(model = "Xenova/ms-marco-MiniLM-L-6-v2") {
    this.model = model;
  }

  private async getPipeline() {
    if (this.pipe !== undefined) return this.pipe;
    if (this.failed) return null;

    try {
      const { pipeline } = await import("@huggingface/transformers");
      this.pipe = await pipeline("feature-extraction", this.model, {
        dtype: "fp32",
      }) as unknown as RerankerPipeline;
      return this.pipe;
    } catch (err) {
      getLogger().warn(`Failed to load reranking model: ${err}`);
      this.failed = true;
      return null;
    }
  }

  async rerank(
    query: string,
    candidates: SearchResult[],
    topK = 10
  ): Promise<SearchResult[]> {
    const pipe = await this.getPipeline();
    if (!pipe) return candidates.slice(0, topK);

    // Build query-document pairs, truncating content to ~256 tokens (~1024 chars)
    const maxContentLen = 1024;
    const pairs = candidates.map((c) => ({
      text: query,
      text_pair: c.content.slice(0, maxContentLen),
    }));

    try {
      const scores: number[] = [];
      // Score in batches to avoid memory issues
      const batchSize = 8;
      for (let i = 0; i < pairs.length; i += batchSize) {
        const batch = pairs.slice(i, i + batchSize);
        const inputs = batch.map((p) => ({ text: p.text, text_pair: p.text_pair }));
        const results = await pipe(inputs) as Array<{ score: number }>;
        // HuggingFace returns one score object per input in a flat array
        for (const result of results) {
          const logit = (result as { score: number }).score ?? 0;
          scores.push(logit);
        }
      }

      // Pair candidates with cross-encoder scores and sort
      const scored = candidates.map((c, i) => ({
        result: c,
        crossEncoderScore: scores[i] ?? 0,
      }));
      scored.sort((a, b) => b.crossEncoderScore - a.crossEncoderScore);

      return scored.slice(0, topK).map((s) => ({
        ...s.result,
        score: s.crossEncoderScore,
      }));
    } catch (err) {
      getLogger().warn(`Reranking failed, falling back to original order: ${err}`);
      return candidates.slice(0, topK);
    }
  }
}
