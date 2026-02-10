import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { z } from "zod";
import type { BrowserEngine, RuntimePaths, ServerMode } from "./types";
import { ensureRuntimePaths, getErrFile, getLogFile, getStateFile } from "./paths";
import { logger } from "./logger";
import {
  getHealth,
  getRuntime,
  isProcessAlive,
  readManagedState,
  readPid,
  removeManagedState,
  removePid,
  shutdownServer,
  waitForHealth,
  writeManagedState,
  writePid,
} from "./state";

const ensureOptionsSchema = z.object({
  mode: z.enum(["launch", "extension"]).default("launch"),
  headless: z.boolean().default(false),
  engine: z.enum(["patchright", "playwright"]).optional(),
  json: z.boolean().default(false),
  silent: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(9222),
  cdpPort: z.number().int().min(1).max(65535).default(9223),
  host: z.string().default("127.0.0.1"),
  idleTtlMs: z.number().int().positive().default(1_800_000),
});

const statusOptionsSchema = z.object({
  mode: z.enum(["launch", "extension"]).optional(),
  json: z.boolean().default(false),
});

const stopOptionsSchema = z.object({
  mode: z.enum(["launch", "extension"]).optional(),
  graceMs: z.number().int().nonnegative().default(3000),
  json: z.boolean().default(false),
});

const cleanOptionsSchema = z.object({
  staleOnly: z.boolean().default(false),
  json: z.boolean().default(false),
});

const logsOptionsSchema = z.object({
  mode: z.enum(["launch", "extension"]).default("launch"),
  follow: z.boolean().default(false),
});

interface EnsureOptions {
  mode?: ServerMode;
  headless?: boolean;
  engine?: BrowserEngine;
  json?: boolean;
  silent?: boolean;
  port?: number;
  cdpPort?: number;
  host?: string;
  idleTtlMs?: number;
}

interface StatusOptions {
  mode?: ServerMode;
  json?: boolean;
}

interface StopOptions {
  mode?: ServerMode;
  graceMs?: number;
  json?: boolean;
}

interface CleanOptions {
  staleOnly?: boolean;
  json?: boolean;
}

