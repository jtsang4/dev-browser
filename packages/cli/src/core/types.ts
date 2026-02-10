// API request/response types - shared between client and server

export type ServerMode = "launch" | "extension";
export type BrowserEngine = "patchright" | "playwright";

export interface RuntimePaths {
  root: string;
  state: string;
  run: string;
  data: string;
  cache: string;
  logs: string;
}

export interface ServeOptions {
  port?: number;
  host?: string;
  headless?: boolean;
  cdpPort?: number;
  engine?: BrowserEngine;
  idleTtlMs?: number;
  serverUrl?: string;
  runtimePaths?: RuntimePaths;
  /** Engine-specific userDataDir for persistent browser profile */
  profileDir?: string;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface GetPageRequest {
  name: string;
  /** Optional viewport size for new pages */
  viewport?: ViewportSize;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
  mode?: ServerMode;
  extensionConnected?: boolean;
  engine?: BrowserEngine | null;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  mode: ServerMode;
  pid: number;
  uptimeMs: number;
  pageCount: number;
  extensionConnected: boolean | null;
  wsEndpoint: string;
  lastActivityAt: string;
  engine?: BrowserEngine | null;
}

export interface RuntimeResponse {
  mode: ServerMode;
  pid: number;
  startedAt: string;
  lastActivityAt: string;
  idleTtlMs: number;
  serverUrl: string;
  wsEndpoint: string;
  paths: RuntimePaths | null;
  ports: {
    http: number;
    cdp: number;
  };
  headless: boolean;
  pageNames: string[];
  extensionConnected: boolean | null;
  engine?: BrowserEngine | null;
}

export interface ShutdownRequest {
  graceMs?: number;
}

export interface ShutdownResponse {
  success: true;
  shuttingDown: true;
  graceMs: number;
}
