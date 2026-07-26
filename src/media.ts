// media:upload — shared two-step upload used by BOTH the CLI command and the
// MCP media_upload tool. Step 1: POST /api/v1/media (via the existing
// request()) returns a short-lived signed-upload ticket. Step 2: raw PUT of
// the file bytes to the ticket's absolute upload_url, with exactly its
// `headers` (the signing token lives in the URL's own query string — no
// Authorization header). Nothing durable exists until step 2 succeeds.
//
// Deliberately imports from NEITHER index.ts NOR mcp.ts (only from http.ts,
// which imports nothing) — index.ts and mcp.ts already have a lazy import
// cycle between them (mcp.ts imports Io/VERSION from index.ts; index.ts
// imports createMcpSession from mcp.ts), and this module is imported by both,
// so it must not deepen that cycle.
import { putBinary, request } from "./http.js";
import type { BinaryFetchLike, FetchLike } from "./http.js";

/**
 * Client-side mirror of CONTENT_TYPE_TO_EXT in src/lib/api/media-upload.ts
 * (server), inverted (extension -> content type) and lowercased for lookup.
 * The CLI cannot import app code (separate package, separate build target),
 * so this is duplicated by necessity — keep the two in sync by hand if the
 * server's MEDIA_CONTENT_TYPES allowlist ever changes. Server side is the
 * source of truth; this is only used to pick a default before step 1, which
 * validates for real.
 */
export const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

const SUPPORTED_EXTENSIONS = Object.keys(EXT_TO_CONTENT_TYPE).join(", ");

/** Matches MEDIA_MAX_BYTES / the file-utils min-size check (src/lib/file-utils.ts) server-side. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const MEDIA_MIN_BYTES = 100;

export function contentTypeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = path.slice(dot).toLowerCase();
  return EXT_TO_CONTENT_TYPE[ext];
}

/** Last path segment, forward- or back-slash — never node:path, to keep cli/src runtime-agnostic. */
function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export interface UploadMediaArgs {
  filePath: string;
  contentTypeOverride?: string;
  apiKey: string;
  baseUrl: string;
  fetchImpl: FetchLike;
  // Optional so embedders without a filesystem / binary fetch can omit them
  // (the upload then reports a usage error) — same idiom as Io.readFile.
  binaryFetchImpl?: BinaryFetchLike;
  readFileBytes?: (path: string) => Uint8Array;
}

export type UploadMediaOutcome =
  | { kind: "usage_error"; message: string }
  | { kind: "result"; exitCode: 0 | 1; payload: unknown };

export async function uploadMedia(args: UploadMediaArgs): Promise<UploadMediaOutcome> {
  const {
    filePath,
    contentTypeOverride,
    apiKey,
    baseUrl,
    fetchImpl,
    binaryFetchImpl,
    readFileBytes,
  } = args;

  const contentType = contentTypeOverride ?? contentTypeForPath(filePath);
  if (!contentType) {
    return {
      kind: "usage_error",
      message: `Cannot infer a content type for "${filePath}". Supported extensions: ${SUPPORTED_EXTENSIONS} (or pass --content-type).`,
    };
  }

  if (!readFileBytes || !binaryFetchImpl) {
    return {
      kind: "usage_error",
      message: "media:upload is not supported in this environment (no file system / network access).",
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileBytes(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "usage_error", message: `Could not read ${filePath}: ${message}` };
  }

  if (bytes.length > MEDIA_MAX_BYTES) {
    return {
      kind: "usage_error",
      message: `${filePath} is ${bytes.length} bytes, over the 5MB (${MEDIA_MAX_BYTES} byte) signed-upload bucket limit — this applies to video as well as images.`,
    };
  }
  if (bytes.length < MEDIA_MIN_BYTES) {
    return {
      kind: "usage_error",
      message: `${filePath} is ${bytes.length} bytes, below the ${MEDIA_MIN_BYTES} byte minimum (possibly empty or corrupt).`,
    };
  }

  const filename = basename(filePath);
  const step1 = await request(
    {
      baseUrl,
      apiKey,
      path: "/media",
      method: "POST",
      body: { filename, content_type: contentType, size_bytes: bytes.length },
    },
    fetchImpl,
  );
  if (step1.exitCode !== 0) {
    return { kind: "result", exitCode: 1, payload: step1.payload };
  }

  const step1Payload = step1.payload as { data?: Record<string, unknown>; rate_limit?: unknown };
  const data = step1Payload.data ?? {};
  const uploadUrl = data.upload_url as string;
  const uploadHeaders = (data.headers as Record<string, string>) ?? {};

  const putResult = await putBinary(uploadUrl, bytes, uploadHeaders, binaryFetchImpl);
  if (!putResult.ok) {
    const capNote =
      putResult.status === 413
        ? " The signed-upload bucket caps uploads at 5MB (applies to video too) — Supabase Storage rejected this one, not Tokei."
        : "";
    return {
      kind: "result",
      exitCode: 1,
      payload: {
        ok: false,
        error: {
          type: "upload_failed",
          stage: "storage_put",
          status: putResult.status,
          message: `Storage upload failed with status ${putResult.status}.${capNote}`,
        },
      },
    };
  }

  return {
    kind: "result",
    exitCode: 0,
    payload: {
      success: true,
      data: {
        public_url: data.public_url,
        path: data.path,
        content_type: data.content_type,
        filename: data.filename,
        size_bytes: bytes.length,
      },
      rate_limit: step1Payload.rate_limit ?? null,
    },
  };
}
