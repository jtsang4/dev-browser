/**
 * CDP Relay Server for Chrome Extension mode.
 *
 * Bridges Patchright CDP clients to the browser extension, while preserving
 * named page semantics used by the rest of the project.
 */

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type {
  HealthResponse,
  RuntimePaths,
  RuntimeResponse,
  ServerInfoResponse,
  ShutdownRequest,
  ShutdownResponse,
} from "./types";

export interface RelayOptions {
  port?: number;
  host?: string;
  idleTtlMs?: number;
  serverUrl?: string;
  runtimePaths?: RuntimePaths;
}

export interface RelayServer {
  wsEndpoint: string;
  port: number;
  stop(): Promise<void>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
}

interface ConnectedTarget {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
}

interface PatchrightClient {
  id: string;
  ws: WSContext;
  knownTargets: Set<string>;
}

interface ExtensionResponseMessage {
  id: number;
  result?: unknown;
  error?: string;
}

interface ExtensionEventMessage {
  method: "forwardCDPEvent";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionEventMessage
  | { method: "log"; params: { level: string; args: string[] } };

interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface CDPResponse {
  id: number;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}

interface CDPEvent {
  method: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

export async function serveRelay(options: RelayOptions = {}): Promise<RelayServer> {
  const port = options.port ?? 9222;
  const host = options.host ?? "127.0.0.1";
  const idleTtlMs = options.idleTtlMs ?? 1_800_000;
  const serverUrl = options.serverUrl ?? `http://${host}:${port}`;
  const runtimePaths = options.runtimePaths ?? null;

  const connectedTargets = new Map<string, ConnectedTarget>();
  const namedPages = new Map<string, string>();
  const patchrightClients = new Map<string, PatchrightClient>();
  let extensionWs: WSContext | null = null;

  const extensionPendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  let extensionMessageId = 0;
  const startedAt = Date.now();
  let lastActivityAt = new Date().toISOString();
  let cleanupPromise: Promise<void> | null = null;

  function markActivity() {
    lastActivityAt = new Date().toISOString();
  }

  function log(...args: unknown[]) {
    console.log("[relay]", ...args);
  }

  function buildHealthResponse(wsEndpoint: string): HealthResponse {
    return {
      status: extensionWs ? "ok" : "degraded",
      mode: "extension",
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      pageCount: namedPages.size,
      extensionConnected: extensionWs !== null,
      wsEndpoint,
      lastActivityAt,
      engine: null,
    };
  }

  function buildRuntimeResponse(wsEndpoint: string): RuntimeResponse {
    return {
      mode: "extension",
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      lastActivityAt,
      idleTtlMs,
      serverUrl,
      wsEndpoint,
      paths: runtimePaths,
      ports: {
        http: port,
        cdp: port,
      },
      headless: false,
      pageNames: Array.from(namedPages.keys()),
      extensionConnected: extensionWs !== null,
      engine: null,
    };
  }

  function sendToPatchright(message: CDPResponse | CDPEvent, clientId?: string) {
    const messageStr = JSON.stringify(message);
    if (clientId) {
      const client = patchrightClients.get(clientId);
      if (client) {
        client.ws.send(messageStr);
      }
      return;
    }

    for (const client of patchrightClients.values()) {
      client.ws.send(messageStr);
    }
  }

  function sendAttachedToTarget(
    target: ConnectedTarget,
    clientId?: string,
    waitingForDebugger = false
  ) {
    const event: CDPEvent = {
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.sessionId,
        targetInfo: { ...target.targetInfo, attached: true },
        waitingForDebugger,
      },
    };

    if (clientId) {
      const client = patchrightClients.get(clientId);
      if (client && !client.knownTargets.has(target.targetId)) {
        client.knownTargets.add(target.targetId);
        client.ws.send(JSON.stringify(event));
      }
      return;
    }

    for (const client of patchrightClients.values()) {
      if (!client.knownTargets.has(target.targetId)) {
        client.knownTargets.add(target.targetId);
        client.ws.send(JSON.stringify(event));
      }
    }
  }

