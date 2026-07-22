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

const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const DEFAULT_BASE_URL = "https://tokei.io";

const INSTRUCTIONS = `Tokei (tokei.io) pre-launch campaign tools. Terminology: the API objects "contest" and "promotion" are what the UI calls a "page" or "campaign" — same thing; an "entry" is a signup. Requires the TOKEI_API_KEY environment variable (create a key at tokei.io -> Dashboard -> Settings -> API Keys; read-only keys get 403 on write tools). Every result is the API's JSON plus a "rate_limit" object — when rate_limit.remaining is low, slow down; on 429 wait before retrying. 404 can mean "exists but not owned by this key's account". Webhook signing secrets (whsec_) are shown exactly once at creation.`;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
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
}

const enc = encodeURIComponent;

const PAGINATION = {
  page: { type: "integer", minimum: 1, description: "Page number (1-based)." },
  per_page: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (max 100)." },
};

const CONTEST_ID = {
  type: "string",
  description: 'The page id (API: contest/promotion id, a UUID). Get it from pages_list.',
};

const TOOL_SPECS: ToolSpec[] = [
  {
    def: {
      name: "me",
      description:
        "Verify the API key and return account information: plan, API usage today, active page count.",
      inputSchema: { type: "object", properties: {} },
    },
    buildPath: () => "/me",
  },
  {
    def: {
      name: "pages_list",
      description:
        'List your pages (API: promotions/contests) with status, entry counts, and public URLs.',
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft", "active", "ended", "paused"] },
          mode: { type: "string", enum: ["competition", "gamification", "sharing_only"] },
          ...PAGINATION,
        },
      },
    },
    buildPath: () => "/contests",
    queryParams: ["status", "mode", "page", "per_page"],
  },
  {
    def: {
      name: "pages_get",
      description:
        "Get one page in full: description, prizes, reward_thresholds, dates, public_url.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID },
        required: ["contest_id"],
      },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}`,
  },
  {
    def: {
      name: "stats",
      description: "Aggregated analytics for a page: signups, entries, referrals, top actions.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID },
        required: ["contest_id"],
      },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/analytics`,
  },
  {
    def: {
      name: "leaderboard",
      description: "Participants of a page ranked by entry points.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID, ...PAGINATION },
        required: ["contest_id"],
      },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/leaderboard`,
    queryParams: ["page", "per_page"],
  },
  {
    def: {
      name: "entries_list",
      description: "List a page's entries (signups). Filter by exact email with the email argument.",
      inputSchema: {
        type: "object",
        properties: {
          contest_id: CONTEST_ID,
          email: { type: "string", description: "Exact-match email filter." },
          ...PAGINATION,
        },
        required: ["contest_id"],
      },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/entries`,
    queryParams: ["page", "per_page", "email"],
  },
  {
    def: {
      name: "surveys_list",
      description: "List survey responses for a page.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID, ...PAGINATION },
        required: ["contest_id"],
      },
    },
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/survey-responses`,
    queryParams: ["page", "per_page"],
  },
  {
    def: {
      name: "templates_list",
      description:
        "List the platform's named starting points: id, slug, name, skin (page layout), and entry_method_count. Same list for every key. Clone one by slug with pages_clone's template argument.",
      inputSchema: { type: "object", properties: {} },
    },
    buildPath: () => "/templates",
  },
  {
    def: {
      name: "pages_clone",
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
            description: "Replaces the first prize's name, or creates a prize if the source has none.",
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
    },
    method: "POST",
    buildPath: () => "/promotions",
    hasBody: true,
  },
  {
    def: {
      name: "pages_update",
      description:
        "Update a page: title, description, start/end dates, prizes, reward tiers. At least one field; unknown fields are rejected (422). prizes and reward_thresholds each REPLACE the existing list wholesale — read with pages_get first, modify, send the complete list back. Needs a read+write key.",
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
          template: {
            type: "string",
            enum: ["basic-new", "showcase", "future"],
            description: "Page skin/layout template.",
          },
          dark_mode_enabled: { type: "boolean", description: "Enable dark mode on the public page." },
          primary_color: {
            type: ["string", "null"],
            description: "Hex colour, e.g. #7d78c6. null resets to the template default.",
          },
          card_width: {
            type: "string",
            enum: ["narrow", "medium", "wide", "max-w-2xl", "max-w-3xl", "max-w-4xl"],
            description: "Content column width. Friendly names map to Tailwind max-w classes server-side.",
          },
        },
        required: ["contest_id"],
      },
    },
    method: "PATCH",
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}`,
    hasBody: true,
  },
  {
    def: {
      name: "pages_publish",
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
      description:
        "Unpublish a page (status -> draft): blocks new entries only — existing entries and entrants are untouched, nothing is deleted. IMPORTANT: a draft page still renders publicly at its URL; unpublishing does not hide it from anyone with the link, it only stops new signups. Tell your user this before they rely on it to take a page down. Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: { contest_id: CONTEST_ID },
        required: ["contest_id"],
      },
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
      description: "Add an entry (signup) to a page. Duplicate email for the page returns 409 — the person is already signed up. Needs a read+write key.",
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
            description: "Points to award; defaults to the matching entry method's points, or 5.",
          },
          value: { type: "string", description: 'Context string, e.g. "Order #12345".' },
          metadata: {
            type: "object",
            description: "Custom key-value pairs stored with the entry.",
          },
        },
        required: ["contest_id", "email"],
      },
    },
    method: "POST",
    pathParam: "contest_id",
    buildPath: (id) => `/contests/${enc(id!)}/entries`,
    hasBody: true,
  },
  {
    def: {
      name: "webhooks_list",
      description:
        "List webhook subscriptions. failure_count is consecutive failed deliveries — auto-disabled at 10.",
      inputSchema: { type: "object", properties: { ...PAGINATION } },
    },
    buildPath: () => "/webhooks",
    queryParams: ["page", "per_page"],
  },
  {
    def: {
      name: "webhooks_create",
      description:
        "Subscribe an HTTPS endpoint to events. The response contains the whsec_ signing secret EXACTLY ONCE — store it immediately, it cannot be retrieved again. Deliveries are HMAC-SHA256 signed (X-TOKEI-Signature). Needs a read+write key.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTPS endpoint that receives event payloads." },
          events: {
            type: "array",
            items: { type: "string", enum: ["entry.created"] },
            minItems: 1,
            description: 'Events to subscribe to (currently only "entry.created").',
          },
        },
        required: ["url", "events"],
      },
    },
    method: "POST",
    buildPath: () => "/webhooks",
    hasBody: true,
    warnSecretOnce: true,
  },
  {
    def: {
      name: "webhooks_delete",
      description:
        "Delete a webhook subscription. A 404 usually means it was already deleted — safe to treat as success.",
      inputSchema: {
        type: "object",
        properties: {
          webhook_id: { type: "string", description: "The webhook subscription id (UUID)." },
        },
        required: ["webhook_id"],
      },
    },
    method: "DELETE",
    pathParam: "webhook_id",
    buildPath: (id) => `/webhooks/${enc(id!)}`,
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
  io: Io,
): Promise<ToolResult> {
  for (const name of spec.def.inputSchema.required ?? []) {
    if (args[name] === undefined) {
      return toolError(`Missing required argument: ${name}`);
    }
  }

  const apiKey = io.env.TOKEI_API_KEY;
  if (!apiKey) {
    return toolError(
      "TOKEI_API_KEY is not set. Create a key at https://tokei.io (Dashboard, Settings, API Keys) and set it in this MCP server's environment.",
    );
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
    io.fetchImpl,
  );

  const content: ToolResult["content"] = [
    { type: "text", text: JSON.stringify(payload, null, 2) },
  ];

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
