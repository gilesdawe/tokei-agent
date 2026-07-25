---
name: tokei-agent
description: Control Tokei (tokei.io) pre-launch and waitlist campaigns from the command line — list and update pages, clone new ones, pull stats and leaderboards, add entries, and manage webhooks via the Tokei v1 REST API.
homepage: https://tokei.io
metadata: {"openclaw":{"emoji":"⏱️","requires":{"bins":[],"env":["TOKEI_API_KEY"]}}}
---

# tokei-agent

`tokei-agent` is a zero-dependency CLI for the Tokei v1 REST API (`https://tokei.io/api/v1`). Every command prints JSON to stdout, so pipe it to `jq` or parse it directly.

## Terminology mapping (read this first)

The API and the UI use different words for the same objects. Do not treat these as different things.

| API says               | UI / humans say    | Notes                                                            |
| ---------------------- | ------------------ | ---------------------------------------------------------------- |
| `contest`              | page, campaign     | The core object. `contestId` in paths = the page's id.           |
| `promotion`            | page, campaign     | Same object again — `POST /promotions` creates it, reads live under `/contests/{id}`. |
| `entry`                | signup, subscriber | One person joining a page.                                       |
| `entries:create`       | add a signup       |                                                                  |

CLI command names use the UI words (`pages:list`, `pages:update`); the JSON they return uses the API words (`contest`, `promotion`).

## Setup

| Env var         | Required | Meaning                                                                          |
| --------------- | -------- | -------------------------------------------------------------------------------- |
| `TOKEI_API_KEY` | Yes      | Sent as `Authorization: Bearer <key>`. Create one at tokei.io → Dashboard → Settings → API Keys. |
| `TOKEI_API_URL` | No       | Base URL override (default `https://tokei.io`).                                  |

Keys have a scope: **read-only** or **read+write**. Write commands need a read+write key; a read-only key gets `403`. Keys can also carry an expiry — an expired key gets `401`. Prefer a read-only key unless the task actually changes something. API access requires an active subscription or lifetime plan — trial accounts get `403` on everything.

## Output envelope, exit codes

- stdout: the API's JSON body, augmented with a top-level `"rate_limit"` object: `{"limit": n, "remaining": n, "reset": <unix epoch seconds>}`, or `null` when the headers were absent (e.g. network failure).
- Exit code `0` — success (HTTP 2xx).
- Exit code `1` — API or network error. The API's JSON error body (same envelope, with `rate_limit`) is still printed on stdout; pure network failures print `{"ok": false, "error": {"type": "network_error", "message": ...}}`.
- Exit code `2` — usage error (bad flags, missing arguments, missing `TOKEI_API_KEY`). Printed as JSON on **stderr**: `{"ok": false, "error": {"type": "usage_error", "message": ...}}`. Nothing was sent to the API.

> **Known issue — exit codes on Node 24 / Windows.** The CLI can print its correct JSON output and then abort during process exit, corrupting the exit code (`$LASTEXITCODE` reads `-1073740791` / `0xC0000409` on success and failure alike). Judge a run by the JSON on stdout, not by the exit status.

## Commands (read — any key)

**`me`** — verify the key, see plan and API usage.

```sh
tokei-agent me
```

**`pages:list`** — list your pages. Flags: `--status draft|active|ended|paused`, `--mode competition|gamification|sharing_only`, `--page <n>`, `--per-page <1-100>`. Heads-up on the status vocabulary: pages are **stored** as `draft`, `active`, `completed` or `deleted`, but this filter accepts an older list (`draft`, `active`, `ended`, `paused`). `draft` and `active` mean the same thing in both, so filter on those and read the real value off each page's `status` field.

```sh
tokei-agent pages:list --status active --per-page 20
```

**`pages:get <contestId>`** — one page, full object. `title` is the **visible page headline**, not the internal dashboard name, so what you read is what a visitor sees. The object also carries:

| Field | Meaning |
| ----- | ------- |
| `description`, `prizes`, `reward_thresholds` | Everything `pages:update` can write, so you can read-modify-write. |
| `public_url` | The live page URL — no second call needed. |
| `primary_color` | Brand colour as a CSS value (e.g. `#7d78c6`); `null` means the template default. `settings.color` is a deprecated alias of it. |
| `card_width` | `max-w-2xl` \| `max-w-3xl` \| `max-w-4xl`; `null` renders as `max-w-2xl`. |
| `settings.template` | Page skin: `basic-new`, `showcase` or `future`. |
| `image_video` | Hero media — an image **or** a video URL. May carry dimension hints as query params. |
| `secondary_image` … `fifth_image`, `background_image`, `og_image` | The page's other media slots; `null` when unset. |
| `campaign_name`, `project_name` | **Read-only.** `project_name` is the small subheading under the headline; `campaign_name` is the internal dashboard name and never appears on the page. |

