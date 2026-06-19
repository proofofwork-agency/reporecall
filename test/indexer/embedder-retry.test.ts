import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaEmbedder } from "../../src/indexer/embedder.js";

interface MockResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  headers: Map<string, string>;
}

function mockResponse(opts: {
  ok: boolean;
  status: number;
  text?: string;
  body?: unknown;
  retryAfter?: string | null;
}): MockResponse {
  const headers = new Map<string, string>();
  if (opts.retryAfter !== undefined && opts.retryAfter !== null) {
    headers.set("retry-after", opts.retryAfter);
  }
  return {
    ok: opts.ok,
    status: opts.status,
    text: async () => opts.text ?? "",
    json: async () => opts.body,
    headers,
  };
}

describe("OllamaEmbedder retry policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // regression: non-retryable 4xx (400) must reject immediately without
  // retrying, instead of looping on every attempt.
  it("rejects on a 400 without retrying (fetch called exactly once)", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ ok: false, status: 400, text: "bad request" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new OllamaEmbedder("test-model", "http://localhost:11434", 384);
    await expect(embedder.embed(["x"])).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // regression: 429 is retryable and must honor Retry-After then succeed.
  it("retries a 429 with Retry-After: 0 and succeeds on the second call", async () => {
    const responses: MockResponse[] = [
      mockResponse({ ok: false, status: 429, text: "rate limited", retryAfter: "0" }),
      mockResponse({ ok: true, status: 200, body: { embeddings: [[0.1, 0.2]] } }),
    ];
    let call = 0;
    const fetchMock = vi.fn(async () => responses[call++]!);
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new OllamaEmbedder("test-model", "http://localhost:11434", 384);
    const result = await embedder.embed(["x"]);

    expect(result).toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // regression: transient network failures (fetch rejects with TypeError) must
  // be retried, then succeed.
  it("retries network TypeErrors twice then succeeds (fetch called 3x)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call <= 2) throw new TypeError("network error");
      return mockResponse({
        ok: true,
        status: 200,
        body: { embeddings: [[0.3, 0.4]] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const embedder = new OllamaEmbedder("test-model", "http://localhost:11434", 384);
    const result = await embedder.embed(["x"]);

    expect(result).toEqual([[0.3, 0.4]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
