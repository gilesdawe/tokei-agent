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

## Commands (read — any key)

**`me`** — verify the key, see plan and API usage.

```sh
tokei-agent me
```

**`pages:list`** — list your pages. Flags: `--status draft|active|ended|paused`, `--mode competition|gamification|sharing_only`, `--page <n>`, `--per-page <1-100>`.

```sh
tokei-agent pages:list --status active --per-page 20
```

**`pages:get <contestId>`** — one page, full object (includes `description`, `prizes`, `reward_thresholds`, `public_url`).

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

## Commands (write — need a read+write key)

**`pages:clone`** — create a page by cloning one you own (`--source <promotionId>`), or omit `--source` to clone the platform starter template. Template, theme, and entry methods copy verbatim from the source — keep one polished master page per shape and clone it. Capped at **20 API-created pages per account per UTC day** (429 with `Retry-After`). Flags: `--title` (required), `--source`, `--description`, `--prize`, `--end-date <iso>`, `--campaign-url`, `--image-url`, `--status draft|active`, `--idempotency-key`, `--data`.

```sh
tokei-agent pages:clone --title "Spring Launch Waitlist" \
  --source 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 \
  --prize "Lifetime license" --end-date 2026-09-01T00:00:00Z \
  --idempotency-key spring-launch-2026
```

`--status active` makes the page live immediately at the returned `public_url`; the default is `draft`. Reuse an `--idempotency-key` and you get `409` with the existing page's id in `error.details` instead of a duplicate.

**`pages:update <contestId>`** — PATCH a page. Simple fields via flags: `--title`, `--description`, `--start-date <iso>`, `--end-date <iso>`. Prizes, reward tiers, nulls, or a full body via `--data`. At least one field required; unknown fields are rejected (422). `prizes` (max 20) and `reward_thresholds` (max 50) each **replace the existing list wholesale** — read the current lists with `pages:get` first, modify, and send the complete list back. A future `start_date` pauses new entries until then; setting `end_date` recomputes `days_left`.

```sh
tokei-agent pages:update 4e7a1c0e-8b2d-4f6a-9c3e-2d5b8a7f1e90 \
  --title "Now with 3 prize tiers" \
  --data '{"prizes":[{"name":"AirPods Pro","winners":1,"value":249,"currency":"USD"},{"name":"Sticker pack","winners":50}]}'
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
| 404    | `NOT_FOUND`           | Resource doesn't exist **or is not owned by this key's account** — ownership failures are masked as 404. | Verify the id via `pages:list` / `webhooks:list`. Do not retry. For `webhooks:delete`, a 404 usually means already deleted — safe to treat as success. |
| 409    | `CONFLICT`            | `entries:create`: email already entered. `pages:clone`: idempotency key already used (existing page's id is in `error.details`). | Safe to treat as success in both cases — the desired state already exists. Do not retry.          |
| 413    | `PAYLOAD_TOO_LARGE`   | Body over the 10KB limit.                                               | Shrink the body. Do not retry as-is.                                                             |
| 422    | `VALIDATION_ERROR`    | Body failed validation; `error.details` is an array of `{field, message}`. | Fix exactly the listed fields, then retry once.                                                  |
| 429    | `RATE_LIMIT_EXCEEDED` | Per-minute limit, or the 20/day clone cap.                              | Wait `Retry-After` seconds (in the response headers), then retry with exponential backoff.       |
| 5xx    | `INTERNAL_ERROR`      | Server fault.                                                           | Retry with exponential backoff, max 2–3 attempts, then report to the human.                      |
| (none) | `network_error`       | Request never reached the API (DNS, timeout, refused).                  | Retry with backoff a couple of times, then report.                                               |

## Self-throttling

Every successful and failed API response includes `rate_limit` in the envelope (from the `X-RateLimit-*` headers). Limits are per account: Subscriber 60 read / 30 write per minute, Lifetime 120 / 60. When `rate_limit.remaining` is low, slow down; when it's 0, sleep until `rate_limit.reset` (Unix epoch seconds) before the next call. Don't burn the budget discovering a 429 — read the envelope you already have.