`primary_color`, `card_width` and `settings.template` are now writable via `pages:update` (see below); `dark_mode_enabled` writes through `--dark-mode` there too, though it isn't itself a field in this table. The remaining fields (`image_video` and the other media slots) are still read-only for now — and `campaign_name`/`project_name` always will be.

```sh
tokei-agent pages:get 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90
```

**`stats <contestId>`** — aggregated analytics for a page.

```sh
tokei-agent stats 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90
```

**`leaderboard <contestId>`** — participants ranked by points. Flags: `--page`, `--per-page <1-100>`.

```sh
tokei-agent leaderboard 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 --per-page 10
```

**`entries:list <contestId>`** — signups for a page. Flags: `--page`, `--per-page <1-100>`, `--email <addr>` (exact-match filter).

```sh
tokei-agent entries:list 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 --email fan@example.com
```

**`surveys:list <contestId>`** — survey responses. Flags: `--page`, `--per-page <1-100>`.

```sh
tokei-agent surveys:list 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 --page 2
```

**`templates:list`** — the platform's named starting points, for cloning with `pages:clone --template <slug>`. Same list for every key — not scoped to your account (it's platform content, not the caller's). No flags, no pagination.

```sh
tokei-agent templates:list
```

Example response — illustrative only: the live menu depends on which templates the platform has published. Call `templates:list` and use the slugs it returns; never hardcode one.

```json
{
  "success": true,
  "data": [
    {
      "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      "slug": "product-hunt",
      "name": "Product Hunt Launch",
      "skin": "showcase",
      "entry_method_count": 3
    },
    {
      "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "slug": "starter",
      "name": "Starter",
      "skin": "basic-new",
      "entry_method_count": 1
    }
  ],
  "rate_limit": { "limit": 60, "remaining": 59, "reset": 1753000000 }
}
```

`skin` is the page skin (`basic-new`/`showcase`/`future`) — the same vocabulary `pages:update --template` writes. `entry_method_count` is how many entry actions the template ships with. For agents: **list templates first, then clone by slug** — don't guess a slug.

What the skins look like — use this to match the user's reference point:

- `basic-new` ("Basic") — the classic giveaway card: entry actions in a clean vertical list, soft pastel styling. This is the format popularized by Gleam — when a user asks for a Gleam-style (or KickoffLabs-style) campaign, this is the closest match. The platform default.
- `showcase` — a dynamic two-column layout with warm colors and platform-styled buttons. Product-forward — the natural fit for a Product Hunt-style launch page.
- `future` — a dark, immersive game-style skin for bold, high-impact pages (gaming and tech audiences).

## Commands (write — need a read+write key)

**`pages:clone`** — create a page by cloning one you own (`--source <promotionId>`), a named platform template by slug (`--template <slug>` — get slugs from `templates:list`), or omit both to clone the platform starter template. `--template` and `--source` are **alternatives, not combinable** — sending both is `422`; a `--template` slug matching no template is `404`. Template, theme, and entry methods copy verbatim from the source — keep one polished master page per shape and clone it. Capped at **20 API-created pages per account per UTC day** (429 with `Retry-After`). Flags: `--title` (required), `--source`, `--template`, `--description`, `--prize`, `--end-date <iso>`, `--campaign-url`, `--image-url`, `--status draft|active`, `--idempotency-key`, `--data`.

```sh
tokei-agent pages:clone --title "Spring Launch Waitlist" \
  --source 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 \
  --prize "Lifetime license" --end-date 2026-09-01T00:00:00Z \
  --idempotency-key spring-launch-2026
```

Cloning from a named template instead — list first, then clone by slug:

```sh
tokei-agent templates:list
tokei-agent pages:clone --title "Spring Launch Waitlist" --template product-hunt \
  --prize "Lifetime license" --end-date 2026-09-01T00:00:00Z
```

`--status active` makes the page live immediately at the returned `public_url`; the default is `draft`. Reuse an `--idempotency-key` and you get `409` with the existing page's id in `error.details` instead of a duplicate.

