import { connect, waitForPageLoad } from "./core/client";
import { z } from "zod";
import type { RuntimePaths, ServerMode } from "./types";
import { ensureRuntimePaths, getPageLockFile } from "./paths";
import { ensureDaemon } from "./daemon";
import { withLock } from "./locks";
import { logger } from "./logger";

const runOptionsSchema = z.object({
  page: z.string().min(1).max(256),
  code: z.string().min(1),
  mode: z.enum(["launch", "extension"]).default("launch"),
  timeoutMs: z.number().int().positive().default(120_000),
  json: z.boolean().default(false),
});

interface RunOptions {
  page: string;
  code: string;
  mode?: ServerMode;
  timeoutMs?: number;
  json?: boolean;
}

interface RunErrorResult {
  ok: false;
  mode: ServerMode;
  pageName: string;
  error: {
    code: "RUN_TIMEOUT" | "RUN_EXEC_ERROR";
    message: string;
    retryable: boolean;
  };
  timingMs: number;
}

interface RunSuccessResult {
  ok: true;
  mode: ServerMode;
  pageName: string;
  data: unknown;
  logs: unknown[];
  timingMs: number;
}

type RunResult = RunSuccessResult | RunErrorResult;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Execution timed out after ${ms}ms`));
    }, ms);
    timeout.unref();
  });
}

export async function runCode(runtimePaths: RuntimePaths, options: RunOptions): Promise<RunResult> {
  const parsed = runOptionsSchema.parse(options);
  ensureRuntimePaths(runtimePaths);
  logger.info({ mode: parsed.mode, page: parsed.page }, "run requested");

  const ensured = await ensureDaemon(runtimePaths, {
    mode: parsed.mode,
    json: false,
    silent: true,
  });

  const lockPath = getPageLockFile(runtimePaths, parsed.page);
  const startedAt = Date.now();

  const result = await withLock(lockPath, async () => {
    const client = await connect(ensured.serverUrl);

    try {
      const page = await client.page(parsed.page);
      const logs: unknown[] = [];

      const log = (entry: unknown) => {
        logs.push(entry);
      };

      const AsyncFunction = Object.getPrototypeOf(async function () {
        // noop
      }).constructor as new (
        ...args: string[]
      ) => (
        page: unknown,
        client: unknown,
        helpers: unknown,
        log: (entry: unknown) => void
      ) => unknown;

      const runner = new AsyncFunction("page", "client", "helpers", "log", parsed.code);
      const helpers = {
        waitForPageLoad,
      };

      const runPromise = Promise.resolve(runner(page, client, helpers, log));
      const data = await Promise.race([runPromise, createTimeoutPromise(parsed.timeoutMs)]);

      const success: RunSuccessResult = {
        ok: true,
        mode: parsed.mode,
        pageName: parsed.page,
        data,
        logs,
        timingMs: Date.now() - startedAt,
      };
      logger.info(
        { mode: parsed.mode, page: parsed.page, timingMs: success.timingMs },
        "run completed successfully"
      );
      return success;
    } catch (error) {
      const message = formatError(error);
      const isTimeout = message.includes("timed out");
      const failure: RunErrorResult = {
        ok: false,
        mode: parsed.mode,
        pageName: parsed.page,
        error: {
          code: isTimeout ? "RUN_TIMEOUT" : "RUN_EXEC_ERROR",
          message,
          retryable: isTimeout,
        },
        timingMs: Date.now() - startedAt,
      };
      logger.warn(
        {
          mode: parsed.mode,
          page: parsed.page,
          timingMs: failure.timingMs,
          code: failure.error.code,
        },
        "run failed"
      );
      return failure;
    } finally {
      await client.disconnect();
    }
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Run succeeded on page "${result.pageName}" (${result.mode})`);
    console.log(`  timing: ${result.timingMs}ms`);
    if (result.logs.length > 0) {
      console.log(`  logs: ${JSON.stringify(result.logs)}`);
    }
    if (typeof result.data !== "undefined") {
      console.log(`  data: ${JSON.stringify(result.data)}`);
    }
  } else {
    console.error(`Run failed on page "${result.pageName}" (${result.mode})`);
    console.error(`  code: ${result.error.code}`);
    console.error(`  message: ${result.error.message}`);
    console.error(`  retryable: ${result.error.retryable}`);
  }

  return result;
}
