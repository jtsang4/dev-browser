import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type {
  HealthResponse,
  RuntimePaths,
  RuntimeResponse,
  ServerMode,
  ShutdownResponse,
} from "./types";
import { getPidFile, getStateFile } from "./paths";

export interface ManagedDaemonState {
  mode: ServerMode;
  pid: number;
  host: string;
  port: number;
  cdpPort: number;
  headless: boolean;
  idleTtlMs: number;
  serverUrl: string;
  wsEndpoint: string;
  startedAt: string;
  lastSeenAt: string;
  logFile: string;
  errFile: string;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function readManagedState(
  runtimePaths: RuntimePaths,
  mode: ServerMode
): ManagedDaemonState | null {
  const stateFile = getStateFile(runtimePaths, mode);
  if (!existsSync(stateFile)) {
    return null;
  }

  const parsed = parseJson<ManagedDaemonState>(readFileSync(stateFile, "utf-8"));
  if (!parsed) {
    return null;
  }
  return parsed;
}

export function writeManagedState(
  runtimePaths: RuntimePaths,
  mode: ServerMode,
  state: ManagedDaemonState
): void {
  const stateFile = getStateFile(runtimePaths, mode);
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function removeManagedState(runtimePaths: RuntimePaths, mode: ServerMode): void {
  const stateFile = getStateFile(runtimePaths, mode);
  rmSync(stateFile, { force: true });
}

export function readPid(runtimePaths: RuntimePaths, mode: ServerMode): number | null {
  const pidFile = getPidFile(runtimePaths, mode);
  if (!existsSync(pidFile)) {
    return null;
  }

  const raw = readFileSync(pidFile, "utf-8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function writePid(runtimePaths: RuntimePaths, mode: ServerMode, pid: number): void {
  const pidFile = getPidFile(runtimePaths, mode);
  writeFileSync(pidFile, `${pid}\n`, "utf-8");
}

export function removePid(runtimePaths: RuntimePaths, mode: ServerMode): void {
  const pidFile = getPidFile(runtimePaths, mode);
  rmSync(pidFile, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getHealth(
  serverUrl: string,
  timeoutMs = 1000
): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export async function getRuntime(
  serverUrl: string,
  timeoutMs = 1000
): Promise<RuntimeResponse | null> {
  try {
    const response = await fetch(`${serverUrl}/runtime`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as RuntimeResponse;
  } catch {
    return null;
  }
}

export async function shutdownServer(
  serverUrl: string,
  graceMs = 3000
): Promise<ShutdownResponse | null> {
  try {
    const response = await fetch(`${serverUrl}/admin/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graceMs }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as ShutdownResponse;
  } catch {
    return null;
  }
}

export async function waitForHealth(
  serverUrl: string,
  timeoutMs = 15000,
  pollIntervalMs = 200
): Promise<HealthResponse> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const health = await getHealth(serverUrl, pollIntervalMs + 200);
    if (health) {
      return health;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for daemon health at ${serverUrl}`);
}
