import express, { type Express, type Request, type Response } from "express";
import { mkdirSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import type {
  BrowserEngine,
  GetPageRequest,
  GetPageResponse,
  HealthResponse,
  ListPagesResponse,
  RuntimeResponse,
  ServerInfoResponse,
  ServeOptions,
  ShutdownRequest,
  ShutdownResponse,
} from "./types";

export type {
  GetPageResponse,
  HealthResponse,
  ListPagesResponse,
  RuntimeResponse,
  ServerInfoResponse,
  ServeOptions,
};

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

interface PageEntry {
  page: Page;
  targetId: string;
}

type Page = import("playwright").Page;
type BrowserContext = import("playwright").BrowserContext;

interface LaunchEngine {
  chromium: {
    launchPersistentContext: (
      userDataDir: string,
      options: {
        headless: boolean;
        args: string[];
      }
    ) => Promise<BrowserContext>;
  };
}

async function resolveEngine(engine: BrowserEngine = "patchright"): Promise<LaunchEngine> {
  if (engine === "playwright") {
    return (await import("playwright")) as unknown as LaunchEngine;
  }
  return (await import("patchright")) as unknown as LaunchEngine;
}

async function fetchWithRetry(
  url: string,
  maxRetries = 5,
  delayMs = 500
): Promise<globalThis.Response> {
  let lastError: Error | null = null;

  for (let index = 0; index < maxRetries; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (index < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (index + 1)));
      }
    }
  }

  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms);
    }),
  ]);
}

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const host = options.host ?? "127.0.0.1";
  const headless = options.headless ?? false;
  const engine = options.engine ?? "patchright";
  const cdpPort = options.cdpPort ?? 9223;
  const idleTtlMs = options.idleTtlMs ?? 1_800_000;
  const serverUrl = options.serverUrl ?? `http://${host}:${port}`;
  const runtimePaths = options.runtimePaths ?? null;
  const profileDir = options.profileDir;

  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  const profileByEngineDir = profileDir ? profileDir : join(process.cwd(), ".browser-data", engine);

  mkdirSync(profileByEngineDir, { recursive: true });
  console.log(`Using persistent browser profile (${engine}): ${profileByEngineDir}`);

  const browserEngine = await resolveEngine(engine);

  const context: BrowserContext = await browserEngine.chromium.launchPersistentContext(
    profileByEngineDir,
    {
      headless,
      args: [`--remote-debugging-port=${cdpPort}`],
    }
  );
  console.log(`Browser launched with persistent profile (${engine})...`);

  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;

  const registry = new Map<string, PageEntry>();
  const startedAt = Date.now();
  let lastActivityAt = new Date().toISOString();
  let cleanupPromise: Promise<void> | null = null;
  let cleaningUp = false;

  function markActivity() {
    lastActivityAt = new Date().toISOString();
  }

  function buildHealthResponse(): HealthResponse {
    return {
      status: "ok",
      mode: "launch",
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      pageCount: registry.size,
      extensionConnected: null,
      wsEndpoint,
      lastActivityAt,
      engine,
    };
  }

  function buildRuntimeResponse(): RuntimeResponse {
    return {
      mode: "launch",
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      lastActivityAt,
      idleTtlMs,
      serverUrl,
      wsEndpoint,
      paths: runtimePaths,
      ports: {
        http: port,
        cdp: cdpPort,
      },
      headless,
      pageNames: Array.from(registry.keys()),
      extensionConnected: null,
      engine,
    };
  }

  async function getTargetId(page: Page): Promise<string> {
    const cdpSession = await context.newCDPSession(page);
    try {
      const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await cdpSession.detach();
    }
  }

  const app: Express = express();
  app.use(express.json());

  app.get("/", (_req: Request, res: Response) => {
    markActivity();
    const response: ServerInfoResponse = { wsEndpoint, mode: "launch", engine };
    res.json(response);
  });

  app.get("/health", (_req: Request, res: Response) => {
    const response = buildHealthResponse();
    res.json(response);
  });

  app.get("/runtime", (_req: Request, res: Response) => {
    const response = buildRuntimeResponse();
    res.json(response);
  });

  app.get("/pages", (_req: Request, res: Response) => {
    markActivity();
    const response: ListPagesResponse = {
      pages: Array.from(registry.keys()),
    };
    res.json(response);
  });

  app.post("/pages", async (req: Request, res: Response) => {
    markActivity();
    const body = req.body as GetPageRequest;
    const { name, viewport } = body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required and must be a string" });
      return;
    }
    if (name.length === 0) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    if (name.length > 256) {
      res.status(400).json({ error: "name must be 256 characters or less" });
      return;
    }

    let entry = registry.get(name);
    if (!entry) {
      const page = await withTimeout(
        context.newPage(),
        30_000,
        "Page creation timed out after 30s"
      );

      if (viewport) {
        await page.setViewportSize(viewport);
      }

      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      page.on("close", () => {
        registry.delete(name);
        markActivity();
      });
    }

    const response: GetPageResponse = { wsEndpoint, name, targetId: entry.targetId };
    res.json(response);
  });

  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response) => {
    markActivity();
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (entry) {
      await entry.page.close();
      registry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(404).json({ error: "page not found" });
  });

  app.post("/admin/shutdown", (req: Request, res: Response) => {
    markActivity();
    const body = (req.body ?? {}) as ShutdownRequest;
    const graceMs =
      typeof body.graceMs === "number" && Number.isFinite(body.graceMs) && body.graceMs >= 0
        ? Math.trunc(body.graceMs)
        : 3000;

    const response: ShutdownResponse = {
      success: true,
      shuttingDown: true,
      graceMs,
    };
    res.json(response);

    setTimeout(() => {
      void cleanup().then(() => process.exit(0));
    }, graceMs).unref();
  });

  const server = app.listen(port, host, () => {
    console.log(`HTTP API server running on ${host}:${port}`);
  });

  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  const idleInterval = setInterval(() => {
    const idleMs = Date.now() - new Date(lastActivityAt).getTime();
    if (idleMs >= idleTtlMs) {
      console.log(`Idle TTL reached (${idleTtlMs}ms). Shutting down...`);
      void cleanup().then(() => process.exit(0));
    }
  }, 60_000);
  idleInterval.unref();

  const cleanup = async () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = (async () => {
      if (cleaningUp) {
        return;
      }
      cleaningUp = true;

      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();

      for (const entry of registry.values()) {
        try {
          await entry.page.close();
        } catch {
          // Ignore close race.
        }
      }
      registry.clear();

      try {
        await context.close();
      } catch {
        // Context may already be closed.
      }

      clearInterval(idleInterval);
      server.close();
    })();

    return cleanupPromise;
  };

  const syncCleanup = () => {
    try {
      context.close();
    } catch {
      // best effort
    }
  };

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const signalHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  const errorHandler = async (error: unknown) => {
    console.error("Unhandled error:", error);
    await cleanup();
    process.exit(1);
  };

  signals.forEach((signal) => process.on(signal, signalHandler));
  process.on("uncaughtException", errorHandler);
  process.on("unhandledRejection", errorHandler);
  process.on("exit", syncCleanup);

  const removeHandlers = () => {
    signals.forEach((signal) => process.off(signal, signalHandler));
    process.off("uncaughtException", errorHandler);
    process.off("unhandledRejection", errorHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint,
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
