import type pino from "pino";

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function logWarnWithStack(
  logger: pino.Logger,
  err: unknown,
  context: Record<string, unknown>,
  msg: string
): void {
  logger.warn({ err, ...context }, msg);
  logger.debug(
    { stack: err instanceof Error ? err.stack : String(err), ...context },
    msg
  );
}
