// tokei-agent CLI — read and write commands for the Tokei (tokei.io) v1 REST API.
// Zero runtime dependencies: Node 22 native fetch + hand-rolled parsing.

import { parseArgs } from "./args.js";
import { request } from "./http.js";
import type { BinaryFetchLike, FetchLike, HttpMethod } from "./http.js";
import { createMcpSession } from "./mcp.js";
import { uploadMedia } from "./media.js";
import { createTerm, failureMessage, formatCount, renderBanner } from "./ui.js";
import type { SummaryRow, Term, TermHost } from "./ui.js";

// Kept in sync with cli/package.json by hand (zero-dep simplicity).
export const VERSION = "0.3.5";

const DEFAULT_BASE_URL = "https://tokei.io";

export interface Io {
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  // Reads a file for `--data @file.json`. Optional so embedders without a
  // filesystem can omit it.
  readFile?: (path: string) => string;
  // Reads a file as raw bytes for `media:upload <file>`. Optional so
  // embedders without a filesystem can omit it (the command then reports a
  // usage error) — same idiom as readFile.
  readFileBytes?: (path: string) => Uint8Array;
  // Raw-bytes PUT used by `media:upload`'s step 2 (signed-URL upload).
  // Optional so embedders without network access for binary bodies can omit
  // it (the command then reports a usage error) — same idiom as readFile.
  binaryFetchImpl?: BinaryFetchLike;
  // Line stream driving the `mcp` command. Optional so embedders without a
  // stdin can omit it (the command then reports a usage error).
  stdin?: AsyncIterable<string>;
  // Raw stream access for the interactive UI. Optional: when absent — tests,
  // embedders, MCP — the UI is inert and output is byte-identical to the
  // JSON-only behaviour. Distinct from `stdout`, which is a *line* writer.
  term?: TermHost;
}

interface FlagSpec {
  // CLI flag name (e.g. "per-page") and the wire query param (e.g. "per_page").
  name: string;
  param: string;
  kind: "int" | "enum" | "string";
  values?: readonly string[];
  min?: number;
  max?: number;
}

interface BodyFlagSpec {
  // CLI flag name (e.g. "campaign-url") and the wire body field (e.g. "campaign_url").
  name: string;
  field: string;
  kind: "string" | "int" | "enum" | "list" | "bool";
  values?: readonly string[];
  required?: boolean;
}

interface CommandSpec {
  method?: HttpMethod; // default GET
  // Name of the required positional path parameter, e.g. "contestId".
  positional?: string;
  buildPath: (positional: string | undefined) => string;
  flags: FlagSpec[];
  bodyFlags?: BodyFlagSpec[];
  // Accepts --data '<json>' / --data @file.json, merged under individual
  // body flags (flags win). Passed to the API untouched — its 422
  // per-field errors are the validation story.
  acceptsData?: boolean;
  // A fixed set of body fields sent on every invocation (e.g. the sugar
  // commands pages:publish/pages:unpublish send {status: "active"/"draft"}).
  // Lowest precedence: --data is merged on top of it, and individual body
  // flags win over both.
  fixedBody?: Record<string, unknown>;
  // Usage error when the merged body has no fields (PATCH needs >= 1).
  requireBody?: boolean;
  // Warn on stderr that the returned signing secret is shown only once.
  warnSecretOnce?: boolean;
}

const PAGE: FlagSpec = { name: "page", param: "page", kind: "int", min: 1 };
const PER_PAGE: FlagSpec = { name: "per-page", param: "per_page", kind: "int", min: 1, max: 100 };

// Every path parameter is percent-encoded so ids can never break out of
// their path segment.
const enc = encodeURIComponent;

