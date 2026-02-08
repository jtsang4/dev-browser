import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "../core/server";
import { getRuntimePaths } from "../paths";

function parseArgs(args: string[]) {
  const options: {
    host: string;
    port: number;
    cdpPort: number;
    headless: boolean;
    idleTtlMs: number;
    runtimeRoot?: string;
  } = {
    host: "127.0.0.1",
    port: 9222,
    cdpPort: 9223,
    headless: false,
    idleTtlMs: 1_800_000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key) {
      continue;
    }

    switch (key) {
      case "--host":
        if (value) {
          options.host = value;
          index += 1;
        }
        break;
      case "--port":
        if (value) {
          options.port = Number.parseInt(value, 10);
          index += 1;
        }
        break;
      case "--cdp-port":
        if (value) {
          options.cdpPort = Number.parseInt(value, 10);
          index += 1;
        }
        break;
      case "--headless":
        if (value) {
          options.headless = value === "true";
          index += 1;
        } else {
          options.headless = true;
        }
        break;
      case "--idle-ttl-ms":
        if (value) {
          options.idleTtlMs = Number.parseInt(value, 10);
          index += 1;
        }
        break;
      case "--runtime-root":
        if (value) {
          options.runtimeRoot = value;
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const runtimePaths = options.runtimeRoot
  ? getRuntimePaths(resolve(options.runtimeRoot))
  : getRuntimePaths();
const profileDir = join(runtimePaths.data, "profiles", "launch");

mkdirSync(profileDir, { recursive: true });

const server = await serve({
  host: options.host,
  port: options.port,
  cdpPort: options.cdpPort,
  headless: options.headless,
  idleTtlMs: options.idleTtlMs,
  profileDir,
  serverUrl: `http://${options.host}:${options.port}`,
  runtimePaths,
});

console.log("Dev browser launch daemon ready");
console.log(`  PID: ${process.pid}`);
console.log(`  HTTP: http://${options.host}:${options.port}`);
console.log(`  WS: ${server.wsEndpoint}`);
console.log(`  Runtime root: ${runtimePaths.root}`);

await new Promise(() => {
  // Keep process alive until signal handlers in serve() terminate it.
});
