import { resolve } from "node:path";
import { serveRelay } from "../core/relay";
import { getRuntimePaths } from "../paths";

function parseArgs(args: string[]) {
  const options: {
    host: string;
    port: number;
    idleTtlMs: number;
    runtimeRoot?: string;
  } = {
    host: "127.0.0.1",
    port: 9222,
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

const server = await serveRelay({
  host: options.host,
  port: options.port,
  idleTtlMs: options.idleTtlMs,
  runtimePaths,
  serverUrl: `http://${options.host}:${options.port}`,
});

console.log("Dev browser extension relay ready");
console.log(`  PID: ${process.pid}`);
console.log(`  HTTP: http://${options.host}:${options.port}`);
console.log(`  WS: ${server.wsEndpoint}`);
console.log(`  Runtime root: ${runtimePaths.root}`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

await new Promise(() => {
  // Keep process alive.
});
