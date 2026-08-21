// MCP stdio server for the tokei-agent CLI: hand-rolled newline-delimited
// JSON-RPC 2.0 (the MCP stdio transport). Zero runtime dependencies — the
// protocol surface for a tools-only server is small enough to speak directly.
// Tool inputs use the wire field names from public/openapi.json (snake_case);
// bodies are passed to the API untouched, so its 422 per-field errors are the
// validation story, same as the CLI.

import { request } from "./http.js";
import type { HttpMethod } from "./http.js";
import { VERSION } from "./index.js";
import type { Io } from "./index.js";
import { uploadMedia } from "./media.js";

const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const DEFAULT_BASE_URL = "https://tokei.io";

const INSTRUCTIONS = `Tokei (tokei.io) pre-launch campaign tools. Terminology: the API objects "contest" and "promotion" are what the UI calls a "page" or "campaign" — same thing; an "entry" is a signup. Requires the TOKEI_API_KEY environment variable (create a key at tokei.io -> Dashboard -> Settings -> API Keys; read-only keys get 403 on write tools). Every result is the API's JSON plus a "rate_limit" object — when rate_limit.remaining is low, slow down; on 429 wait before retrying. 404 can mean "exists but not owned by this key's account". Webhook signing secrets (whsec_) are shown exactly once at creation.`;

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

interface ToolSpec {
  def: ToolDef;
  method?: HttpMethod; // default GET
  // Argument holding the path parameter (removed from the body).
  pathParam?: string;
  buildPath: (pathValue: string | undefined) => string;
  // Argument names copied into the query string (values stringified).
  queryParams?: string[];
  // Remaining arguments (minus pathParam) are sent as the JSON body.
  hasBody?: boolean;
  // A fixed set of body fields sent on every call (e.g. pages_publish always
  // sends {status: "active"}); the tool call's own arguments are merged on
  // top and win on conflict.
  fixedBody?: Record<string, unknown>;
  // Append a one-time-secret notice when the response contains a whsec_ secret.
  warnSecretOnce?: boolean;
  // Escape hatch for tools that don't fit the generic single-request HTTP
  // path (e.g. media_upload's two-step POST-ticket-then-PUT-bytes flow).
  // Checked at the top of callTool, before buildPath/query/body/request().
  handler?: (args: Record<string, unknown>, io: Io) => Promise<ToolResult>;
}

const enc = encodeURIComponent;

const PAGINATION = {
  page: { type: "integer", minimum: 1, description: "Page number (1-based)." },
  per_page: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "Results per page (max 100).",
  },
};

const CONTEST_ID = {
  type: "string",
  description: "The page id (API: contest/promotion id, a UUID). Get it from pages_list.",
};

