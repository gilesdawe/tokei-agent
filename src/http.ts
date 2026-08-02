// HTTP layer for the tokei-agent CLI: URL construction, bearer auth,
// rate-limit header extraction, and error mapping. The caller injects a
// `fetch`-like implementation so tests never touch the network.

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

// Separate from FetchLike (used only by media.ts's step-2 signed-URL PUT):
// widening FetchLike's `body` to `string | Uint8Array` would break the ~31
// existing `JSON.parse(init.body!)` test assertions across the suite via
// arrow-type contravariance. Kept side-by-side instead.
export type BinaryFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array },
) => Promise<HttpResponse>;

export interface BinaryPutResult {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * Raw PUT of file bytes to an absolute (already-signed) URL — no baseUrl
 * prefixing, no bearer auth: the signing token lives in the URL's own query
 * string (see media.ts). Caller supplies exactly the headers the ticket
 * response specified.
 */
export async function putBinary(
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string>,
  fetchImpl: BinaryFetchLike,
): Promise<BinaryPutResult> {
  const res = await fetchImpl(url, { method: "PUT", headers, body: bytes });
  const text = await res.text();
  return { status: res.status, ok: res.status >= 200 && res.status < 300, text };
}

export interface RequestOptions {
  baseUrl: string;
  apiKey: string;
  path: string;
  query?: Record<string, string>;
  method?: HttpMethod;
  // JSON-serialised as the request body when defined. The CLI passes user
  // JSON through untouched — the API's 422 per-field errors are the
  // validation story.
  body?: unknown;
}

export interface RequestResult {
  payload: unknown;
  exitCode: 0 | 1;
  // HTTP status, or undefined when the request never reached a response
  // (network/DNS/timeout). Presentation-only: lets the interactive UI describe
  // a failure accurately instead of guessing. Never affects payload or exit
  // code.
  status?: number;
}

function extractRateLimit(res: HttpResponse): RateLimit | null {
  const limit = res.headers.get("X-RateLimit-Limit");
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const reset = res.headers.get("X-RateLimit-Reset");
  if (limit === null || remaining === null || reset === null) return null;
  return { limit: Number(limit), remaining: Number(remaining), reset: Number(reset) };
}

function augment(body: unknown, rateLimit: RateLimit | null): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), rate_limit: rateLimit };
  }
  return { data: body, rate_limit: rateLimit };
}

export async function request(
  opts: RequestOptions,
  fetchImpl: FetchLike,
): Promise<RequestResult> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  let url = `${base}/api/v1${opts.path}`;
  if (opts.query && Object.keys(opts.query).length > 0) {
    const qs = new URLSearchParams(opts.query).toString();
    url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    Accept: "application/json",
  };
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: opts.method ?? "GET",
    headers,
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  let res: HttpResponse;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      payload: { ok: false, error: { type: "network_error", message } },
      exitCode: 1,
    };
  }

  const rateLimit = extractRateLimit(res);
  const text = await res.text();

  let parsed: unknown;
  let isJson = true;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    isJson = false;
  }

  const success = res.status >= 200 && res.status < 300;

  if (success) {
    return { payload: augment(parsed, rateLimit), exitCode: 0, status: res.status };
  }

  if (isJson) {
    return { payload: augment(parsed, rateLimit), exitCode: 1, status: res.status };
  }

  return {
    payload: {
      ok: false,
      error: { type: "http_error", status: res.status, message: text },
      rate_limit: rateLimit,
    },
    exitCode: 1,
    status: res.status,
  };
}
