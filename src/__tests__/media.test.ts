/** @jest-environment node */
// Tests for the media:upload CLI command / MCP tool's shared implementation
// (cli/src/media.ts): client-side validation, the two-step upload (POST
// ticket, PUT bytes), and error mapping. Mirrors the harness pattern in
// commands.test.ts.
import { main } from "../index.js";
import type { Io } from "../index.js";
import type { HttpResponse } from "../http.js";
import { contentTypeForPath } from "../media.js";

const RL_HEADERS = {
  "X-RateLimit-Limit": "50",
  "X-RateLimit-Remaining": "49",
  "X-RateLimit-Reset": "1753000000",
};

function jsonRes(body: unknown, status = 200): HttpResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(RL_HEADERS)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function binRes(status: number, text = ""): HttpResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

const TICKET_DATA = {
  upload_url:
    "https://xyz.supabase.co/storage/v1/object/upload/sign/tokei-public/api-uploads/u1/uuid.png?token=tok",
  token: "tok",
  method: "PUT",
  headers: { "content-type": "image/png", "x-upsert": "false" },
  bucket: "tokei-public",
  path: "api-uploads/u1/uuid.png",
  public_url: "https://xyz.supabase.co/storage/v1/object/public/tokei-public/api-uploads/u1/uuid.png",
  content_type: "image/png",
  filename: "hero.png",
  max_bytes: 5242880,
  expires_in: 7200,
  expires_at: "2026-07-26T12:00:00.000Z",
};

interface JsonCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}
interface PutCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: Uint8Array };
}

interface Harness {
  io: Io;
  out: string[];
  err: string[];
  jsonCalls: JsonCall[];
  putCalls: PutCall[];
}

function harness(
  opts: {
    env?: Record<string, string | undefined>;
    jsonResponse?: HttpResponse | Error;
    putResponse?: HttpResponse | Error;
    files?: Record<string, Uint8Array>;
    omitReadFileBytes?: boolean;
    omitBinaryFetch?: boolean;
  } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const jsonCalls: JsonCall[] = [];
  const putCalls: PutCall[] = [];
  const jsonResponse = opts.jsonResponse ?? jsonRes({ success: true, data: TICKET_DATA });
  const putResponse = opts.putResponse ?? binRes(200);
  const files = opts.files ?? {};

  const base: Io = {
    env: opts.env ?? { TOKEI_API_KEY: "tokei_k_test" },
    fetchImpl: async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      jsonCalls.push({ url, init });
      if (jsonResponse instanceof Error) throw jsonResponse;
      return jsonResponse;
    },
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };
  if (!opts.omitBinaryFetch) {
    base.binaryFetchImpl = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body: Uint8Array },
    ) => {
      putCalls.push({ url, init });
      if (putResponse instanceof Error) throw putResponse;
      return putResponse;
    };
  }
  if (!opts.omitReadFileBytes) {
    base.readFileBytes = (path: string) => {
      if (files[path]) return files[path];
      throw new Error(`ENOENT: no such file, open '${path}'`);
    };
  }
  return { io: base, out, err, jsonCalls, putCalls };
}

describe("contentTypeForPath", () => {
  it("infers the content type from a lowercased extension", () => {
    expect(contentTypeForPath("hero.PNG")).toBe("image/png");
    expect(contentTypeForPath("clip.jpeg")).toBe("image/jpeg");
    expect(contentTypeForPath("clip.mov")).toBe("video/quicktime");
  });

  it("returns undefined for an unsupported extension", () => {
    expect(contentTypeForPath("doc.svg")).toBeUndefined();
  });
});

