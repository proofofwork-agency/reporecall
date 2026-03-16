import pino from "pino";

let logger: pino.Logger | undefined;

export function getLogger(): pino.Logger {
  if (logger) return logger;
  logger = pino({ level: process.env.MEMORY_LOG_LEVEL ?? "info" });
  return logger;
}

export function setLogLevel(level: string): void {
  if (logger) {
    logger.level = level;
  } else {
    process.env.MEMORY_LOG_LEVEL = level;
  }
}