const COMMANDS: Record<string, CommandSpec> = {
  me: {
    buildPath: () => "/me",
    flags: [],
  },
  "pages:list": {
    buildPath: () => "/contests",
    flags: [
      {
        name: "status",
        param: "status",
        kind: "enum",
        values: ["draft", "active", "completed", "deleted"],
      },
      { name: "mode", param: "mode", kind: "enum", values: ["competition", "gamification", "sharing_only"] },
      PAGE,
      PER_PAGE,
    ],
  },
  "pages:get": {
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}`,
    flags: [],
  },
  stats: {
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}/analytics`,
    flags: [],
  },
  leaderboard: {
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}/leaderboard`,
    flags: [PAGE, PER_PAGE],
  },
  "referrals:top": {
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}/referrals`,
    flags: [PAGE, PER_PAGE],
  },
  "winners:list": {
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}/winners`,
    flags: [],
  },
  "entries:list": {
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}/entries`,
    flags: [PAGE, PER_PAGE, { name: "email", param: "email", kind: "string" }],
  },
  "surveys:list": {
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}/survey-responses`,
    flags: [PAGE, PER_PAGE],
  },
  "templates:list": {
    buildPath: () => "/templates",
    flags: [],
  },
  "actions:catalog": {
    buildPath: () => "/actions/catalog",
    flags: [{ name: "type", param: "type", kind: "string" }],
  },
  "events:catalog": {
    buildPath: () => "/events/catalog",
    flags: [{ name: "type", param: "type", kind: "string" }],
  },
  "pages:clone": {
    method: "POST",
    buildPath: () => "/promotions",
    flags: [],
    bodyFlags: [
      { name: "title", field: "title", kind: "string", required: true },
      { name: "source", field: "source_promotion_id", kind: "string" },
      { name: "template", field: "template", kind: "string" },
      { name: "description", field: "description", kind: "string" },
      { name: "prize", field: "prize", kind: "string" },
      { name: "end-date", field: "end_date", kind: "string" },
      { name: "campaign-url", field: "campaign_url", kind: "string" },
      { name: "image-url", field: "image_url", kind: "string" },
      { name: "status", field: "status", kind: "enum", values: ["draft", "active"] },
      { name: "idempotency-key", field: "idempotency_key", kind: "string" },
    ],
    acceptsData: true,
  },
  "pages:update": {
    method: "PATCH",
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}`,
    flags: [],
    bodyFlags: [
      { name: "title", field: "title", kind: "string" },
      { name: "description", field: "description", kind: "string" },
      { name: "start-date", field: "start_date", kind: "string" },
      { name: "end-date", field: "end_date", kind: "string" },
      // "simple" is the Custom template (creator-styled via custom_css) — launched 2026-08-10.
      { name: "template", field: "template", kind: "enum", values: ["basic-new", "showcase", "future", "simple"] },
      // Creator CSS for the Custom template (hosted page + widget). Max 20 KB, server-sanitised.
      { name: "custom-css", field: "custom_css", kind: "string" },
      { name: "dark-mode", field: "dark_mode_enabled", kind: "bool" },
      { name: "primary-color", field: "primary_color", kind: "string" },
      {
        name: "card-width",
        field: "card_width",
        kind: "enum",
        values: [
          "narrow",
          "medium",
          "wide",
          "xl",
          "max-w-2xl",
          "max-w-3xl",
          "max-w-4xl",
          "max-w-7xl",
        ],
      },
      // Media (S2.5): public_url values from media:upload. See media:upload's
      // help entry for the two-step flow that produces them.
      { name: "image-video", field: "image_video", kind: "string" },
      { name: "secondary-image", field: "secondary_image", kind: "string" },
      { name: "third-image", field: "third_image", kind: "string" },
      { name: "fourth-image", field: "fourth_image", kind: "string" },
      { name: "fifth-image", field: "fifth_image", kind: "string" },
      { name: "background-image", field: "background_image", kind: "string" },
      { name: "og-image", field: "og_image", kind: "string" },
    ],
    acceptsData: true,
    requireBody: true,
  },
  "pages:publish": {
    method: "PATCH",
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}`,
    flags: [],
    fixedBody: { status: "active" },
    acceptsData: true,
    requireBody: true,
  },
  "pages:unpublish": {
    method: "PATCH",
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}`,
    flags: [],
    fixedBody: { status: "draft" },
    acceptsData: true,
    requireBody: true,
  },
  "entries:create": {
    method: "POST",
    positional: "contestId",
    buildPath: (id) => `/contests/${enc(id!)}/entries`,
    flags: [],
    bodyFlags: [
      { name: "email", field: "email", kind: "string", required: true },
      { name: "name", field: "name", kind: "string" },
      { name: "action-type", field: "action_type", kind: "string" },
      { name: "points", field: "points", kind: "int" },
      { name: "value", field: "value", kind: "string" },
    ],
    acceptsData: true,
  },
  "webhooks:list": {
    buildPath: () => "/webhooks",
    flags: [PAGE, PER_PAGE],
  },
  "webhooks:create": {
    method: "POST",
    buildPath: () => "/webhooks",
    flags: [],
    bodyFlags: [
      { name: "url", field: "url", kind: "string", required: true },
      { name: "events", field: "events", kind: "list", required: true },
    ],
    acceptsData: true,
    warnSecretOnce: true,
  },
  "webhooks:delete": {
    method: "DELETE",
    positional: "webhookId",
    buildPath: (id) => `/webhooks/${enc(id!)}`,
    flags: [],
  },
};

