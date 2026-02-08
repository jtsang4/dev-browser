import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimePaths, ServerMode } from "./types";

export const DEFAULT_DEV_BROWSER_HOME = ".dev-browser";

export function getDevBrowserHome(): string {
  const configured = process.env.DEV_BROWSER_HOME;
  if (configured && configured.trim().length > 0) {
    return resolve(configured);
  }
  return join(homedir(), DEFAULT_DEV_BROWSER_HOME);
}

export function getRuntimePaths(home = getDevBrowserHome()): RuntimePaths {
  const root = resolve(home);
  return {
    root,
    state: join(root, "state"),
    run: join(root, "run"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    logs: join(root, "logs"),
  };
}

export function ensureRuntimePaths(paths: RuntimePaths): void {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  mkdirSync(paths.run, { recursive: true });
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.cache, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(join(paths.run, "locks"), { recursive: true });
}

export function getStateFile(paths: RuntimePaths, mode: ServerMode): string {
  return join(paths.state, `${mode}.json`);
}

export function getPidFile(paths: RuntimePaths, mode: ServerMode): string {
  return join(paths.run, `${mode}.pid`);
}

export function getLogFile(paths: RuntimePaths, mode: ServerMode): string {
  return join(paths.logs, `${mode}.log`);
}

export function getErrFile(paths: RuntimePaths, mode: ServerMode): string {
  return join(paths.logs, `${mode}.err.log`);
}

export function getPageLockFile(paths: RuntimePaths, pageName: string): string {
  return join(paths.run, "locks", `${encodeURIComponent(pageName)}.lock`);
}
