import { describe, expect, it } from "vitest";
import { classifyIntent, type QueryMode } from "../../src/search/intent.js";

function expectMode(query: string, queryMode: QueryMode) {
  const intent = classifyIntent(query);
  expect(intent.queryMode).toBe(queryMode);
  expect(intent.isCodeQuery).toBe(queryMode !== "skip");
}

describe("classifyIntent", () => {
  it("skips meta and conversational prompts", () => {
    expectMode("hello", "skip");
    expectMode("am I using memory?", "skip");
    expectMode("continue", "skip");
  });

  it("classifies direct lookup prompts", () => {
    expectMode("show AuthCallback", "lookup");
    expectMode("find useAuth", "lookup");
    expectMode("where is generate-image implemented", "lookup");
  });

  it("classifies implementation traces", () => {
    expectMode("how does generate-image work", "trace");
    expectMode("how does upload-media authenticate requests", "trace");
    expectMode("what calls reciprocalRankFusion?", "trace");
  });

  it("classifies causal debugging prompts as bug mode", () => {
    expectMode("why does auth redirect fail", "bug");
    expectMode("some of the nodes can connect to nodes they are not supposed to connect to how is this possible?", "bug");
    expectMode("the parser is broken", "bug");
  });

  it("classifies broad inventory and flow questions as architecture", () => {
    expectMode("which files implement the authentication flow", "architecture");
    expectMode("how does auth flow work?", "architecture");
    expectMode("trace the full image generation flow from UI to edge function", "architecture");
    expectMode("how does the telegram bot work?", "architecture");
    expectMode("how does saving and publishing a flow work?", "architecture");
    expectMode("how are credits checked before generation runs?", "architecture");
  });

  it("classifies cross-cutting edit prompts as change", () => {
    expectMode("add logging to every step in the authentication flow", "change");
    expectMode("where should I implement audit logging across the billing flow?", "change");
  });

  it("classifies orchestration traces that use 'how are' phrasing", () => {
    expectMode("how are generation jobs fetched and polled?", "trace");
  });

  it("classifies plural bug terms as bug mode", () => {
    expectMode("bugs in duto cli", "bug");
    expectMode("duto cli bugs", "bug");
    expectMode("are there any issues with the auth flow", "bug");
    expectMode("what problems does the parser have", "bug");
  });

  it("does not confuse broad nouns with architecture when the prompt is causal", () => {
    const intent = classifyIntent("why are routes breaking after redirect?");
    expect(intent.queryMode).toBe("bug");
    expect(intent.prefersBroadContext).toBe(false);
  });
});
