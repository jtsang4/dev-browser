import { Command } from "commander";
import { z } from "zod";
import { cleanDaemon, daemonStatus, doctor, ensureDaemon, showLogs, stopDaemon } from "./daemon";
import { getRuntimePaths } from "./paths";
import { runCode } from "./run";

const modeSchema = z.enum(["launch", "extension"]);
const engineSchema = z.enum(["patchright", "playwright"]);

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

async function main() {
  const program = new Command();

  program
    .name("dev-browser")
    .description("Managed browser automation daemon and runner")
    .version("0.0.1");

  const daemon = program.command("daemon").description("Manage dev-browser daemon lifecycle");

  daemon
    .command("ensure")
    .description("Ensure daemon is running")
    .option("--mode <mode>", "Daemon mode: launch|extension", "launch")
    .option("--headless", "Headless browser mode")
    .option(
      "--engine <engine>",
      "Browser engine (launch mode): patchright|playwright",
      "patchright"
    )
    .option("--json", "Output JSON")
    .option("--host <host>", "Server host", "127.0.0.1")
    .option("--port <port>", "Server HTTP port", parseIntOption, 9222)
    .option("--cdp-port <port>", "CDP port", parseIntOption, 9223)
    .option("--idle-ttl-ms <ms>", "Idle TTL in ms", parseIntOption, 1_800_000)
    .action(async (opts) => {
      const runtimePaths = getRuntimePaths();
      const mode = modeSchema.parse(opts.mode);
      const engine = engineSchema.parse(opts.engine);
      await ensureDaemon(runtimePaths, {
        mode,
        headless: Boolean(opts.headless),
        engine,
        json: Boolean(opts.json),
        host: opts.host,
        port: opts.port,
        cdpPort: opts.cdpPort,
        idleTtlMs: opts.idleTtlMs,
      });
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .option("--mode <mode>", "Daemon mode: launch|extension")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const runtimePaths = getRuntimePaths();
      const mode = opts.mode ? modeSchema.parse(opts.mode) : undefined;
      await daemonStatus(runtimePaths, { mode, json: Boolean(opts.json) });
    });

  daemon
    .command("stop")
    .description("Stop daemon")
    .option("--mode <mode>", "Daemon mode: launch|extension")
    .option("--grace-ms <ms>", "Graceful shutdown timeout", parseIntOption, 3000)
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const runtimePaths = getRuntimePaths();
      const mode = opts.mode ? modeSchema.parse(opts.mode) : undefined;
      await stopDaemon(runtimePaths, {
        mode,
        graceMs: opts.graceMs,
        json: Boolean(opts.json),
      });
    });

  daemon
    .command("clean")
    .description("Clean stale daemon state")
    .option("--stale-only", "Only clean stale state")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const runtimePaths = getRuntimePaths();
      await cleanDaemon(runtimePaths, {
        staleOnly: Boolean(opts.staleOnly),
        json: Boolean(opts.json),
      });
    });

  daemon
    .command("logs")
    .description("Show daemon logs")
    .option("--mode <mode>", "Daemon mode: launch|extension", "launch")
    .option("--follow", "Follow log output")
    .action(async (opts) => {
      const runtimePaths = getRuntimePaths();
      const mode = modeSchema.parse(opts.mode);
      await showLogs(runtimePaths, { mode, follow: Boolean(opts.follow) });
    });

  program
    .command("doctor")
    .description("Show runtime diagnostics")
    .action(async () => {
      const runtimePaths = getRuntimePaths();
      await doctor(runtimePaths);
    });

  program
    .command("run")
    .description("Run JavaScript automation against a named page")
    .requiredOption("--page <name>", "Page name")
    .requiredOption("--code <javascript>", "JavaScript code body to execute")
    .option("--mode <mode>", "Daemon mode: launch|extension", "launch")
    .option("--timeout-ms <ms>", "Execution timeout in ms", parseIntOption, 120_000)
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const runtimePaths = getRuntimePaths();
      const mode = modeSchema.parse(opts.mode);
      const result = await runCode(runtimePaths, {
        page: opts.page,
        code: opts.code,
        mode,
        timeoutMs: opts.timeoutMs,
        json: Boolean(opts.json),
      });

      if (!result.ok) {
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