interface LogsOptions {
  mode?: ServerMode;
  follow?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function modeToWorker(mode: ServerMode): string {
  return mode === "launch" ? "start-server" : "start-relay";
}

function resolveWorkerScript(mode: ServerMode): string {
  return join(__dirname, "workers", `${modeToWorker(mode)}.js`);
}

function stateToSummary(state: {
  mode: ServerMode;
  pid: number;
  serverUrl: string;
  wsEndpoint: string;
  engine?: BrowserEngine | null;
}) {
  return {
    mode: state.mode,
    pid: state.pid,
    serverUrl: state.serverUrl,
    wsEndpoint: state.wsEndpoint,
    engine: state.engine ?? null,
  };
}

export async function ensureDaemon(runtimePaths: RuntimePaths, options: EnsureOptions) {
  const parsed = ensureOptionsSchema.parse(options);
  const mode = parsed.mode;
  const requestedEngine = parsed.engine ?? "patchright";
  ensureRuntimePaths(runtimePaths);

  const existingState = readManagedState(runtimePaths, mode);
  if (existingState && isProcessAlive(existingState.pid)) {
    const health = await getHealth(existingState.serverUrl, 1000);
    if (health && health.mode === mode) {
      const existingEngine =
        mode === "launch" ? (health.engine ?? existingState.engine ?? "patchright") : null;

      if (mode === "launch" && parsed.engine && existingEngine !== requestedEngine) {
        logger.info(
          {
            mode,
            pid: existingState.pid,
            fromEngine: existingEngine,
            toEngine: requestedEngine,
          },
          "daemon launch engine mismatch; restarting"
        );

        try {
          process.kill(existingState.pid, "SIGTERM");
        } catch {
          // Ignore stale process errors.
        }
      } else {
        const payload = {
          running: true,
          startedNow: false,
          mode,
          engine: existingEngine,
          serverUrl: existingState.serverUrl,
          wsEndpoint: health.wsEndpoint,
          pid: existingState.pid,
          stateFile: getStateFile(runtimePaths, mode),
          extensionConnected: health.extensionConnected,
        };

        if (parsed.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else if (!parsed.silent) {
          console.log(`Daemon already running (${mode})`);
          console.log(`  PID: ${payload.pid}`);
          console.log(`  Server: ${payload.serverUrl}`);
          console.log(`  WS: ${payload.wsEndpoint}`);
        }

        logger.info(
          { mode, engine: payload.engine, pid: payload.pid, serverUrl: payload.serverUrl },
          "daemon already running"
        );

        return payload;
      }
    }

    if (!health) {
      try {
        process.kill(existingState.pid, "SIGTERM");
      } catch {
        // Ignore stale process errors.
      }
    }
  }

  removeManagedState(runtimePaths, mode);
  removePid(runtimePaths, mode);

  const workerScript = resolveWorkerScript(mode);
  if (!existsSync(workerScript)) {
    throw new Error(
      `Worker script not found: ${workerScript}. Build CLI first with: pnpm --filter dev-browser-cli build`
    );
  }

  const logFile = getLogFile(runtimePaths, mode);
  const errFile = getErrFile(runtimePaths, mode);
  const serverUrl = `http://${parsed.host}:${parsed.port}`;

  const workerArgs = [
    "--host",
    parsed.host,
    "--port",
    String(parsed.port),
    "--cdp-port",
    String(parsed.cdpPort),
    "--idle-ttl-ms",
    String(parsed.idleTtlMs),
    "--runtime-root",
    runtimePaths.root,
    ...(mode === "launch"
      ? ["--headless", String(parsed.headless), "--engine", requestedEngine]
      : []),
  ];

  const stdoutFd = openSync(logFile, "a");
  const stderrFd = openSync(errFile, "a");

  const child = spawn(process.execPath, [workerScript, ...workerArgs], {
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env: {
      ...process.env,
      DEV_BROWSER_HOME: runtimePaths.root,
    },
  });

  closeSync(stdoutFd);
  closeSync(stderrFd);

  child.unref();

  const bootstrapPid = child.pid;
  if (!bootstrapPid) {
    throw new Error("Failed to launch daemon process");
  }

  let health;
  try {
    health = await waitForHealth(serverUrl, 15000, 200);
  } catch (error) {
    try {
      process.kill(bootstrapPid, "SIGTERM");
    } catch {
      // Ignore race.
    }
    throw error;
  }

  if (health.mode !== mode) {
    try {
      process.kill(bootstrapPid, "SIGTERM");
    } catch {
      // ignore race
    }
    throw new Error(
      `Port ${parsed.port} is already serving ${health.mode} mode. Use --port to isolate modes.`
    );
  }

  if (mode === "launch") {
    const resolvedEngine = health.engine ?? "patchright";
    if (parsed.engine && resolvedEngine !== requestedEngine) {
      try {
        process.kill(bootstrapPid, "SIGTERM");
      } catch {
        // Ignore race.
      }
      throw new Error(
        `Port ${parsed.port} is already serving launch engine ${resolvedEngine}. ` +
          `Use --engine ${resolvedEngine}, wait for shutdown, or choose --port.`
      );
    }
  }

  const daemonPid = health.pid;
  writePid(runtimePaths, mode, daemonPid);

  const now = new Date().toISOString();

  writeManagedState(runtimePaths, mode, {
    mode,
    pid: daemonPid,
    host: parsed.host,
    port: parsed.port,
    cdpPort: parsed.cdpPort,
    headless: parsed.headless,
    engine: mode === "launch" ? requestedEngine : null,
    idleTtlMs: parsed.idleTtlMs,
    serverUrl,
    wsEndpoint: health.wsEndpoint,
    startedAt: now,
    lastSeenAt: now,
    logFile,
    errFile,
  });

  const payload = {
    running: true,
    startedNow: true,
    mode,
    engine: mode === "launch" ? requestedEngine : null,
    serverUrl,
    wsEndpoint: health.wsEndpoint,
    pid: daemonPid,
    stateFile: getStateFile(runtimePaths, mode),
    extensionConnected: health.extensionConnected,
  };

  if (parsed.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (!parsed.silent) {
    console.log(`Started daemon (${mode})`);
    console.log(`  PID: ${daemonPid}`);
    console.log(`  Server: ${serverUrl}`);
    console.log(`  WS: ${health.wsEndpoint}`);
    if (mode === "launch") {
      console.log(`  Engine: ${requestedEngine}`);
    }
  }

  logger.info(
    {
      mode,
      engine: mode === "launch" ? requestedEngine : null,
      pid: daemonPid,
      serverUrl,
      wsEndpoint: health.wsEndpoint,
    },
    "daemon started"
  );

  return payload;
}

export async function daemonStatus(runtimePaths: RuntimePaths, options: StatusOptions) {
  const parsed = statusOptionsSchema.parse(options);

  const modes: ServerMode[] = parsed.mode ? [parsed.mode] : ["launch", "extension"];

  const daemons = await Promise.all(
    modes.map(async (mode) => {
      const state = readManagedState(runtimePaths, mode);
      if (!state) {
        return {
          mode,
          running: false,
          pid: null,
          serverUrl: null,
          wsEndpoint: null,
          stateFile: getStateFile(runtimePaths, mode),
          runtime: null,
        };
      }

      const alive = isProcessAlive(state.pid);
      const runtime = alive ? await getRuntime(state.serverUrl, 1000) : null;

      return {
        mode,
        running: alive && runtime !== null,
        pid: state.pid,
        engine: mode === "launch" ? (runtime?.engine ?? state.engine ?? "patchright") : null,
        serverUrl: state.serverUrl,
        wsEndpoint: runtime?.wsEndpoint ?? state.wsEndpoint,
        stateFile: getStateFile(runtimePaths, mode),
        runtime,
      };
    })
  );

  const payload = {
    running: daemons.some((entry) => entry.running),
    daemons,
  };

  if (parsed.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const daemon of daemons) {
      if (daemon.running) {
        console.log(`Daemon running (${daemon.mode})`);
        console.log(`  PID: ${daemon.pid}`);
        console.log(`  Server: ${daemon.serverUrl}`);
        console.log(`  WS: ${daemon.wsEndpoint}`);
      } else {
        console.log(`Daemon not running (${daemon.mode})`);
      }
    }
  }

  logger.info({ daemons: payload.daemons }, "daemon status");

  return payload;
}

export async function stopDaemon(runtimePaths: RuntimePaths, options: StopOptions) {
  const parsed = stopOptionsSchema.parse(options);

  const modes: ServerMode[] = parsed.mode ? [parsed.mode] : ["launch", "extension"];
  const results: Array<{
    mode: ServerMode;
    stopped: boolean;
    pid: number | null;
    serverUrl: string | null;
    reason?: string;
  }> = [];

  for (const mode of modes) {
    const state = readManagedState(runtimePaths, mode);
    if (!state) {
      results.push({
        mode,
        stopped: false,
        pid: null,
        serverUrl: null,
        reason: "not_running",
      });
      continue;
    }

    const shutdown = await shutdownServer(state.serverUrl, parsed.graceMs);
    if (!shutdown && isProcessAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // Ignore process race.
      }
    }

    removeManagedState(runtimePaths, mode);
    removePid(runtimePaths, mode);

    results.push({
      mode,
      stopped: true,
      pid: state.pid,
      serverUrl: state.serverUrl,
    });
  }

  const payload = {
    stoppedAny: results.some((item) => item.stopped),
    results,
  };

  if (parsed.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const result of results) {
      if (result.stopped) {
        console.log(`Stopped daemon (${result.mode})`);
        console.log(`  PID: ${result.pid}`);
      } else {
        console.log(`No daemon running (${result.mode})`);
      }
    }
  }

