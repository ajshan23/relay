import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/*
 * Calling addresses a business typed in (web pages to learn from, their own API, an MCP server)
 * without letting them reach the server's own network: only public addresses, checked again when the
 * connection is made so a name that changes its answer (DNS rebinding) can't get round the check.
 */

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

export type NetOptions = {
  /** Local test servers only (AGENT_TOOLS_ALLOW_PRIVATE=1 in development and tests). */
  allowPrivate?: boolean;
};

const notPublic = "That address isn't on the public internet.";

/** Throws unless the address is http(s), has no password in it, and points at the public internet. */
export async function assertPublicUrl(raw: string, opts: NetOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That isn't a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only web addresses (http or https) can be used.");
  if (url.username || url.password) throw new Error("Addresses with a username or password can't be used.");
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error(notPublic);
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup for sockets that refuses private answers. */
function publicLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address)))
      return callback(Object.assign(new Error(notPublic), { code: "ENOTPUBLIC" }), "");
    if (options.all) return callback(null, addresses);
    const first = addresses[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
}

let guarded: Agent | null = null;

/**
 * fetch that only connects to public addresses (every connection, including redirects). Literal IP
 * addresses don't go through DNS, so check the URL with assertPublicUrl first as well.
 */
export function publicFetch(opts: NetOptions = {}): typeof fetch {
  if (opts.allowPrivate) return fetch;
  guarded ??= new Agent({ connect: { lookup: publicLookup as never } });
  const dispatcher = guarded;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    const host = new URL(target).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host)) throw new Error(notPublic);
    try {
      return await undiciFetch(input as never, { ...(init as object), dispatcher } as never);
    } catch (err) {
      // undici wraps connection errors as "fetch failed"; say why when it was this guard.
      if ((err as { cause?: { code?: string } }).cause?.code === "ENOTPUBLIC") throw new Error(notPublic);
      throw err;
    }
  }) as unknown as typeof fetch;
}

/** Reads a response body as text, refusing more than `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("The answer was too big.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