describe("main — media:upload", () => {
  it("unknown extension -> usage error naming supported extensions, zero HTTP calls", async () => {
    const h = harness({ files: { "x.svg": new Uint8Array(200).fill(1) } });
    const code = await main(["media:upload", "x.svg"], h.io);
    expect(code).toBe(2);
    expect(h.out).toEqual([]);
    const errBody = JSON.parse(h.err[0]);
    expect(errBody.error.type).toBe("usage_error");
    expect(errBody.error.message).toMatch(/\.jpg/);
    expect(errBody.error.message).toMatch(/\.mp4/);
    expect(h.jsonCalls).toEqual([]);
    expect(h.putCalls).toEqual([]);
  });

  it("file over 5MB -> usage error mentioning 5MB, zero HTTP calls", async () => {
    const bytes = new Uint8Array(6 * 1024 * 1024);
    const h = harness({ files: { "big.png": bytes } });
    const code = await main(["media:upload", "big.png"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.message).toMatch(/5MB/);
    expect(h.jsonCalls).toEqual([]);
    expect(h.putCalls).toEqual([]);
  });

  it("file under the 100 byte minimum -> usage error, zero HTTP calls", async () => {
    const bytes = new Uint8Array(50);
    const h = harness({ files: { "tiny.png": bytes } });
    const code = await main(["media:upload", "tiny.png"], h.io);
    expect(code).toBe(2);
    const errBody = JSON.parse(h.err[0]);
    expect(errBody.error.type).toBe("usage_error");
    expect(h.jsonCalls).toEqual([]);
    expect(h.putCalls).toEqual([]);
  });

  it("happy path: step-1 POST with exact JSON body, step-2 PUT with exact headers/body, success envelope", async () => {
    const bytes = new Uint8Array(150).fill(7);
    const h = harness({ files: { "photos/hero.PNG": bytes } });
    const code = await main(["media:upload", "photos/hero.PNG"], h.io);
    expect(code).toBe(0);

    expect(h.jsonCalls).toHaveLength(1);
    const jsonUrl = new URL(h.jsonCalls[0].url);
    expect(jsonUrl.origin + jsonUrl.pathname).toBe("https://tokei.io/api/v1/media");
    expect(h.jsonCalls[0].init.method).toBe("POST");
    expect(JSON.parse(h.jsonCalls[0].init.body!)).toEqual({
      filename: "hero.PNG",
      content_type: "image/png",
      size_bytes: 150,
    });

    expect(h.putCalls).toHaveLength(1);
    expect(h.putCalls[0].url).toBe(TICKET_DATA.upload_url);
    expect(h.putCalls[0].init.method).toBe("PUT");
    expect(h.putCalls[0].init.headers).toEqual({ "content-type": "image/png", "x-upsert": "false" });
    expect(h.putCalls[0].init.body).toEqual(bytes);

    const stdout = JSON.parse(h.out[0]);
    expect(stdout.success).toBe(true);
    expect(stdout.data.public_url).toBe(TICKET_DATA.public_url);
    expect(stdout.data.path).toBe(TICKET_DATA.path);
    expect(stdout.data.size_bytes).toBe(150);
    expect(stdout.rate_limit).toEqual({ limit: 50, remaining: 49, reset: 1753000000 });
  });

  it("step-1 422 -> exit 1, envelope printed, no PUT call", async () => {
    const errBody = {
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Request body failed validation.", status: 422 },
    };
    const h = harness({
      files: { "hero.png": new Uint8Array(150).fill(1) },
      jsonResponse: jsonRes(errBody, 422),
    });
    const code = await main(["media:upload", "hero.png"], h.io);
    expect(code).toBe(1);
    const stdout = JSON.parse(h.out[0]);
    expect(stdout.error.code).toBe("VALIDATION_ERROR");
    expect(h.putCalls).toEqual([]);
  });

  it("step-2 413 from storage -> upload_failed/storage_put envelope mentioning 5MB, exit 1", async () => {
    const h = harness({
      files: { "hero.png": new Uint8Array(150).fill(1) },
      putResponse: binRes(413, "Payload too large"),
    });
    const code = await main(["media:upload", "hero.png"], h.io);
    expect(code).toBe(1);
    const stdout = JSON.parse(h.out[0]);
    expect(stdout.ok).toBe(false);
    expect(stdout.error.type).toBe("upload_failed");
    expect(stdout.error.stage).toBe("storage_put");
    expect(stdout.error.status).toBe(413);
    expect(stdout.error.message).toMatch(/5MB/);
  });

  it("--content-type overrides extension inference", async () => {
    const h = harness({ files: { "clip.dat": new Uint8Array(150).fill(2) } });
    const code = await main(["media:upload", "clip.dat", "--content-type", "video/mp4"], h.io);
    expect(code).toBe(0);
    expect(JSON.parse(h.jsonCalls[0].init.body!).content_type).toBe("video/mp4");
  });

  it("Io without readFileBytes -> usage error, 'not supported in this environment', zero HTTP calls", async () => {
    const h = harness({ omitReadFileBytes: true, files: { "hero.png": new Uint8Array(150).fill(1) } });
    const code = await main(["media:upload", "hero.png"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.message).toMatch(/not supported in this environment/);
    expect(h.jsonCalls).toEqual([]);
    expect(h.putCalls).toEqual([]);
  });

  it("Io without binaryFetchImpl -> usage error, 'not supported in this environment', zero HTTP calls", async () => {
    const h = harness({ omitBinaryFetch: true, files: { "hero.png": new Uint8Array(150).fill(1) } });
    const code = await main(["media:upload", "hero.png"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.message).toMatch(/not supported in this environment/);
    expect(h.jsonCalls).toEqual([]);
    expect(h.putCalls).toEqual([]);
  });

  it("no <file> argument -> usage error, exit 2, zero HTTP calls", async () => {
    const h = harness();
    const code = await main(["media:upload"], h.io);
    expect(code).toBe(2);
    expect(JSON.parse(h.err[0]).error.type).toBe("usage_error");
    expect(h.jsonCalls).toEqual([]);
    expect(h.putCalls).toEqual([]);
  });
});