// ---------------------------------------------------------------------------
// Presentation only. Kept out of COMMANDS so the API spec table stays a pure
// description of the wire protocol.
//
// Copy uses "page", matching README.md and the pages:* command names — the
// `/contests` path and `contestId` positional are the wire format, and --mode
// also accepts sharing_only/gamification, which are not contests.
//
// One step per real request: the CLI issues exactly one HTTP call per command
// (media:upload is the sole two-phase flow), so there is never more than one
// tick to show. Anything more would be invented progress.
interface CommandCopy {
  pending: string;
  done: string | ((payload: unknown) => string);
}

/**
 * How many records the response covers.
 *
 * Prefers `pagination.total_count` over `data.length`: list endpoints default
 * to 25 per page, so `data.length` silently caps the reported figure at the
 * page size ("25 pages" when there are 30). Falls back to the array length for
 * unpaginated responses.
 */
function dataCount(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const total = (payload as { pagination?: { total_count?: unknown } }).pagination?.total_count;
  if (typeof total === "number") return total;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data.length : undefined;
}

function counted(noun: string, fallback: string): (payload: unknown) => string {
  return (payload) => {
    const n = dataCount(payload);
    if (n === undefined) return fallback;
    return `${formatCount(n)} ${n === 1 ? noun : `${noun}s`}`;
  };
}

const COPY: Record<string, CommandCopy> = {
  me: { pending: "Verifying your API key", done: "Signed in" },
  "pages:list": { pending: "Fetching your pages", done: counted("page", "Pages loaded") },
  "pages:get": { pending: "Loading page", done: "Page loaded" },
  "pages:clone": { pending: "Creating page from template", done: "Page created" },
  "pages:update": { pending: "Saving changes", done: "Changes saved" },
  "pages:publish": { pending: "Publishing page", done: "Page is live" },
  "pages:unpublish": { pending: "Returning page to draft", done: "Page is a draft" },
  "templates:list": {
    pending: "Fetching templates",
    done: counted("template", "Templates loaded"),
  },
  "actions:catalog": { pending: "Fetching action catalog", done: "Catalog loaded" },
  "events:catalog": { pending: "Fetching event catalog", done: "Catalog loaded" },
  stats: { pending: "Gathering analytics", done: "Analytics ready" },
  leaderboard: { pending: "Ranking entrants", done: "Leaderboard ready" },
  "referrals:top": {
    pending: "Ranking referrers",
    done: counted("referrer", "Top referrers loaded"),
  },
  "winners:list": {
    pending: "Fetching winners",
    done: counted("selection run", "Winners loaded"),
  },
  "entries:list": { pending: "Fetching entries", done: counted("entry", "Entries loaded") },
  "entries:create": { pending: "Recording entry", done: "Entry recorded" },
  "surveys:list": {
    pending: "Fetching survey responses",
    done: counted("response", "Responses loaded"),
  },
  "webhooks:list": { pending: "Fetching webhooks", done: counted("webhook", "Webhooks loaded") },
  "webhooks:create": { pending: "Registering webhook", done: "Webhook registered" },
  "webhooks:delete": { pending: "Removing webhook", done: "Webhook removed" },
};

/**
 * The account summary shown after `me`. Renders only fields the payload
 * actually contains — /me returns no permission or access flags, so nothing
 * resembling a capability checklist can be shown truthfully.
 */
