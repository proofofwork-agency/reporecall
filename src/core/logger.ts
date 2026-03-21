import pino from "pino";

let logger: pino.Logger | undefined;

export function getLogger(): pino.Logger {
  if (logger) return logger;
  const destination =
    process.env.MEMORY_LOG_DEST === "stderr"
      ? pino.destination({ dest: 2, sync: true })
      : undefined;
  logger = pino(
    { level: process.env.MEMORY_LOG_LEVEL ?? "info" },
    destination
  );
  return logger;
}

export function setLogLevel(level: string): void {
  if (logger) {
    logger.level = level;
  } else {
    process.env.MEMORY_LOG_LEVEL = level;
  }
}

export function setLogDestination(destination: "stdout" | "stderr"): void {
  if (logger) {
    throw new Error("Logger already initialized; set log destination before first use");
  }
  process.env.MEMORY_LOG_DEST = destination;
}
