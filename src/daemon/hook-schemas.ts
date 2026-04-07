import { z } from "zod";

/**
 * Zod validation schemas for Claude Code hook request bodies.
 *
 * All schemas use `.passthrough()` so that unknown fields added by future
 * Claude Code versions are forwarded without causing validation failures.
 * Fields are `.optional()` because hooks may receive partial payloads.
 */

/** POST /hooks/session-start — body is currently unused but may carry session metadata. */
export const SessionStartBodySchema = z
  .object({
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
  })
  .passthrough();

/** POST /hooks/prompt-context — carries the user query and active file list. */
export const PromptContextBodySchema = z
  .object({
    /** Primary query field */
    query: z.string().optional(),
    /** Alias — older Claude Code versions may send `prompt` */
    prompt: z.string().optional(),
    /** Alias — older Claude Code versions may send `message` */
    message: z.string().optional(),
    /** Files currently open / active in the editor */
    activeFiles: z.array(z.string()).optional(),
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
  })
  .passthrough();

/** POST /hooks/pre-tool-use — information about the tool invocation being attempted. */
export const PreToolUseBodySchema = z
  .object({
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type SessionStartBody = z.infer<typeof SessionStartBodySchema>;
export type PromptContextBody = z.infer<typeof PromptContextBodySchema>;
export type PreToolUseBody = z.infer<typeof PreToolUseBodySchema>;