  async function sendToExtension({
    method,
    params,
    timeout = 30_000,
  }: {
    method: string;
    params?: Record<string, unknown>;
    timeout?: number;
  }): Promise<unknown> {
    if (!extensionWs) {
      throw new Error("Extension not connected");
    }

    markActivity();

    const id = ++extensionMessageId;
    const message = { id, method, params };
    extensionWs.send(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        extensionPendingRequests.delete(id);
        reject(new Error(`Extension request timeout after ${timeout}ms: ${method}`));
      }, timeout);

      extensionPendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
    });
  }

  async function routeCdpCommand({
    method,
    params,
    sessionId,
  }: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<unknown> {
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/extension-relay",
          revision: "0",
          userAgent: "dev-browser-relay",
          jsVersion: "1.0",
        };

      case "Target.setDiscoverTargets":
      case "Target.setAutoAttach":
      case "Target.getBrowserContexts":
      case "Target.createBrowserContext":
        return {};

      case "Target.attachToBrowserTarget":
        return { sessionId: "browser" };

      case "Target.attachToTarget": {
        const targetId = params?.targetId as string | undefined;
        if (targetId) {
          const target = Array.from(connectedTargets.values()).find(
            (item) => item.targetId === targetId
          );
          if (target) {
            return { sessionId: target.sessionId };
          }
        }
        return {};
      }

      case "Target.getTargetInfo": {
        const targetId = params?.targetId as string | undefined;
        if (targetId) {
          const target = Array.from(connectedTargets.values()).find(
            (item) => item.targetId === targetId
          );
          if (target) {
            return { targetInfo: target.targetInfo };
          }
        }

        const firstTarget = Array.from(connectedTargets.values())[0];
        return { targetInfo: firstTarget?.targetInfo };
      }

      case "Target.getTargets":
        return {
          targetInfos: Array.from(connectedTargets.values()).map((item) => ({
            ...item.targetInfo,
            attached: true,
          })),
        };

      case "Target.createTarget":
      case "Target.closeTarget":
        return await sendToExtension({
          method: "forwardCDPCommand",
          params: { method, params },
        });

      default:
        return await sendToExtension({
          method: "forwardCDPCommand",
          params: { sessionId, method, params },
        });
    }
  }

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/", (c) => {
    markActivity();
    const response: ServerInfoResponse = {
      wsEndpoint: `ws://${host}:${port}/cdp`,
      extensionConnected: extensionWs !== null,
      mode: "extension",
      engine: null,
    };
    return c.json(response);
  });

  app.get("/health", (c) => {
    const response = buildHealthResponse(`ws://${host}:${port}/cdp`);
    return c.json(response);
  });

  app.get("/runtime", (c) => {
    const response = buildRuntimeResponse(`ws://${host}:${port}/cdp`);
    return c.json(response);
  });

  app.post("/admin/shutdown", async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as ShutdownRequest;
    const graceMs =
      typeof body.graceMs === "number" && Number.isFinite(body.graceMs) && body.graceMs >= 0
        ? Math.trunc(body.graceMs)
        : 3000;

    const response: ShutdownResponse = {
      success: true,
      shuttingDown: true,
      graceMs,
    };

    setTimeout(() => {
      void cleanup().then(() => process.exit(0));
    }, graceMs).unref();

    return c.json(response);
  });

  app.get("/pages", (c) => {
    markActivity();
    return c.json({ pages: Array.from(namedPages.keys()) });
  });

  app.post("/pages", async (c) => {
    markActivity();
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const name = body.name;

    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }

    const existingSessionId = namedPages.get(name);
    if (existingSessionId) {
      const target = connectedTargets.get(existingSessionId);
      if (target) {
        await sendToExtension({
          method: "forwardCDPCommand",
          params: {
            method: "Target.activateTarget",
            params: { targetId: target.targetId },
          },
        });

        return c.json({
          wsEndpoint: `ws://${host}:${port}/cdp`,
          name,
          targetId: target.targetId,
          url: target.targetInfo.url,
        });
      }

      namedPages.delete(name);
    }

    if (!extensionWs) {
      return c.json({ error: "Extension not connected" }, 503);
    }

    try {
      const result = (await sendToExtension({
        method: "forwardCDPCommand",
        params: { method: "Target.createTarget", params: { url: "about:blank" } },
      })) as { targetId: string };

      await new Promise((resolve) => setTimeout(resolve, 200));

      for (const [sessionId, target] of connectedTargets) {
        if (target.targetId === result.targetId) {
          namedPages.set(name, sessionId);
          await sendToExtension({
            method: "forwardCDPCommand",
            params: {
              method: "Target.activateTarget",
              params: { targetId: target.targetId },
            },
          });

          return c.json({
            wsEndpoint: `ws://${host}:${port}/cdp`,
            name,
            targetId: target.targetId,
            url: target.targetInfo.url,
          });
        }
      }

      throw new Error("Target created but not found in registry");
    } catch (error) {
      log("Error creating tab:", error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.delete("/pages/:name", (c) => {
    markActivity();
    const name = c.req.param("name");
    const deleted = namedPages.delete(name);
    return c.json({ success: deleted });
  });

  app.get(
    "/cdp/:clientId?",
    upgradeWebSocket((c) => {
      const clientId =
        c.req.param("clientId") || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      return {
        onOpen(_event, ws) {
          markActivity();
          if (patchrightClients.has(clientId)) {
            ws.close(1000, "Client ID already connected");
            return;
          }

          patchrightClients.set(clientId, { id: clientId, ws, knownTargets: new Set() });
          log(`Patchright client connected: ${clientId}`);
        },

        async onMessage(event) {
          markActivity();
          let message: CDPCommand;
          try {
            message = JSON.parse(event.data.toString()) as CDPCommand;
          } catch {
            return;
          }

          const { id, sessionId, method, params } = message;
          if (!extensionWs) {
            sendToPatchright(
              {
                id,
                sessionId,
                error: { message: "Extension not connected" },
              },
              clientId
            );
            return;
          }

          try {
            const result = await routeCdpCommand({ method, params, sessionId });

            if (method === "Target.setAutoAttach" && !sessionId) {
              for (const target of connectedTargets.values()) {
                sendAttachedToTarget(target, clientId);
              }
            }

            if (
              method === "Target.setDiscoverTargets" &&
              (params as { discover?: boolean })?.discover
            ) {
              for (const target of connectedTargets.values()) {
                sendToPatchright(
                  {
                    method: "Target.targetCreated",
                    params: {
                      targetInfo: { ...target.targetInfo, attached: true },
                    },
                  },
                  clientId
                );
              }
            }

            if (
              method === "Target.attachToTarget" &&
              (result as { sessionId?: string })?.sessionId
            ) {
              const targetId = params?.targetId as string;
              const target = Array.from(connectedTargets.values()).find(
                (item) => item.targetId === targetId
              );
              if (target) {
                sendAttachedToTarget(target, clientId);
              }
            }

            sendToPatchright({ id, sessionId, result }, clientId);
          } catch (error) {
            sendToPatchright(
              {
                id,
                sessionId,
                error: { message: error instanceof Error ? error.message : String(error) },
              },
              clientId
            );
          }
        },

        onClose() {
          markActivity();
          patchrightClients.delete(clientId);
          log(`Patchright client disconnected: ${clientId}`);
        },

        onError(event) {
          log(`Patchright WebSocket error [${clientId}]:`, event);
        },
      };
    })
  );

  app.get(
    "/extension",
    upgradeWebSocket(() => {
      return {
        onOpen(_event, ws) {
          markActivity();
          if (extensionWs) {
            extensionWs.close(4001, "Extension Replaced");
            connectedTargets.clear();
            namedPages.clear();

            for (const pending of extensionPendingRequests.values()) {
              pending.reject(new Error("Extension connection replaced"));
            }
            extensionPendingRequests.clear();
          }

          extensionWs = ws;
          log("Extension connected");
        },

        async onMessage(event, ws) {
          markActivity();
          let message: ExtensionMessage;
          try {
            message = JSON.parse(event.data.toString()) as ExtensionMessage;
          } catch {
            ws.close(1000, "Invalid JSON");
            return;
          }

          if ("id" in message && typeof message.id === "number") {
            const pending = extensionPendingRequests.get(message.id);
            if (!pending) {
              return;
            }

            extensionPendingRequests.delete(message.id);
            if ((message as ExtensionResponseMessage).error) {
              pending.reject(new Error((message as ExtensionResponseMessage).error));
            } else {
              pending.resolve((message as ExtensionResponseMessage).result);
            }
            return;
          }

          if ("method" in message && message.method === "log") {
            const { level, args } = message.params;
            console.log(`[extension:${level}]`, ...args);
            return;
          }

          if ("method" in message && message.method === "forwardCDPEvent") {
            const eventMsg = message as ExtensionEventMessage;
            const { method, params, sessionId } = eventMsg.params;

            if (method === "Target.attachedToTarget") {
              const targetParams = params as { sessionId: string; targetInfo: TargetInfo };
              const target: ConnectedTarget = {
                sessionId: targetParams.sessionId,
                targetId: targetParams.targetInfo.targetId,
                targetInfo: targetParams.targetInfo,
              };
              connectedTargets.set(targetParams.sessionId, target);
              sendAttachedToTarget(target);
              return;
            }

            if (method === "Target.detachedFromTarget") {
              const detachParams = params as { sessionId: string };
              connectedTargets.delete(detachParams.sessionId);

              for (const [name, sid] of namedPages) {
                if (sid === detachParams.sessionId) {
                  namedPages.delete(name);
                  break;
                }
              }

              sendToPatchright({
                method: "Target.detachedFromTarget",
                params: detachParams,
              });
              return;
            }

            if (method === "Target.targetInfoChanged") {
              const infoParams = params as { targetInfo: TargetInfo };
              for (const target of connectedTargets.values()) {
                if (target.targetId === infoParams.targetInfo.targetId) {
                  target.targetInfo = infoParams.targetInfo;
                  break;
                }
              }

              sendToPatchright({
                method: "Target.targetInfoChanged",
                params: infoParams,
              });
              return;
            }

            sendToPatchright({ sessionId, method, params });
          }
        },

        onClose(_event, ws) {
          markActivity();
          if (extensionWs && extensionWs !== ws) {
            return;
          }

          for (const pending of extensionPendingRequests.values()) {
            pending.reject(new Error("Extension connection closed"));
          }
          extensionPendingRequests.clear();

          extensionWs = null;
          connectedTargets.clear();
          namedPages.clear();

          for (const client of patchrightClients.values()) {
            client.ws.close(1000, "Extension disconnected");
          }
          patchrightClients.clear();
        },

        onError(event) {
          log("Extension WebSocket error:", event);
        },
      };
    })
  );

  const server = serve({ fetch: app.fetch, port, hostname: host });
  injectWebSocket(server);

  const wsEndpoint = `ws://${host}:${port}/cdp`;
  log("CDP relay server started");
  log(`  HTTP: ${serverUrl}`);
  log(`  CDP endpoint: ${wsEndpoint}`);

  const idleInterval = setInterval(() => {
    const idleMs = Date.now() - new Date(lastActivityAt).getTime();
    if (idleMs >= idleTtlMs) {
      log(`Idle TTL reached (${idleTtlMs}ms). Shutting down...`);
      void cleanup().then(() => process.exit(0));
    }
  }, 60_000);
  idleInterval.unref();

  const cleanup = async () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = (async () => {
      clearInterval(idleInterval);

      for (const client of patchrightClients.values()) {
        client.ws.close(1000, "Server stopped");
      }
      patchrightClients.clear();

      extensionWs?.close(1000, "Server stopped");
      extensionWs = null;
      server.close();
    })();

    return cleanupPromise;
  };

  return {
    wsEndpoint,
    port,
    async stop() {
      await cleanup();
    },
  };
}
