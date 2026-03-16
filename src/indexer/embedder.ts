import type { EmbeddingProvider } from "./types.js";
import { LocalEmbedder } from "./local-embedder.js";
import { NullEmbedder } from "./null-embedder.js";

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new Error(
          `Circuit breaker open: embedding service unavailable. ` +
            `Retry in ${Math.ceil((this.cooldownMs - elapsed) / 1000)}s.`
        );
      }
      // Cooldown elapsed — allow one probe
      this.state = "half-open";
    }

    try {
      const result = await fn();
      // Success: reset
      this.consecutiveFailures = 0;
      this.state = "closed";
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      if (
        this.state === "half-open" ||
        this.consecutiveFailures >= this.failureThreshold
      ) {
        this.state = "open";
        this.openedAt = Date.now();
      }
      throw err;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Exposed for testing only */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }
}

export class OllamaEmbedder implements EmbeddingProvider {
  private model: string;
  private url: string;
  private dims: number;
  private circuit = new CircuitBreaker();

  constructor(model: string, url: string, dimensions: number) {
    this.model = model;
    this.url = url;
    this.dims = dimensions;
  }

  dimensions(): number {
    return this.dims;
  }

  isEnabled(): boolean {
    return true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.circuit.call(() =>
      withRetry(async () => {
        const response = await fetch(`${this.url}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input: texts }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Ollama embedding failed (${response.status}): ${body}`
          );
        }

        const data = (await response.json()) as { embeddings: number[][] };
        return data.embeddings;
      })
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class OpenAIEmbedder implements EmbeddingProvider {
  private model: string;
  private dims: number;
  private circuit = new CircuitBreaker();

  constructor(
    model: string = "text-embedding-3-small",
    dimensions: number = 768
  ) {
    this.model = model;
    this.dims = dimensions;
  }

  dimensions(): number {
    return this.dims;
  }

  isEnabled(): boolean {
    return true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Read API key at request time to avoid keeping it in memory for daemon lifetime
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is not set"
      );
    }
    return this.circuit.call(() =>
      withRetry(async () => {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
            dimensions: this.dims,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `OpenAI embedding failed (${response.status}): ${body}`
          );
        }

        const data = (await response.json()) as {
          data: Array<{ embedding: number[] }>;
        };
        return data.data.map((d) => d.embedding);
      })
    );
  }
}

export function createEmbedder(
  provider: "local" | "ollama" | "openai" | "keyword",
  model: string,
  url: string,
  dimensions: number
): EmbeddingProvider {
  if (provider === "keyword") {
    return new NullEmbedder();
  }
  if (provider === "local") {
    return new LocalEmbedder(model, dimensions);
  }
  if (provider === "openai") {
    // API key is read from process.env at request time, not cached on instance
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OpenAI API key required. Set OPENAI_API_KEY environment variable."
      );
    }
    return new OpenAIEmbedder(model, dimensions);
  }
  return new OllamaEmbedder(model, url, dimensions);
}

export function formatChunkForEmbedding(chunk: {
  kind: string;
  name: string;
  filePath: string;
  docstring?: string;
  content: string;
}): string {
  const parts = [`${chunk.kind} ${chunk.name} in ${chunk.filePath}`];
  if (chunk.docstring) parts.push(chunk.docstring);
  parts.push(chunk.content);
  return parts.join("\n");
}
