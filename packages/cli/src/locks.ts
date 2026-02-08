import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const LOCK_STALE_MS = 120_000;

export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });

  const fileHandle = openSync(lockPath, "a");
  closeSync(fileHandle);

  const release = await lockfile.lock(lockPath, {
    stale: LOCK_STALE_MS,
    retries: {
      retries: 40,
      factor: 1.2,
      minTimeout: 50,
      maxTimeout: 1000,
    },
  });

  try {
    return await fn();
  } finally {
    await release();
  }
}