**`pages:update <contestId>`** — PATCH a page. Simple fields via flags: `--title`, `--description`, `--start-date <iso>`, `--end-date <iso>`, `--template basic-new|showcase|future`, `--dark-mode true|false`, `--primary-color "#7d78c6"`, `--card-width narrow|medium|wide`. Prizes, reward tiers, nulls, or a full body via `--data`. At least one field required; unknown fields are rejected (422). `prizes` (max 20) and `reward_thresholds` (max 50) each **replace the existing list wholesale** — read the current lists with `pages:get` first, modify, and send the complete list back. A future `start_date` pauses new entries until then; setting `end_date` recomputes `days_left` — but a page whose winners have already been drawn rejects any `end_date` change with `409 WINNERS_ALREADY_SELECTED` (clearing it via `--data '{"end_date": null}'` is still allowed). `--title` sets the visible page headline (and the dashboard name), and `--description` accepts basic rich-text HTML which is sanitized on write, so unsupported tags come back stripped.

Appearance flags: `--template` is the page skin (`basic-new`, `showcase` or `future`), stored verbatim as `settings.template` — see the skin guide under `templates:list` for what each looks like and when to pick it. `--dark-mode` is a plain creator-side toggle (column `dark_mode_enabled`) — there is no visitor `prefers-color-scheme` behavior, so this is the only thing that controls it. `--primary-color` must be a hex colour only (3, 4, 6 or 8 digits, e.g. `"#7d78c6"`) — other CSS colour formats (`rgb()`, named colours) are rejected because the value is interpolated into the page's server-rendered `<style>` tag; to reset it to the template default, send `--data '{"primary_color": null}'` (there is no flag spelling for null). `--card-width` accepts the friendly names `narrow`/`medium`/`wide` **or** the raw stored Tailwind class directly (`max-w-2xl`/`max-w-3xl`/`max-w-4xl`); friendly names map `narrow`→`max-w-2xl`, `medium`→`max-w-3xl`, `wide`→`max-w-4xl`, and **reads always return the stored class, never the friendly name** — PATCH `--card-width wide` and the next `pages:get` returns `"max-w-4xl"`.

```sh
tokei-agent pages:update 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 \
  --title "Now with 3 prize tiers" \
  --data '{"prizes":[{"name":"AirPods Pro","winners":1,"value":249,"currency":"USD"},{"name":"Sticker pack","winners":50}]}'
```

```sh
tokei-agent pages:update 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 \
  --template showcase --dark-mode true --primary-color "#7d78c6"
```

