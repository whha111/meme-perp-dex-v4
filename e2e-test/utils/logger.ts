/**
 * Structured logger for E2E tests
 */
import pino from "pino";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
  level: process.env.LOG_LEVEL || "info",
});

export function createChildLogger(module: string) {
  return logger.child({ module });
}

// Shortcut loggers for common modules
export const log = {
  infra: createChildLogger("infra"),
  browser: createChildLogger("browser"),
  replay: createChildLogger("replay"),
  monitor: createChildLogger("monitor"),
  test: createChildLogger("test"),
  report: createChildLogger("report"),
};
