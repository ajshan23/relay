import { assertPublicUrl, isPrivateAddress } from "@relay/core/net";

/*
 * Turning a knowledge source into plain text: PDF and Word files, text files, and one web page.
 * Web pages are fetched carefully: only public addresses, a few redirects (each checked), a size cap
 * and a time limit, so a business can't point the agent at the server's own network.
 */

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export async function fileText(
  bytes: Uint8Array,
  mimeType: string | null,
  fileName: string | null,
): Promise<string> {
  const name = (fileName ?? "").toLowerCase();
  const mime = (mimeType ?? "").toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (mime.includes("officedocument.wordprocessingml") || name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value;
  }
  if (mime.startsWith("text/") || /\.(txt|md|csv)$/.test(name)) return new TextDecoder().decode(bytes);
  throw new Error("This file type can't be read yet. Use PDF, Word (.docx), or a text file.");
}

export { assertPublicUrl, isPrivateAddress };

/** Fetches one public page and returns its title and readable text. */
export async function pageText(raw: string): Promise<{ title: string; text: string }> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "RelayKnowledgeBot/1.0", accept: "text/html,text/plain;q=0.9" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location") as string, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`The page answered ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/.test(type))
      throw new Error("That address isn't a web page.");
    const body = await readCapped(res);
    if (type.includes("text/plain")) return { title: url.hostname, text: body };
    return htmlToText(body, url.hostname);
  }
  throw new Error("The page redirected too many times.");
}

/**
 * Downloads one public file (a product photo link in an import), with the same address checks as
 * pages, a few checked redirects, and a size cap. Throws with a reason people can act on.
 */
export async function fetchPublicFile(
  raw: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": "RelayCatalogBot/1.0", accept: "image/*,video/*,audio/*,application/pdf" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location") as string, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`The link answered ${res.status}.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error("The file at that link is too big.");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("The link had no file.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("The file at that link is too big.");
      }
      chunks.push(value);
    }
    return {
      bytes: new Uint8Array(Buffer.concat(chunks)),
      contentType: (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
    };
  }
  throw new Error("The link redirected too many times.");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Readable text from HTML: no scripts, styles or navigation chrome, blocks on their own lines. */
export function htmlToText(html: string, fallbackTitle = ""): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "") || fallbackTitle;
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|ul|ol|table|header|main)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return entities[code.toLowerCase()] ?? m;
  });
}
