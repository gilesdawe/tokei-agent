# Changelog

All notable changes to `tokei-agent`. Dates are the npm publish times.

This file was seeded on 2026-08-02, after 0.3.2 shipped, by reconstructing the
history from `npm view tokei-agent time` and the commits that touched `cli/`.
Entries before 0.3.3 are therefore summaries written after the fact; entries
from 0.3.3 on are written as part of the release.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package is pre-1.0: minor versions may carry breaking changes, though none
has so far.

## [Unreleased]

## [0.3.4] — 2026-08-20

### Added

- `pages:update --template simple` — the Custom template: bare structural
  markup the creator styles entirely via `--custom-css`, rather than a fixed
  layout.
- `pages:update --custom-css <css>` — creator CSS for the Custom template,
  applied on both the hosted page and the widget embed via `--tokei-*` custom
  properties and `.tokei-simple-*` class hooks. Max 20 KB; server-sanitised,
  with unsafe constructs rejected by a 422 naming the reason.
- `--card-width` gains `xl` and `max-w-7xl`, in both the CLI flag and the
  `pages_update` MCP tool's schema.
- `entry_methods` — the page's action buttons — is now settable through
  `pages:update --data` and the `pages_update` MCP tool, alongside `prizes`
  and `reward_thresholds`. Replaces the whole list wholesale: an action row
  (`actionType`, `label`, `points?`, `config?`, `requireVerification?`) or a
  custom-link row (`label`, `points?`, `link`, `actionsRequired?`) with no
  `actionType`.

## [0.3.3] — 2026-08-03

### Added

- `events:catalog` (+ `--type`) and the `events_catalog` MCP tool — every
  webhook event Tokei can send, with its payload schema, description and emit
  sites, fetched from the API rather than bundled so the CLI can never drift
  from the platform. **21 commands, 21 MCP tools.**
- `winners:list <contestId>` and the `winners_list` MCP tool — read-only
  selection-run history with the winners of each run. Unpaginated, capped at the
  100 most recent runs. Selecting winners stays a human action in the dashboard;
  the CLI can only read the result.
- **All five webhook events are now subscribable**, not just `entry.created`:
  `contest.ended`, `winner.selected`, `daily_bonus.claimed` and
  `referral.converted` now fire on the live platform and are accepted by
  `webhooks:create --events`. Previously they were catalogued but rejected with
  a 422.
- **Installable as a Claude Code plugin** — a fifth distribution channel
  alongside npm, skills.sh, ClawHub and the MCP registry:

  ```
  /plugin marketplace add gilesdawe/tokei-agent
  /plugin install tokei-agent@tokei
  ```

  The skill then loads automatically as `tokei-agent:tokei-agent`, with no
  `npx skills add` step. Adds `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` to the repo. Not included in the npm
  tarball — plugin users install from GitHub.
- The ANSI wordmark now renders above `--help` at an interactive terminal.
  Previously `--help` returned before the terminal UI was created, so the first
  command most people run was undecorated. Suppressed — byte for byte — for
  pipes, redirects, CI, `TERM=dumb`, `TOKEI_OUTPUT=json` and terminals narrower
  than 60 columns, so parsed output is unchanged.
- `SKILL.md` gains a fourth hard rule: get explicit human approval before any
  action that emails people or changes anything public, with the read-only
  commands listed as exempt.

### Fixed

- The `webhooks_create` MCP tool advertised `entry.created` as the only valid
  value for `events`, in both its JSON-schema `enum` and its description. MCP
  clients read that schema as the contract, so an agent had no way to subscribe
  to the four events this release activates. The CLI's own `webhooks:create` was
  never affected.

### Changed

- This changelog now ships in the tarball. It was added 27 minutes after 0.3.2
  published, so 0.3.3 is the first release to carry it.
- `SKILL.md`'s `templates:list` sample is refreshed against the live 14-template
  menu and marked as an excerpt. It was always illustrative — call the endpoint,
  never hardcode a slug.

