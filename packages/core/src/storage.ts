import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Where Relay keeps files (customer media now; exports and uploads later). Local disk for now,
 * behind this small interface so S3 or R2 can replace it without touching callers.
 */

export type FileStorage = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
};

/** The repository root, so relative paths mean the same thing for the API, the worker and scripts. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function localFileStorage(dir: string): FileStorage {
  const base = isAbsolute(dir) ? dir : join(repoRoot, dir);
  const pathFor = (key: string) => {
    const full = normalize(join(base, key));
    if (!full.startsWith(base)) throw new Error("Invalid storage key");
    return full;
  };
  return {
    async put(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    async get(key) {
      return new Uint8Array(await readFile(pathFor(key)));
    },
  };
}