**`pages:publish <contestId>`** — sugar over `pages:update` that PATCHes `{"status": "active"}`. Requires an `end_date` in the future — either already stored on the page, or sent in the same call via `--data`. If neither is true, this returns `422 VALIDATION_ERROR` with `details: [{"field": "status", "message": "Publishing requires an end_date in the future..."}]`. Re-publishing an already-active page is a no-op and skips that check. Still accepts `--data` for any other field, merged under the fixed `status` (a `--data` `status` value would override it, but there's no reason to send one here).

```sh
tokei-agent pages:publish 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90
```

The one-call ergonomic path, when the page has no future `end_date` yet — set it and publish together:

```sh
tokei-agent pages:publish 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 \
  --data '{"end_date":"2026-09-01T00:00:00Z"}'
```

**`pages:unpublish <contestId>`** — sugar over `pages:update` that PATCHes `{"status": "draft"}`. Safe for pages with entrants: entries and entrants are left untouched, and it only blocks new signups. **This is the single most important thing to tell your user: a draft page still renders publicly at its URL — unpublishing hides nothing, it only stops new entries.** If they want the page actually gone from public view, unpublishing is not that; there is no way to destroy or hide a page through this API (the `status` field only ever accepts `draft`/`active` — `deleted` is rejected).

```sh
tokei-agent pages:unpublish 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90
```

**`entries:create <contestId>`** — add a signup. Flags: `--email` (required), `--name`, `--action-type` (default `api_import`), `--points`, `--value`; `metadata` via `--data`.

```sh
tokei-agent entries:create 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 \
  --email fan@example.com --name "Ada Lovelace" --points 10 --value "Order #12345"
```

A duplicate email for the same page returns `409` — the person is already signed up; usually safe to treat as success.

**`webhooks:list`** — list webhook subscriptions. Flags: `--page`, `--per-page <1-100>`. Watch `failure_count`: a subscription is auto-disabled after 10 consecutive failed deliveries.

```sh
tokei-agent webhooks:list
```

**`webhooks:create`** — subscribe an HTTPS endpoint. Flags: `--url` (required), `--events <e1,e2>` (required; currently only `entry.created` exists), `--data`.

```sh
tokei-agent webhooks:create --url https://yourserver.com/webhooks/tokei --events entry.created
```

The response contains the `whsec_` signing secret **exactly once** — it cannot be retrieved again (the CLI also prints a stderr warning). Store it immediately; deliveries are HMAC-SHA256 signed in the `X-TOKEI-Signature` header, expect a 2xx within 10s, and retry with backoff (5s, 30s, 5min).

**`webhooks:delete <webhookId>`** — remove a subscription.

```sh
tokei-agent webhooks:delete 9f1b2a3c-4d5e-6f70-8192-a3b4c5d6e7f8
```

## MCP server

`tokei-agent mcp` runs a local MCP server over stdio (newline-delimited JSON-RPC) exposing every command above as an MCP tool — no extra install, zero dependencies. Tool names swap `:` for `_` (`pages:list` → `pages_list`); inputs use the API's wire field names directly (`contest_id`, `per_page`, `prizes`, …) instead of flags, so nested bodies need no `--data`. Results carry the same envelope (`rate_limit` included) as text content, with `isError` set on API failures — the error semantics table below applies unchanged. Register it with an MCP client, e.g. Claude Code:

```sh
claude mcp add tokei --env TOKEI_API_KEY=tokei_k_... -- npx -y tokei-agent mcp
```

## `--data` semantics

Write commands accept `--data '<json>'` or `--data @file.json` for the raw request body (must be a JSON object). Individual field flags are merged **on top of** `--data` — **flags win** on conflict. The merged body is sent to the API untouched: the CLI does no schema validation, so the API's `422` response with per-field `error.details` **is** the validation. Fields only reachable via `--data`: `prizes`, `reward_thresholds`, and nulls (e.g. `{"end_date": null}` clears the end date) on `pages:update`; `metadata` on `entries:create`.

## Error semantics — what to DO per status

| Status | `error.code`          | Meaning                                                                 | Agent action                                                                                     |
| ------ | --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 400    | `BAD_REQUEST`         | Invalid query parameters.                                               | Fix the request. Do not retry as-is.                                                             |
| 401    | `UNAUTHORIZED`        | Missing, invalid, revoked, or **expired** key.                          | Stop and ask the human for a fresh key. Never retry.                                             |
| 403    | `FORBIDDEN`           | Key is valid but: trial plan (no API access), or the key **lacks the write scope** for a write command. | Do not retry. Ask the human for a read+write key (or a plan upgrade). Not an ownership error.    |
| 404    | `NOT_FOUND`           | Resource doesn't exist **or is not owned by this key's account** — ownership failures are masked as 404. `pages:clone --template <slug>` also 404s when the slug matches no template (`error.details` has `field: "template"`). | Verify the id via `pages:list` / `webhooks:list`, or the slug via `templates:list`. Do not retry. For `webhooks:delete`, a 404 usually means already deleted — safe to treat as success. |
| 409    | `CONFLICT`            | `entries:create`: email already entered. `pages:clone`: idempotency key already used (existing page's id is in `error.details`). | Safe to treat as success in both cases — the desired state already exists. Do not retry.          |
| 409    | `WINNERS_ALREADY_SELECTED` | `pages:update`: `--end-date` was changed on a page whose winners have already been drawn. | Do not retry. Tell the human the draw is final — they must clear the winner selection in the dashboard first. Other fields still patch fine; just omit `--end-date`. |
| 413    | `PAYLOAD_TOO_LARGE`   | Body over the 10KB limit.                                               | Shrink the body. Do not retry as-is.                                                             |
| 422    | `VALIDATION_ERROR`    | Body failed validation; `error.details` is an array of `{field, message}`. | Fix exactly the listed fields, then retry once.                                                  |
| 429    | `RATE_LIMIT_EXCEEDED` | Per-minute limit, or the 20/day clone cap.                              | Wait `Retry-After` seconds (in the response headers), then retry with exponential backoff.       |
| 5xx    | `INTERNAL_ERROR`      | Server fault.                                                           | Retry with exponential backoff, max 2–3 attempts, then report to the human.                      |
| (none) | `network_error`       | Request never reached the API (DNS, timeout, refused).                  | Retry with backoff a couple of times, then report.                                               |

## Self-throttling

Every successful and failed API response includes `rate_limit` in the envelope (from the `X-RateLimit-*` headers). Limits are per account: Subscriber 60 read / 30 write per minute, Lifetime 120 / 60. When `rate_limit.remaining` is low, slow down; when it's 0, sleep until `rate_limit.reset` (Unix epoch seconds) before the next call. Don't burn the budget discovering a 429 — read the envelope you already have.
