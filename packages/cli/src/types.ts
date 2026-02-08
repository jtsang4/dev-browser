export type ServerMode = "launch" | "extension";

export interface RuntimePaths {
  root: string;
  state: string;
  run: string;
  data: string;
  cache: string;
  logs: string;
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
}

export interface ShutdownResponse {
  success: true;
  shuttingDown: true;
  graceMs: number;
}