const TOOL_SPECS: ToolSpec[] = [
  {
    def: {
      name: "me",
      title: "Verify API key",
      description:
        "Verify the API key and return account information: plan, API usage today, active page count.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    buildPath: () => "/me",
  },
  {
    def: {
      name: "pages_list",
      title: "List promotion pages",
      description:
        "List your pages (API: promotions/contests) with status, entry counts, and public URLs.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft", "active", "completed", "deleted"] },
          mode: { type: "string", enum: ["competition", "gamification", "sharing_only"] },
          ...PAGINATION,
        },
      },
      annotations: { readOnlyHint: true },
    },
    buildPath: () => "/contests",
    queryParams: ["status", "mode", "page", "per_page"],
  },
  {
    def: {
      name: "pages_get",
      title: "Get promotion page",
      description:
        "Get one page in full: description, prizes, reward_thresholds, dates, public_url.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: true },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}`,
  },
  {
    def: {
      name: "stats",
      title: "Get page analytics",
      description: "Aggregated analytics for a page: signups, entries, referrals, top actions.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: true },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/analytics`,
  },
  {
    def: {
      name: "leaderboard",
      title: "Get page leaderboard",
      description: "Participants of a page ranked by entry points.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID, ...PAGINATION },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: true },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/leaderboard`,
    queryParams: ["page", "per_page"],
  },
  {
    def: {
      name: "referrals_top",
      title: "Get top referrers",
      description:
        "A page's top referrers, ranked by converted referrals, with each one's referral code, name, email and counts — plus totals for referral clicks and conversion rate. Only entrants who have referred at least one person are listed.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID, ...PAGINATION },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: true },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/referrals`,
    queryParams: ["page", "per_page"],
  },
  {
    def: {
      name: "winners_list",
      title: "Get selection-run winners",
      description:
        "Selection-run history for a page (newest first): each run's id, seed, algorithm version, status, requested_by_email, total_candidates/total_winners_selected, and its persisted winners — each with entrant identity (email, full_name, entry_points, created_at, country_name, city) and prize details (prize_tier, prize_description, prize_value, selected_at, notified_at, notification_method, verified, claimed_at). Read-only: finalizing a run is session-auth only, not available via this API.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: true },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/winners`,
  },
  {
    def: {
      name: "entries_list",
      title: "List entries",
      description:
        "List a page's entries (signups). Filter by exact email with the email argument.",
      inputSchema: {
        type: "object",
        properties: {
          contest_id: CONTEST_ID,
          email: { type: "string", description: "Exact-match email filter." },
          ...PAGINATION,
        },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: true },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/entries`,
    queryParams: ["page", "per_page", "email"],
  },
  {
    def: {
      name: "surveys_list",
      title: "List survey responses",
      description: "List survey responses for a page.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID, ...PAGINATION },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: true },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/survey-responses`,
    queryParams: ["page", "per_page"],
  },
  {
    def: {
      name: "templates_list",
      title: "List templates",
      description:
        "List the platform's named starting points: id, slug, name, skin (page layout), and entry_method_count. Same list for every key. Clone one by slug with pages_clone's template argument.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    buildPath: () => "/templates",
  },
  {
    def: {
      name: "actions_catalog",
      title: "List entry-action catalog",
      description:
        "List every entry-action type entry actions can use: label, description, default points, platform, and whether it's trust-based / API-verifiable / manually verifiable. Same catalog for every key — not scoped to your account. Optional type argument returns just that one action type's entry; a value matching no known type is a 400.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Filter to one action type, e.g. twitter_follow. Unknown values return 400.",
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    buildPath: () => "/actions/catalog",
    queryParams: ["type"],
  },
  {
    def: {
      name: "events_catalog",
      title: "List webhook event catalog",
      description:
        "List every webhook event type Tokei's delivery engine understands: description, payload schema, and whether it's currently subscribable. Same catalog for every key — not scoped to your account. Optional type argument returns just that one event type's entry; a value matching no known type is a 400.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Filter to one event type, e.g. entry.created. Unknown values return 400.",
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    buildPath: () => "/events/catalog",
    queryParams: ["type"],
  },
  {
    def: {
      name: "pages_clone",
      title: "Create page from clone or template",
      description:
        "Create a page by cloning one you own (source_promotion_id), a named platform template (template — list slugs with templates_list), or the platform starter template (omit both). Sending both source_promotion_id and template is a 422. Template, theme, and entry methods copy verbatim from the source. Capped at 20 API-created pages per account per UTC day (429). Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            maxLength: 100,
            description: "Dashboard name AND public page headline.",
          },
          source_promotion_id: {
            type: "string",
            description: "Page to clone; must be owned by your account (404 otherwise).",
          },
          template: {
            type: "string",
            description:
              "Clone a named platform template by slug instead (from templates_list). Alternative to source_promotion_id, not combinable with it (422). A slug matching no template is a 404.",
          },
          description: { type: "string", maxLength: 2000 },
          prize: {
            type: "string",
            maxLength: 200,
            description:
              "Replaces the first prize's name, or creates a prize if the source has none.",
          },
          end_date: { type: "string", description: "ISO 8601 datetime in the future." },
          campaign_url: { type: "string", maxLength: 500, description: "HTTPS URL." },
          image_url: {
            type: "string",
            maxLength: 500,
            description:
              "Hero image URL — must be an https Supabase storage (public) or res.cloudinary.com URL.",
          },
          status: {
            type: "string",
            enum: ["draft", "active"],
            description: "active is live immediately at the returned public_url. Default draft.",
          },
          idempotency_key: {
            type: "string",
            maxLength: 100,
            description:
              "Reusing a key returns 409 with the existing page's id instead of a duplicate.",
          },
        },
        required: ["title"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    method: "POST",
    buildPath: () => "/promotions",
    hasBody: true,
  },
  {
    def: {
      name: "pages_update",
      title: "Update promotion page",
      description:
        "Update a page: title, description, start/end dates, prizes, reward tiers, entry methods (the action buttons on the page), appearance, and the seven media slots (image_video, secondary_image, third_image, fourth_image, fifth_image, background_image, og_image — use media_upload to get a public_url first). At least one field; unknown fields are rejected (422). prizes, reward_thresholds and entry_methods each REPLACE the existing list wholesale — read with pages_get first, modify, send the complete list back. Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: {
          contest_id: CONTEST_ID,
          title: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            description: "Sets the dashboard name AND the public page heading.",
          },
          description: {
            type: ["string", "null"],
            maxLength: 2000,
            description: "Public page description. null clears it.",
          },
          start_date: {
            type: ["string", "null"],
            description:
              "ISO 8601 datetime or null. A future start_date pauses new entries until then.",
          },
          end_date: {
            type: ["string", "null"],
            description:
              "ISO 8601 datetime in the future, or null. Setting it recomputes days_left.",
          },
          prizes: {
            type: "array",
            maxItems: 20,
            description:
              "Replaces the prize list wholesale. Items: {name, winners, value?, currency?}.",
            items: { type: "object" },
          },
          reward_thresholds: {
            type: "array",
            maxItems: 50,
            description:
              "Replaces reward tiers wholesale. Items: {id, points, rewardType, rewardDescription, isEnabled, rewardDetails?}.",
            items: { type: "object" },
          },
          entry_methods: {
            type: "array",
            maxItems: 30,
            description:
              "The page's entry actions. Replaces the list wholesale; [] clears every action. Two row shapes. ACTION ROW: {actionType, label, points?, config?, requireVerification?} — actionType must be one of the writable types from actions_catalog, and config's keys are that type's `fields`. CUSTOM LINK ROW: {label, points?, link, actionsRequired?} with NO actionType — a plain http(s) button to any URL, for anything the catalog has no action for; actionsRequired (0-20) hides it until the entrant has completed that many other actions. icon and config.type are server-derived and ignored if sent. label is 1-100 chars, points 0-100 (0 means 'use the action's default'). Labels starting with 'Visit Our ' are reserved for the page's own campaign-URL button — the dashboard rewrites those.",
            items: { type: "object" },
          },
          template: {
            type: "string",
            enum: ["basic-new", "showcase", "future", "simple"],
            description:
              "Page skin/layout template. 'simple' is the Custom template — bare structural markup the creator styles via custom_css.",
          },
          dark_mode_enabled: {
            type: "boolean",
            description: "Enable dark mode on the public page.",
          },
          custom_css: {
            type: ["string", "null"],
            description:
              "Creator CSS for the Custom ('simple') template — applied on the hosted page AND the widget embed, styling via --tokei-* custom properties and .tokei-simple-* class hooks. Max 20 KB; server-sanitised (unsafe constructs rejected with a 422 naming the reason). null clears it.",
          },
          primary_color: {
            type: ["string", "null"],
            description: "Hex colour, e.g. #7d78c6. null resets to the template default.",
          },
          card_width: {
            type: "string",
            enum: [
              "narrow",
              "medium",
              "wide",
              "xl",
              "max-w-2xl",
              "max-w-3xl",
              "max-w-4xl",
              "max-w-7xl",
            ],
            description:
              "Content column width. Friendly names map to Tailwind max-w classes server-side.",
          },
          image_video: {
            type: ["string", "null"],
            description:
              "Hero media — an image or a video URL, typically the public_url from media_upload. Must be an https Supabase storage or Cloudinary URL (media_upload's output already qualifies). null clears it.",
          },
          secondary_image: {
            type: ["string", "null"],
            description:
              "Additional layout block image URL (same host allowlist as image_video). null clears it.",
          },
          third_image: {
            type: ["string", "null"],
            description:
              "Additional layout block image URL (same host allowlist as image_video). null clears it.",
          },
          fourth_image: {
            type: ["string", "null"],
            description:
              "Additional layout block image URL (same host allowlist as image_video). null clears it.",
          },
          fifth_image: {
            type: ["string", "null"],
            description:
              "Additional layout block image URL (same host allowlist as image_video). null clears it.",
          },
          background_image: {
            type: ["string", "null"],
            description:
              "Page background image URL (same host allowlist as image_video); interpolated into the page's CSS. null clears it.",
          },
          og_image: {
            type: ["string", "null"],
            description:
              "Social-share preview image URL (same host allowlist as image_video). null clears it.",
          },
        },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    method: "PATCH",
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}`,
    hasBody: true,
  },
  {
    def: {
      name: "pages_publish",
      title: "Publish page",
      description:
        "Publish a page (status -> active), making it live at its public_url. Requires an end_date in the future — either already stored on the page or supplied here — otherwise returns 422 VALIDATION_ERROR. Re-publishing an already-active page is a no-op and skips that check. Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: {
          contest_id: CONTEST_ID,
          end_date: {
            type: "string",
            description:
              "ISO 8601 datetime in the future. Required in this same call if the page has no future end_date already.",
          },
        },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    method: "PATCH",
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}`,
    hasBody: true,
    fixedBody: { status: "active" },
  },
  {
    def: {
      name: "pages_unpublish",
      title: "Unpublish page",
      description:
        "Unpublish a page (status -> draft): blocks new entries only — existing entries and entrants are untouched, nothing is deleted. IMPORTANT: a draft page still renders publicly at its URL; unpublishing does not hide it from anyone with the link, it only stops new signups. Tell your user this before they rely on it to take a page down. Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID },
        required: ["contest_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    method: "PATCH",
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}`,
    hasBody: true,
    fixedBody: { status: "draft" },
  },
  {
    def: {
      name: "entries_create",
      title: "Create entry",
      description:
        "Add an entry (signup) to a page. Duplicate email for the page returns 409 — the person is already signed up. Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: {
          contest_id: CONTEST_ID,
          email: { type: "string", description: "Participant email." },
          name: { type: "string", description: "Full name." },
          action_type: {
            type: "string",
            description: "Action type for the entry; defaults to api_import.",
          },
          points: {
            type: "integer",
            minimum: 0,
            maximum: 10000,
            description:
              "Points to award; defaults to the matching entry method's points, or 5. Max 10000.",
          },
          value: { type: "string", description: 'Context string, e.g. "Order #12345".' },
          metadata: {
            type: "object",
            description: "Custom key-value pairs stored with the entry.",
          },
        },
        required: ["contest_id", "email"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    method: "POST",
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/entries`,
    hasBody: true,
  },
  {
    def: {
      name: "webhooks_list",
      title: "List webhooks",
      description:
        "List webhook subscriptions. failure_count is consecutive failed deliveries — auto-disabled at 10.",
      inputSchema: { type: "object", properties: { ...PAGINATION } },
      annotations: { readOnlyHint: true },
    },
    buildPath: () => "/webhooks",
    queryParams: ["page", "per_page"],
  },
  {
    def: {
      name: "webhooks_create",
      title: "Create webhook subscription",
      description:
        "Subscribe an HTTPS endpoint to events. The response contains the whsec_ signing secret EXACTLY ONCE — store it immediately, it cannot be retrieved again. Deliveries are HMAC-SHA256 signed (X-TOKEI-Signature). Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTPS endpoint that receives event payloads." },
          events: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "entry.created",
                "contest.ended",
                "winner.selected",
                "daily_bonus.claimed",
                "referral.converted",
              ],
            },
            minItems: 1,
            description:
              "Events to subscribe to. All five are subscribable: entry.created, contest.ended, winner.selected, daily_bonus.claimed, referral.converted.",
          },
        },
        required: ["url", "events"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    method: "POST",
    buildPath: () => "/webhooks",
    hasBody: true,
    warnSecretOnce: true,
  },
  {
    def: {
      name: "webhooks_delete",
      title: "Delete webhook subscription",
      description:
        "Delete a webhook subscription. A 404 usually means it was already deleted — safe to treat as success.",
      inputSchema: {
        type: "object",
        properties: {
          webhook_id: { type: "string", description: "The webhook subscription id (UUID)." },
        },
        required: ["webhook_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    method: "DELETE",
    pathParam: "webhook_id",
    buildPath: (id) => `/webhooks/${enc(id!)}`,
  },
  {
    def: {
      name: "media_upload",
      title: "Upload media file",
      description:
        "Upload an image or video from local disk (two-step: this call requests a signed upload ticket, then PUTs the file bytes to it) and return a public_url to feed into pages_update's seven media fields (image_video, secondary_image, third_image, fourth_image, fifth_image, background_image, og_image). Content type is inferred from the file extension (.jpg/.jpeg/.png/.gif/.webp/.mp4/.webm/.mov); override with content_type. The signed-upload bucket caps uploads at 5MB — applies to video as well as images, so a >5MB file fails at the PUT step with a 413 from storage, not from Tokei. The stored object name is a server-generated UUID; the filename argument is only echoed back. application/pdf is not accepted. Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Path to the local file to upload (read from disk where this MCP server runs).",
          },
          content_type: {
            type: "string",
            description:
              "Override the content type inferred from file_path's extension, e.g. image/png or video/mp4.",
          },
        },
        required: ["file_path"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    // Unused — media_upload bypasses the generic single-request path via
    // `handler` below, but buildPath is a required field on ToolSpec.
    buildPath: () => "/media",
    handler: async (args, io) => {
      const filePath = args.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) {
        return toolError("file_path must be a non-empty string");
      }
      const contentTypeOverride =
        typeof args.content_type === "string" ? args.content_type : undefined;
      // callTool has already confirmed TOKEI_API_KEY is set before reaching
      // any handler.
      const apiKey = io.env.TOKEI_API_KEY!;
      const outcome = await uploadMedia({
        filePath,
        contentTypeOverride,
        apiKey,
        baseUrl: io.env.TOKEI_API_URL || DEFAULT_BASE_URL,
        fetchImpl: io.fetchImpl,
        binaryFetchImpl: io.binaryFetchImpl,
        readFileBytes: io.readFileBytes,
      });
      if (outcome.kind === "usage_error") return toolError(outcome.message);
      return {
        content: [{ type: "text", text: JSON.stringify(outcome.payload, null, 2) }],
        isError: outcome.exitCode !== 0,
      };
    },
  },
];

export const TOOLS: ToolDef[] = TOOL_SPECS.map((s) => s.def);

const SPECS_BY_NAME = new Map(TOOL_SPECS.map((s) => [s.def.name, s]));

type JsonRpcId = string | number | null;

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

function response(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// Tool-level failures (bad arguments, missing key, API errors) are isError
// results — the calling model can read them and correct course. JSON-RPC
// errors are reserved for protocol misuse (unknown method/tool, parse errors).
function toolError(message: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: { type: "usage_error", message } }, null, 2),
      },
    ],
    isError: true,
  };
}

async function callTool(
  spec: ToolSpec,
  args: Record<string, unknown>,
  io: Io
): Promise<ToolResult> {
  for (const name of spec.def.inputSchema.required ?? []) {
    if (args[name] === undefined) {
      return toolError(`Missing required argument: ${name}`);
    }
  }

  const apiKey = io.env.TOKEI_API_KEY;
  if (!apiKey) {
    return toolError(
      "TOKEI_API_KEY is not set. Create a key at https://tokei.io (Dashboard, Settings, API Keys) and set it in this MCP server's environment."
    );
  }

  // Escape hatch for tools that don't fit the generic single-request HTTP
  // path below (media_upload's two-step POST-ticket-then-PUT-bytes flow).
  if (spec.handler) {
    return spec.handler(args, io);
  }

  const pathValue = spec.pathParam !== undefined ? String(args[spec.pathParam]) : undefined;

  let query: Record<string, string> | undefined;
  if (spec.queryParams) {
    query = {};
    for (const name of spec.queryParams) {
      const value = args[name];
      if (value !== undefined && value !== null) query[name] = String(value);
    }
  }

  let body: Record<string, unknown> | undefined;
  if (spec.hasBody) {
    // fixedBody is the base layer; the caller's own arguments win on conflict.
    body = { ...(spec.fixedBody ?? {}), ...args };
    if (spec.pathParam !== undefined) delete body[spec.pathParam];
  }

  const { payload, exitCode } = await request(
    {
      baseUrl: io.env.TOKEI_API_URL || DEFAULT_BASE_URL,
      apiKey,
      path: spec.buildPath(pathValue),
      query,
      method: spec.method,
      body,
    },
    io.fetchImpl
  );

  const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];

  if (spec.warnSecretOnce && exitCode === 0) {
    const data = (payload as { data?: unknown }).data;
    const secret =
      data !== null && typeof data === "object" ? (data as { secret?: unknown }).secret : undefined;
    if (typeof secret === "string" && secret.startsWith("whsec_")) {
      content.push({
        type: "text",
        text: "The whsec_ signing secret above is shown only once and cannot be retrieved again. Store it securely now.",
      });
    }
  }

  return { content, isError: exitCode !== 0 };
}

export function createMcpSession(io: Io): {
  handleLine(line: string): Promise<string | undefined>;
} {
  return {
    async handleLine(line: string): Promise<string | undefined> {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return rpcError(null, -32700, "Parse error");
      }

      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
        return rpcError(null, -32600, "Invalid Request");
      }
      const { id, method, params } = msg as {
        id?: JsonRpcId;
        method?: unknown;
        params?: Record<string, unknown>;
      };

      // Notifications (no id) never get a response.
      if (id === undefined) return undefined;

      if (typeof method !== "string") {
        return rpcError(id, -32600, "Invalid Request");
      }

      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          const protocolVersion =
            typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : LATEST_PROTOCOL_VERSION;
          return response(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "tokei-agent", version: VERSION },
            instructions: INSTRUCTIONS,
          });
        }
        case "ping":
          return response(id, {});
        case "tools/list":
          return response(id, { tools: TOOLS });
        case "tools/call": {
          const name = params?.name;
          const spec = typeof name === "string" ? SPECS_BY_NAME.get(name) : undefined;
          if (!spec) {
            return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
          }
          const rawArgs = params?.arguments;
          const args =
            rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          return response(id, await callTool(spec, args, io));
        }
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}