  logger.info({ results }, "daemon stop results");

  return payload;
}

export async function cleanDaemon(runtimePaths: RuntimePaths, options: CleanOptions) {
  const parsed = cleanOptionsSchema.parse(options);
  ensureRuntimePaths(runtimePaths);

  const removed: Array<{ mode: ServerMode; pid: number | null; stateFile: string }> = [];
  const modes: ServerMode[] = ["launch", "extension"];

  for (const mode of modes) {
    const state = readManagedState(runtimePaths, mode);
    const pid = readPid(runtimePaths, mode);
    const alivePid = pid !== null && isProcessAlive(pid);

    if (!state && pid === null) {
      continue;
    }

    const shouldRemove = parsed.staleOnly ? !alivePid : true;
    if (!shouldRemove) {
      continue;
    }

    if (state?.pid && isProcessAlive(state.pid) && !parsed.staleOnly) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // Ignore process race.
      }
    }

    removeManagedState(runtimePaths, mode);
    removePid(runtimePaths, mode);

    removed.push({
      mode,
      pid,
      stateFile: getStateFile(runtimePaths, mode),
    });
  }

  if (!parsed.staleOnly) {
    const lockDir = join(runtimePaths.run, "locks");
    if (existsSync(lockDir)) {
      for (const entry of readdirSync(lockDir)) {
        rmSync(join(lockDir, entry), { force: true, recursive: true });
      }
    }
  }

  const payload = { cleaned: true, staleOnly: parsed.staleOnly, removed };
  if (parsed.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Cleaned daemon state (${parsed.staleOnly ? "stale only" : "all"})`);
    console.log(`  Removed entries: ${removed.length}`);
  }

  logger.info({ staleOnly: parsed.staleOnly, removed }, "daemon clean completed");

  return payload;
}

export async function showLogs(runtimePaths: RuntimePaths, options: LogsOptions) {
  const parsed = logsOptionsSchema.parse(options);
  const state = readManagedState(runtimePaths, parsed.mode);
  const logFile = state?.logFile ?? getLogFile(runtimePaths, parsed.mode);

  if (!existsSync(logFile)) {
    throw new Error(`Log file not found: ${logFile}`);
  }

  if (!parsed.follow) {
    await execa("tail", ["-n", "200", logFile], { stdio: "inherit" });
    return;
  }

  await execa("tail", ["-n", "200", "-f", logFile], { stdio: "inherit" });
}

export async function doctor(runtimePaths: RuntimePaths) {
  ensureRuntimePaths(runtimePaths);
  const modes: ServerMode[] = ["launch", "extension"];
  const status = [] as Array<{
    mode: ServerMode;
    state: ReturnType<typeof readManagedState>;
    pidFile: number | null;
    alive: boolean;
    health: Awaited<ReturnType<typeof getHealth>>;
  }>;

  for (const mode of modes) {
    const state = readManagedState(runtimePaths, mode);
    const pidFile = readPid(runtimePaths, mode);
    const alive = pidFile !== null ? isProcessAlive(pidFile) : false;
    const health = state ? await getHealth(state.serverUrl, 1000) : null;

    status.push({ mode, state, pidFile, alive, health });
  }

  const payload = {
    runtimePaths,
    daemon: status.map((item) => ({
      mode: item.mode,
      state: item.state ? stateToSummary(item.state) : null,
      pidFile: item.pidFile,
      alive: item.alive,
      healthy: item.health !== null,
    })),
  };

  console.log(JSON.stringify(payload, null, 2));
  logger.info({ payload }, "daemon doctor report");
  return payload;
}