function renderAccountSummary(term: Term, payload: unknown): void {
  const data =
    payload !== null && typeof payload === "object"
      ? ((payload as { data?: unknown }).data as Record<string, unknown> | undefined)
      : undefined;
  if (!data) return;

  const rows: SummaryRow[] = [];
  const plan = data.plan;
  if (typeof plan === "string") rows.push({ label: "Plan", value: plan.toUpperCase() });

  const usage = data.api_usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.requests_today === "number" && typeof usage.daily_limit === "number") {
    rows.push({
      label: "Requests today",
      value: `${formatCount(usage.requests_today)} / ${formatCount(usage.daily_limit)}`,
    });
  }
  if (typeof data.active_contests === "number") {
    rows.push({ label: "Active pages", value: formatCount(data.active_contests) });
  }
  const rl = (payload as { rate_limit?: { remaining?: unknown; limit?: unknown } }).rate_limit;
  if (rl && typeof rl.remaining === "number" && typeof rl.limit === "number") {
    rows.push({
      label: "Rate limit",
      value: `${formatCount(rl.remaining)} / ${formatCount(rl.limit)} remaining`,
    });
  }

  const email = typeof data.email === "string" ? data.email : undefined;
  term.summary({
    welcome: email ? `Welcome back, ${email}` : undefined,
    rows,
    closing: "Tokei Agent ready",
  });
}

const COMMAND_NAMES = Object.keys(COMMANDS);

class UsageError extends Error {}

function checkKnownFlags(spec: CommandSpec, flags: Record<string, string>): void {
  const known = new Set(spec.flags.map((f) => f.name));
  for (const bf of spec.bodyFlags ?? []) known.add(bf.name);
  if (spec.acceptsData) known.add("data");
  for (const provided of Object.keys(flags)) {
    if (!known.has(provided)) {
      throw new UsageError(`Unknown flag --${provided} for this command`);
    }
  }
}

function buildQuery(spec: CommandSpec, flags: Record<string, string>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const flag of spec.flags) {
    const raw = flags[flag.name];
    if (raw === undefined) continue;

    if (flag.kind === "int") {
      if (!/^\d+$/.test(raw)) {
        throw new UsageError(`--${flag.name} must be an integer`);
      }
      const n = Number(raw);
      if (flag.min !== undefined && n < flag.min) {
        throw new UsageError(`--${flag.name} must be >= ${flag.min}`);
      }
      if (flag.max !== undefined && n > flag.max) {
        throw new UsageError(`--${flag.name} must be <= ${flag.max}`);
      }
      query[flag.param] = String(n);
    } else if (flag.kind === "enum") {
      if (!flag.values || !flag.values.includes(raw)) {
        throw new UsageError(`--${flag.name} must be one of: ${flag.values?.join(", ")}`);
      }
      query[flag.param] = raw;
    } else {
      if (raw === "") {
        throw new UsageError(`--${flag.name} requires a value`);
      }
      query[flag.param] = raw;
    }
  }
  return query;
}

