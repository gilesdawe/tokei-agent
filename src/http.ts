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
    return { payload: augment(parsed, rateLimit), exitCode: 0 };
  }

  if (isJson) {
    return { payload: augment(parsed, rateLimit), exitCode: 1 };
  }

  return {
    payload: {
      ok: false,
      error: { type: "http_error", status: res.status, message: text },
      rate_limit: rateLimit,
    },
    exitCode: 1,
  };
}