## [0.3.2] — 2026-08-02

### Added

- `referrals:top <contestId>` and the `referrals_top` MCP tool — top referrers
  ranked by conversions, plus click/conversion totals. Lists only entrants who
  have actually referred someone. **19 commands, 19 MCP tools.**

### Fixed

- The interactive-output note in `README.md` / `SKILL.md` said "0.3.2+"; the
  feature shipped in 0.3.1.

## [0.3.1] — 2026-08-02

### Added

- `actions:catalog` (+ `--type`) and the matching MCP tool — every entry-action
  type Tokei supports, fetched from the API rather than bundled, so the CLI can
  never drift from the platform.
- Interactive terminal output: the ANSI wordmark on `me`, plus a step line,
  animated spinner and one-line summary elsewhere. Inert unless a real terminal
  is attached — `TOKEI_OUTPUT=json`, `NO_COLOR` and `TOKEI_NO_ANIM=1` all
  control it.

### Fixed

- `--version` now reports the real version. The 0.3.0 tarball was built from a
  tree still labelled 0.2.2 and reported that instead.

## [0.3.0] — 2026-07-26

### Added

- `media:upload <file>` and the `media_upload` MCP tool — two-step signed-ticket
  upload (request a ticket, PUT the bytes), returning a `public_url`.
- Seven media flags on `pages:update`: `--image-video`, `--secondary-image`,
  `--third-image`, `--fourth-image`, `--fifth-image`, `--background-image`,
  `--og-image`.

### Fixed

- Exit-code corruption on Node 24 / Windows: the CLI printed correct JSON and
  then aborted during process exit, so `$LASTEXITCODE` read `-1073740791`
  (`0xC0000409`) on success and failure alike.

### Known issue

- This tarball reports `--version` as `0.2.2`. Fixed in 0.3.1.

## [0.2.2] — 2026-07-25

### Changed

- Documented the exit-code contract: `0` success, `1` API/network error,
  `2` usage error.

## [0.2.1] — 2026-07-22

### Added

- `templates:list` and clone-by-slug (`pages:clone --template <slug>`).
- `pages:publish` / `pages:unpublish` (status draft ⇄ active; publishing
  requires a future `end_date`).
- Appearance flags on `pages:update`: `--template`, `--dark-mode`,
  `--primary-color`, `--card-width`.

## [0.2.0] — 2026-07-20

### Added

- `mcp` — the bundled MCP stdio server, exposing every command as an MCP tool
  for Claude Code, Claude Desktop and other MCP clients.

## [0.1.0] — 2026-07-20

### Added

- Write commands: `pages:clone`, `pages:update`, `entries:create`,
  `webhooks:create`, `webhooks:delete`.
- `SKILL.md` and `README.md`, making the package usable as an agent skill.

## [0.0.1] — 2026-07-20

### Added

- First publish. Read commands (`me`, `pages:list`, `pages:get`, `stats`,
  `leaderboard`, `entries:list`, `surveys:list`, `webhooks:list`), `TOKEI_API_KEY`
  auth, JSON-only stdout with a top-level `rate_limit` object, zero runtime
  dependencies.

[unreleased]: https://github.com/gilesdawe/tokei-agent/compare/v0.3.4...HEAD
[0.3.4]: https://www.npmjs.com/package/tokei-agent/v/0.3.4
[0.3.3]: https://www.npmjs.com/package/tokei-agent/v/0.3.3
[0.3.2]: https://www.npmjs.com/package/tokei-agent/v/0.3.2
[0.3.1]: https://www.npmjs.com/package/tokei-agent/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/tokei-agent/v/0.3.0
[0.2.2]: https://www.npmjs.com/package/tokei-agent/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/tokei-agent/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/tokei-agent/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/tokei-agent/v/0.1.0
[0.0.1]: https://www.npmjs.com/package/tokei-agent/v/0.0.1
