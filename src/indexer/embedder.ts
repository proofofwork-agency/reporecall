import type { EmbeddingProvider } from "./types.js";
import { LocalEmbedder } from "./local-embedder.js";
import { NullEmbedder } from "./null-embedder.js";

/**
 * HTTP error thrown by embedding providers. Carries the status code and an
 * optional parsed `Retry-After` (ms) so the retry policy can honor it.
 */
export class EmbeddingHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "EmbeddingHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP statuses that are worth retrying (transient failures). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (err instanceof EmbeddingHttpError) {
    return RETRYABLE_STATUS.has(err.status);
  }
  // fetch() rejects with a TypeError on network/DNS/connection failures — those
  // are transient and worth retrying. Any other thrown Error (e.g. a 400/401
  // surfaced as EmbeddingHttpError) is not retryable.
  if (err instanceof TypeError) return true;
  return false;
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  // Delta-seconds form
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }
  // HTTP-date form
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, 60_000) : 0;
  }
  return undefined;
}

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
      // Don't retry non-retryable failures (4xx other than 429, fatal errors).
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      // Honor Retry-After when provided; otherwise exponential backoff + jitter.
      const retryAfter = err instanceof EmbeddingHttpError ? err.retryAfterMs : undefined;
      const base = retryAfter ?? baseDelayMs * Math.pow(2, attempt);
      // Full jitter: randomize within [base/2, base] to avoid thundering herds.
      const jittered = Math.max(50, base / 2 + Math.random() * (base / 2));
      await new Promise((r) => setTimeout(r, jittered));
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
          throw new EmbeddingHttpError(
            response.status,
            `Ollama embedding failed (${response.status}): ${body}`,
            parseRetryAfter(response.headers.get("retry-after"))
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
          throw new EmbeddingHttpError(
            response.status,
            `OpenAI embedding failed (${response.status}): ${body}`,
            parseRetryAfter(response.headers.get("retry-after"))
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
