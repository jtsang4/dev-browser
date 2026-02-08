import pino from "pino";

export const logger = pino({
  name: "dev-browser",
  level: process.env.DEV_BROWSER_LOG_LEVEL ?? "silent",
});
