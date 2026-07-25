# tokei-agent

Control your [Tokei](https://tokei.io) pre-launch and waitlist campaigns from the command line — and from AI agents like Claude Code and OpenClaw. Wraps the Tokei v1 REST API with JSON-only output, zero runtime dependencies.

## Install

```sh
npm install -g tokei-agent
# or run without installing:
npx tokei-agent --help
```

Requires Node 22+.

## Quick start

1. Create an API key at [tokei.io](https://tokei.io) → Dashboard → Settings → API Keys. Pick **read-only** unless you need to change things; API access requires an active subscription or lifetime plan.

2. Export it:

```sh
export TOKEI_API_KEY=tokei_k_...
```

3. Try it:

```sh
tokei-agent me                       # verify the key, see plan + API usage
tokei-agent pages:list --status active
tokei-agent stats <contestId>        # analytics for one page
```

Every command prints JSON to stdout with a top-level `rate_limit` object. Exit codes: `0` success, `1` API/network error, `2` usage error (JSON on stderr).

> **Known issue — exit codes on Node 24 / Windows.** The CLI can print its correct JSON output and then abort during process exit, corrupting the exit code (`$LASTEXITCODE` reads `-1073740791` / `0xC0000409` on success and failure alike). Judge a run by the JSON on stdout, not by the exit status.

## Commands

Read (any key):

| Command                    | Does                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `me`                       | Verify the key; account, plan, API usage                    |
| `pages:list`               | List pages — `--status`, `--mode`, `--page`, `--per-page`   |
| `pages:get <contestId>`    | One page in full (prizes, reward tiers, public URL)         |
| `stats <contestId>`        | Aggregated analytics                                        |
| `leaderboard <contestId>`  | Participants ranked by points                               |
| `entries:list <contestId>` | Signups — filter with `--email`                             |
| `surveys:list <contestId>` | Survey responses                                            |

Write (needs a read+write key):

| Command                       | Does                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| `pages:clone`                 | Create a page by cloning one you own (or the starter template). 20/day cap |
| `pages:update <contestId>`    | Update title, description, dates, prizes, reward tiers                   |
| `entries:create <contestId>`  | Add a signup                                                             |
| `webhooks:list`               | List webhook subscriptions                                               |
| `webhooks:create`             | Subscribe an HTTPS endpoint (`whsec_` secret shown once — save it!)      |
| `webhooks:delete <webhookId>` | Remove a subscription                                                    |

Write commands take simple fields as flags and full/nested bodies via `--data '<json>'` or `--data @file.json` (flags win on conflict). Run `tokei-agent --help` for every flag, or see [SKILL.md](./SKILL.md) — the agent-oriented reference bundled in this package, with worked examples and error-handling guidance.

```sh
tokei-agent pages:clone --title "Spring Launch Waitlist" --source <promotionId>
tokei-agent pages:update <contestId> --end-date 2026-09-01T00:00:00Z
```

## MCP server

The package doubles as a local MCP server (stdio): every command above becomes an MCP tool (`pages_list`, `pages_update`, `stats`, …) for Claude Code, Claude Desktop, and other MCP clients.

```sh
claude mcp add tokei --env TOKEI_API_KEY=tokei_k_... -- npx -y tokei-agent mcp
```

Or in JSON config:

```json
{
  "mcpServers": {
    "tokei": {
      "command": "npx",
      "args": ["-y", "tokei-agent", "mcp"],
      "env": { "TOKEI_API_KEY": "tokei_k_..." }
    }
  }
}
```

## Environment

| Variable        | Required | Meaning                                          |
| --------------- | -------- | ------------------------------------------------ |
| `TOKEI_API_KEY` | Yes      | Sent as `Authorization: Bearer <key>`            |
| `TOKEI_API_URL` | No       | Base URL override (default `https://tokei.io`)   |

## Agents, human in the loop

Tokei is built so agents draft and humans approve: give monitoring agents a read-only key, reserve read+write keys for agents that genuinely need to change things, and set key expiry. New webhook subscriptions created via the API trigger a security notification to the account owner.

## Docs

- API reference: https://tokei.io/docs/api
- OpenAPI spec: https://tokei.io/openapi.json
- Agent skill reference: [SKILL.md](./SKILL.md)

## License

MIT
