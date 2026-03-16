import type { EmbeddingProvider } from "./types.js";

export class NullEmbedder implements EmbeddingProvider {
  dimensions(): number {
    return 0;
  }

  isEnabled(): boolean {
    return false;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}
