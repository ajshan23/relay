import { randomBytes } from "node:crypto";
import { env, fileStorage } from "@relay/core";

/*
 * Checks the file storage end to end: stores a small test file, confirms it exists, reads it back
 * byte for byte, downloads it through a signed link (the way browsers fetch media), and deletes it.
 * Prints where files go, never the keys.
 * Run: pnpm --filter @relay/worker storage:check
 */

const config = env();
const storage = fileStorage();
const endpoint = config.S3_ENDPOINT ?? config.AWS_ENDPOINT_URL_S3;
console.log(
  storage.driver === "s3"
    ? `Storage: S3 bucket "${config.S3_BUCKET}" at ${endpoint ? new URL(endpoint).host : "AWS"}`
    : `Storage: local disk ${config.MEDIA_DIR}`,
);

const key = `checks/${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
const body = new TextEncoder().encode(`Relay storage check ${new Date().toISOString()}`);
const step = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
};

try {
  await storage.put(key, body, { contentType: "text/plain" });
  step("upload", true, key);

  step("exists", await storage.exists(key));

  const back = await storage.get(key);
  step("read back", Buffer.compare(Buffer.from(back), Buffer.from(body)) === 0, `${back.length} bytes`);

  const url = await storage.signedUrl(key, { contentType: "text/plain", inline: true, expiresIn: 60 });
  if (url?.startsWith("http")) {
    const res = await fetch(url);
    const text = await res.text();
    step("signed link", res.ok && text === new TextDecoder().decode(body), `HTTP ${res.status}`);
  } else {
    step("signed link", true, "local disk serves files through the API");
  }
} catch (err) {
  step("storage", false, err instanceof Error ? err.message : String(err));
} finally {
  await storage.delete(key).catch(() => undefined);
  if (process.exitCode !== 1) step("delete", !(await storage.exists(key).catch(() => true)));
}