function parseDataFlag(raw: string, io: Io): Record<string, unknown> {
  if (raw === "") {
    throw new UsageError("--data requires a value: a JSON object or @file.json");
  }
  let text = raw;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    if (!io.readFile) {
      throw new UsageError("--data @file is not supported in this environment");
    }
    try {
      text = io.readFile(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UsageError(`--data: could not read ${path}: ${message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("--data must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--data must be a JSON object");
  }
  return { ...(parsed as Record<string, unknown>) };
}

function buildBody(
  spec: CommandSpec,
  flags: Record<string, string>,
  io: Io,
): Record<string, unknown> | undefined {
  if (!spec.bodyFlags && !spec.acceptsData && !spec.fixedBody) return undefined;

  // fixedBody is the base layer; --data is merged on top of it (and wins on
  // conflict); individual flags are applied last and win over both.
  const body: Record<string, unknown> = { ...(spec.fixedBody ?? {}) };
  if (spec.acceptsData && flags.data !== undefined) {
    Object.assign(body, parseDataFlag(flags.data, io));
  }

  for (const bf of spec.bodyFlags ?? []) {
    const raw = flags[bf.name];
    if (raw === undefined) continue;
    if (raw === "") {
      throw new UsageError(`--${bf.name} requires a value`);
    }
    if (bf.kind === "int") {
      if (!/^\d+$/.test(raw)) {
        throw new UsageError(`--${bf.name} must be an integer`);
      }
      body[bf.field] = Number(raw);
    } else if (bf.kind === "enum") {
      if (!bf.values || !bf.values.includes(raw)) {
        throw new UsageError(`--${bf.name} must be one of: ${bf.values?.join(", ")}`);
      }
      body[bf.field] = raw;
    } else if (bf.kind === "bool") {
      if (raw !== "true" && raw !== "false") {
        throw new UsageError(`--${bf.name} must be "true" or "false"`);
      }
      body[bf.field] = raw === "true";
    } else if (bf.kind === "list") {
      const items = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (items.length === 0) {
        throw new UsageError(`--${bf.name} requires a value`);
      }
      body[bf.field] = items;
    } else {
      body[bf.field] = raw;
    }
  }

  for (const bf of spec.bodyFlags ?? []) {
    if (bf.required && body[bf.field] === undefined) {
      throw new UsageError(`--${bf.name} is required (or provide "${bf.field}" via --data)`);
    }
  }
  if (spec.requireBody && Object.keys(body).length === 0) {
    throw new UsageError("Provide at least one field to update, via flags or --data");
  }
  return body;
}

const HELP = `tokei-agent — control your Tokei (tokei.io) pre-launch campaigns from AI agents and the CLI.

Usage:
  tokei-agent <command> [flags]

Commands (read):
  me                          Show the authenticated account / API key
  pages:list                  List promotions
                                --status draft|active|completed|deleted
                                --mode competition|gamification|sharing_only
                                --page <n>  --per-page <1-100>
  pages:get <contestId>       Get a single promotion
  stats <contestId>           Analytics for a promotion
  leaderboard <contestId>     Leaderboard   --page <n>  --per-page <1-100>
  referrals:top <contestId>   Top referrers, ranked by conversions, plus
                              click/conversion totals. Only entrants who have
                              actually referred someone are listed.
                                --page <n>  --per-page <1-100>
  winners:list <contestId>    Selection-run history for a page (newest first):
                              each run's seed, algorithm version, status, and
                              its persisted winners with entrant identity and
                              prize details. No pagination on this endpoint.
  entries:list <contestId>    List entries  --page <n>  --per-page <1-100>  --email <addr>
  surveys:list <contestId>    Survey responses  --page <n>  --per-page <1-100>
  webhooks:list               List webhook subscriptions  --page <n>  --per-page <1-100>
  templates:list              List the platform's named starting points (id,
                              slug, name, skin, entry_method_count) — clone one
                              by slug with pages:clone --template <slug>.
  actions:catalog             List every entry-action type Tokei supports
                              (label, description, points, platform, whether
                              it's trust-based/verifiable) — same list for
                              every key.
                                --type <actionType>  (unknown type is a 400)
  events:catalog              List every webhook event type Tokei's delivery
                              engine understands (description, payload schema,
                              subscribable) — same list for every key.
                                --type <eventType>  (unknown type is a 400)

Commands (write — need a read+write API key):
  pages:clone                 Create a promotion by cloning one you own; omit
                              --source and --template to clone the platform
                              starter template. Rate limited to 20 clones per
                              day per account.
                                --title <t> (required)  --source <promotionId>
                                --template <slug> (alternative to --source; get
                                slugs from templates:list; --source + --template
                                together is a 422)
                                --description <d>  --prize <name>  --end-date <iso>
                                --campaign-url <url>  --image-url <url>
                                --status draft|active  --idempotency-key <k>  --data
  media:upload <file>         Upload an image or video (two-step: request a
                              signed ticket, PUT the bytes) and print a
                              public_url to feed into pages:update's media
                              flags below. ≤5MB per file — the signed-upload
                              bucket caps this for video too, not just images.
                              Content type is inferred from the extension
                              (.jpg/.jpeg/.png/.gif/.webp/.mp4/.webm/.mov);
                              override with --content-type <type>.
  pages:update <contestId>    Update a promotion. Simple fields via flags; prizes,
                              reward_thresholds, entry_methods (or a full body)
                              via --data. Each of those three REPLACES the whole
                              list — read with pages:get first, modify, send back.
                              An entry_methods row is either an action row
                              {actionType,label,points?,config?,requireVerification?}
                              (actionType from actions:catalog) or a custom link
                              {label,points?,link,actionsRequired?} with no
                              actionType, e.g.
                                --data '{"entry_methods":[{"label":"Read the
                                Newsletter","points":2,"link":"https://x.com/n"}]}'
                                --title <t>  --description <d>
                                --start-date <iso>  --end-date <iso>
                                --template basic-new|showcase|future|simple
                                ("simple" = the Custom template, bring-your-own-CSS)
                                --custom-css <css> (Custom-template creator CSS,
                                ≤20 KB, sanitised server-side)
                                --dark-mode true|false  --primary-color <hex>
                                --card-width narrow|medium|wide|xl
                                (or max-w-2xl|3xl|4xl|7xl)
                                --image-video <url>  --secondary-image <url>
                                --third-image <url>  --fourth-image <url>
                                --fifth-image <url>  --background-image <url>
                                --og-image <url>  --data
                              (media URLs come from media:upload's public_url)
  pages:publish <contestId>   Publish a page (status -> active). Requires an
                              end_date in the future, already stored or sent
                              in --data, e.g. --data '{"end_date":"..."}'
                              to publish and set the deadline in one call.
  pages:unpublish <contestId> Unpublish a page (status -> draft). Entries are
                              untouched and new ones are blocked, but the
                              page still renders publicly at its URL.
  entries:create <contestId>  Add an entry
                                --email <addr> (required)  --name <n>
                                --action-type <t>  --points <n>  --value <v>  --data
  webhooks:create             Create a webhook subscription. The response shows the
                              whsec_ signing secret ONCE — it cannot be retrieved
                              again, so store it immediately.
                                --url <https-url> (required)
                                --events <e1,e2> (required, e.g. entry.created)  --data
  webhooks:delete <webhookId> Delete a webhook subscription

Commands (other):
  mcp                         Run the MCP stdio server — every command above
                              exposed as an MCP tool (for Claude Code, Claude
                              Desktop, and other MCP clients)

  --help, help                Show this help
  --version, -v               Show the version

--data '<json>' or --data @file.json supplies the request body as raw JSON,
merged under any field flags (flags win). It is sent to the API untouched;
invalid bodies come back as 422 responses with per-field errors.

Environment:
  TOKEI_API_KEY   Required. API key sent as "Authorization: Bearer <key>".
                  Create one at https://tokei.io (Dashboard, Settings, API Keys).
  TOKEI_API_URL   Optional. Base URL override (default https://tokei.io).

Output: JSON on stdout, augmented with a top-level "rate_limit" object.
Exit codes: 0 success, 1 API/network error, 2 usage error.`;

function usageError(io: Io, message: string): number {
  io.stderr(JSON.stringify({ ok: false, error: { type: "usage_error", message } }, null, 2));
  return 2;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);

  if ("help" in flags || command === "help") {
    // The wordmark above the help text is the first thing a human sees —
    // `npx tokei-agent --help` is line 1 of the README quickstart. renderBanner
    // returns undefined for pipes, redirects, CI and TOKEI_OUTPUT=json, so the
    // parsed form of this output is unchanged.
    const banner = renderBanner(io.term);
    if (banner !== undefined) io.term!.write(banner);
    io.stdout(HELP);
    return 0;
  }
  if ("version" in flags || "v" in flags) {
    io.stdout(VERSION);
    return 0;
  }

  if (command === undefined) {
    return usageError(
      io,
      `No command given. Valid commands: ${COMMAND_NAMES.join(", ")}, media:upload, mcp`,
    );
  }

  if (command === "mcp") {
    if (!io.stdin) {
      return usageError(io, "mcp needs a stdin line stream (run it via the tokei-agent binary)");
    }
    const session = createMcpSession(io);
    for await (const line of io.stdin) {
      if (line.trim() === "") continue;
      const reply = await session.handleLine(line);
      if (reply !== undefined) io.stdout(reply);
    }
    return 0;
  }

  // media:upload is a two-call flow (POST a ticket, then PUT the bytes) that
  // doesn't fit the single-request CommandSpec shape, so it's handled here,
  // ahead of the COMMANDS table lookup.
  if (command === "media:upload") {
    const filePath = positionals[0];
    if (filePath === undefined) {
      return usageError(io, "media:upload requires a <file> argument");
    }
    const knownFlags = new Set(["content-type"]);
    for (const provided of Object.keys(flags)) {
      if (!knownFlags.has(provided)) {
        return usageError(io, `Unknown flag --${provided} for this command`);
      }
    }
    if (flags["content-type"] === "") {
      return usageError(io, "--content-type requires a value");
    }

    const apiKey = io.env.TOKEI_API_KEY;
    if (!apiKey) {
      return usageError(io, "TOKEI_API_KEY is not set. Create a key at https://tokei.io and export it.");
    }
    const baseUrl = io.env.TOKEI_API_URL || DEFAULT_BASE_URL;

    const outcome = await uploadMedia({
      filePath,
      contentTypeOverride: flags["content-type"],
      apiKey,
      baseUrl,
      fetchImpl: io.fetchImpl,
      binaryFetchImpl: io.binaryFetchImpl,
      readFileBytes: io.readFileBytes,
    });
    if (outcome.kind === "usage_error") return usageError(io, outcome.message);
    io.stdout(JSON.stringify(outcome.payload, null, 2));
    return outcome.exitCode;
  }

  const spec = COMMANDS[command];
  if (!spec) {
    return usageError(io, `Unknown command "${command}". Valid commands: ${COMMAND_NAMES.join(", ")}`);
  }

  let positional: string | undefined;
  if (spec.positional) {
    positional = positionals[0];
    if (positional === undefined) {
      return usageError(io, `${command} requires a <${spec.positional}> argument`);
    }
  }

  let query: Record<string, string>;
  let body: Record<string, unknown> | undefined;
  try {
    checkKnownFlags(spec, flags);
    query = buildQuery(spec, flags);
    body = buildBody(spec, flags, io);
  } catch (err) {
    if (err instanceof UsageError) return usageError(io, err.message);
    throw err;
  }

  const apiKey = io.env.TOKEI_API_KEY;
  if (!apiKey) {
    return usageError(io, "TOKEI_API_KEY is not set. Create a key at https://tokei.io and export it.");
  }

  const baseUrl = io.env.TOKEI_API_URL || DEFAULT_BASE_URL;

  // Presentation only. `term` is undefined for pipes, redirects, CI, MCP and
  // tests, in which case this whole block collapses to the original single
  // io.stdout() call below.
  const copy = COPY[command];
  const term = copy ? createTerm(io.term) : undefined;
  // The full wordmark is reserved for `me`; routine commands get a step line.
  term?.start(copy!.pending, { logo: command === "me" });

  const { payload, exitCode, status } = await request(
    { baseUrl, apiKey, path: spec.buildPath(positional), query, method: spec.method, body },
    io.fetchImpl,
  );

  if (term) {
    if (exitCode === 0) {
      const done = copy!.done;
      await term.finish("done", typeof done === "function" ? done(payload) : done);
      if (command === "me") {
        renderAccountSummary(term, payload);
      } else {
        io.stdout(JSON.stringify(payload, null, 2));
      }
    } else {
      // The ✗ line is a summary, never a replacement: the full error object
      // still goes to stdout so it stays inspectable.
      await term.finish("fail", failureMessage(status, payload));
      io.stdout(JSON.stringify(payload, null, 2));
    }
  } else {
    io.stdout(JSON.stringify(payload, null, 2));
  }

  if (spec.warnSecretOnce && exitCode === 0) {
    const data = (payload as { data?: unknown }).data;
    const secret =
      data !== null && typeof data === "object" ? (data as { secret?: unknown }).secret : undefined;
    if (typeof secret === "string" && secret.startsWith("whsec_")) {
      io.stderr(
        "Warning: the whsec_ signing secret in this response is shown only once and cannot be retrieved again. Store it securely now.",
      );
    }
  }

  return exitCode;
}
