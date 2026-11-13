import { classifyGraphError, GraphError, GraphUncertainError } from "./errors";

/*
 * A small Graph API client shared by every Meta channel. The base URL is configurable so tests can
 * point it at a local fake. Errors come back as GraphError (Meta answered) or GraphUncertainError
 * (no answer: the request may have gone through).
 */

export type GraphConfig = {
  baseUrl: string;
  version: string;
  /** The Meta app id, for app-level calls such as resumable uploads (template header examples). */
  appId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type GraphClient = ReturnType<typeof createGraphClient>;

/** Connection errors that mean the request never left this machine, so it is safe to retry. */
const notSentCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE_SEND"]);

export function createGraphClient(config: GraphConfig) {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function call(input: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code && notSentCodes.has(code)) {
        throw new GraphError(`Could not reach Meta (${code})`, "retryable", 0, undefined, undefined);
      }
      throw new GraphUncertainError(`No answer from Meta: ${(err as Error).message}`);
    }
  }

  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${config.baseUrl}/${config.version}/${path.replace(/^\//, "")}`;
    const res = await call(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        // FormData (file uploads) sets its own multipart content type.
        ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const error = (json.error ?? {}) as {
        message?: string;
        code?: number;
        error_data?: Record<string, unknown>;
      };
      throw new GraphError(
        error.message ?? `Graph API ${res.status}`,
        classifyGraphError(error.code, res.status),
        res.status,
        error.code,
        error.error_data,
      );
    }
    return json as T;
  }

  /** Downloads a file from a Meta media URL, which also needs the access token. */
  async function download(
    url: string,
    token: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
    const res = await call(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new GraphError(
        `Media download failed (${res.status})`,
        classifyGraphError(undefined, res.status),
        res.status,
        undefined,
        undefined,
      );
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > maxBytes) {
      throw new GraphError(
        `Media is larger than ${maxBytes} bytes`,
        "permanent",
        res.status,
        undefined,
        undefined,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new GraphError(
        `Media is larger than ${maxBytes} bytes`,
        "permanent",
        res.status,
        undefined,
        undefined,
      );
    }
    return { bytes, mimeType: res.headers.get("content-type") };
  }

  /**
   * Resumable upload (used for template header examples): start a session on the app, then send the
   * bytes. Returns the file handle Meta expects in `header_handle`.
   */
  async function resumableUpload(
    token: string,
    file: { bytes: Uint8Array; mimeType: string; fileName: string },
  ): Promise<string> {
    if (!config.appId) throw new GraphError("META_APP_ID is not set", "permanent", 0, undefined, undefined);
    const params = new URLSearchParams({
      file_name: file.fileName,
      file_length: String(file.bytes.byteLength),
      file_type: file.mimeType,
    });
    const session = await request<{ id?: string }>("POST", `${config.appId}/uploads?${params}`, token);
    if (!session.id) throw new Error("Meta did not start the upload");
    const res = await call(`${config.baseUrl}/${config.version}/${session.id}`, {
      method: "POST",
      headers: { authorization: `OAuth ${token}`, file_offset: "0" },
      body: new Uint8Array(file.bytes),
    });
    const json = (await res.json().catch(() => ({}))) as {
      h?: string;
      error?: { message?: string; code?: number };
    };
    if (!res.ok || !json.h)
      throw new GraphError(
        json.error?.message ?? `Upload failed (${res.status})`,
        classifyGraphError(json.error?.code, res.status),
        res.status,
        json.error?.code,
        undefined,
      );
    return json.h;
  }

  return { request, download, resumableUpload };
}
