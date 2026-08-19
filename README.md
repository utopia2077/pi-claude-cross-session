# pi-claude-cross-session

Cross-session messaging between **pi** and **Claude Code**, built on Claude
Code's own peer protocol. The pi side registers the same two tools Claude
Code's cross-session messaging exposes, with identical definitions:
`ListAgents` (discovery) and `SendMessage` (delivery), plus `/list-agents` and
`/peers` commands. The Claude side needs nothing installed: this pi session
appears in Claude Code's native `ListAgents` and receives its native
`SendMessage` messages unchanged.

One paragraph on the mechanics: Claude Code gives each of its sessions an inbox
socket and a registry record on disk. pi discovers live Claude sessions from
that registry, and writes peer-protocol frames to their inbox sockets. In the
reverse direction, pi binds its own inbox socket and publishes its own registry
record as a `pi-*` peer, so Claude Code's built-in tools reach pi the same way
they reach another Claude session. Inbound messages are delivered to the pi
agent between tool calls during a turn, or start a new turn when pi is idle —
the same delivery behavior Claude Code documents for its own sessions.

The feature this extends is documented in Claude Code's own
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
page. The registry and wire shapes it rests on are not a documented
third-party API; this package validates every consumed field, frame, socket,
and process fact strictly before use, and interface drift degrades only this
feature.

## Requirements

- pi 0.84.2 or later (tested with 0.84.2), running on macOS or Linux.
- Claude Code 2.1.224 or later, with cross-session messaging enabled for its
  sessions. When messaging is on, nothing needs enabling; if a session is
  missing from the listing, Claude Code's own requirements apply (version,
  feature-flag evaluation, inbox socket binding).
- The receiving Claude session's `crossSessionInbound` setting controls
  messages entering it. pi cannot and does not override that decision.

## Install

Once published:

```bash
pi install npm:pi-claude-cross-session@0.1.0
# or, from a git release tag:
pi install git:github.com/<owner>/pi-claude-cross-session@v0.1.0
```

For a quick test without installing, from this checkout:

```bash
pi -e ./index.ts
```

## The tools

The two tools carry Claude Code's own names, descriptions, and parameter
schemas verbatim, so models trained on Claude Code's tool surface drive them
unchanged.

### ListAgents

Discover which sessions pi can message. Lists each live, messaging-enabled
Claude Code session as one row: its name, kind label, status, and working
directory. A name is the address for `SendMessage`. When two rows share a bare
name, the listing appends a short ` [ref]` to those rows; send to the full
`name [ref]` form to disambiguate. A session appears only when it binds its
inbox socket; live sessions without one are reported as a count, not listed.

### SendMessage

Deliver one plain-text message to a named session. `to` accepts a bare name
from the listing or a `name [ref]` form when a listing or an error shows one.
The optional `summary` field is accepted for definition parity; like in Claude
Code it is a UI-only preview that never travels with the message body, and pi
has no such preview, so it has no effect here. The message reaches the target
session's inbox; its own `crossSessionInbound` setting decides whether Claude
reads it, and the outcome is reported back to pi as a delivery notice.

## Behavior and boundaries

- **Delivery is to the session's inbox, not to the model.** `SendMessage`
  reports success when the frame is written to the target's inbox socket. The
  receiving session's own inbound settings decide whether Claude reads it.
  Claude Code reports the outcome (held/denied/expired/delivered) back to pi's
  socket; pi shows it as a delivery notice in the transcript.
- **A failed write is never retried automatically.** A timeout before any
  bytes are written is a clean failure; a write whose outcome became
  ambiguous is reported as such and must be checked with the recipient.
- **Names are the only address.** Messages address a session by its exact
  current name from `ListAgents`, with ` [ref]` appended only when the bare
  name is ambiguous. Session UUIDs and socket paths are never printed or
  persisted.
- **One process, one advertisement.** pi binds one inbox socket and publishes
  one registry record at session start; both are removed at session shutdown,
  including when a status update races the shutdown.
- **Bounded.** Frames are capped at 64 KiB, 32 concurrent connections, 8
  frames per connection, and at most 50 inbound messages waiting to be read;
  overflow is dropped.
- **Same-user, same-machine.** pi never talks to sessions on other machines,
  never passes through Anthropic servers, and only reaches sessions owned by
  the current OS user. The registry directory and socket directory must be
  real directories owned by the current user with mode 0700; anything unsafe
  degrades the feature with a loud notice instead of guessing.
- **Provenance is displayed, not authenticated.** Inbound messages are labeled
  with the sender's session name resolved from the registry. Code already
  running as your OS user can read or write these same files and sockets.

## Known limitations

- **`/reload` rotates the session identity.** pi generates a fresh session
  UUID at each `session_start`, so after a `/reload` (or any session
  replacement) Claude sees a new peer and conversation continuity across the
  boundary is lost. The advertisement is per-session by design; messages in
  flight settle against the old identity.
- **No deduplication or loop throttle.** Claude Code rate-limits repeated
  messages and drops identical repeats; pi only bounds the pending inbound
  queue at 50 messages. A buggy or hostile same-user sender can still fill the
  queue.
- **The pi glue layer has no automated tests.** The protocol adapter
  (`peer.ts`) is covered by unit tests with fake sockets and test-owned
  directories; the extension wiring in `index.ts` is exercised by manual smoke
  tests against real pi sessions.

## Configuration

- `PI_CLAUDE_MESSAGING=off` (or `0`, `no`, `false`) disables the extension:
  no tools are functional, no socket is bound, no registry record is written.

## What it deliberately is not

- Not a broker or daemon: one pi process owns one socket and one registry
  record, created at session start and removed at session shutdown.
- Not an orchestrator: pi never spawns or manages Claude sessions, and never
  interrupts or steers them.
- Not a permission bypass: a message from another session never approves
  anything, and pi's own tools and permission prompts still apply to anything
  an inbound message asks for.

## Troubleshooting

- `ListAgents` returns "no reachable sessions": the target Claude session
  must be running with messaging enabled. `/list-agents` inside Claude Code
  shows which of its own sessions it can reach.
- The registry is missing entirely: start Claude Code once; it creates
  `~/.claude/sessions`.
- A send reports success but the Claude session shows nothing: check the
  destination session's `crossSessionInbound` setting and pi's delivery
  notices; a held or refused message is reported there.
- On Linux, the advertised record and process checks use `/proc`; in
  containers without `/proc`, discovery and liveness checks degrade.

## Development

### Local development loop

Install the checkout into pi without copying it; pi reads the `pi.extensions`
manifest from `package.json` and loads `index.ts` directly, so edits take
effect on `/reload`:

```bash
pi install /absolute/path/to/pi-claude-cross-session
pi list                      # should list the package
```

Inside a pi session, verify the extension is active: session start prints a
notice like `visible to Claude Code as "pi-<dir>-<hash>"`, and asking the
agent to call `ListAgents` exercises the real path. After each code change,
run `/reload` inside the pi TUI to hot-reload the extension.

Use `-e ./index.ts` for one-off runs that write nothing to settings, and
`pi remove /absolute/path/to/pi-claude-cross-session` to uninstall.

### Repo checks

```bash
npm ci
npm run check   # biome + tsc + vitest (runs on Linux and macOS in CI)
```

The test suite uses only test-owned temporary directories and fake sockets; it
never touches the real `~/.claude/sessions` registry, `/tmp/cc-socks`, or a
live peer.

## Publishing notes

- The npm tarball ships only `index.ts`, `peer.ts`, and the docs via the
  `files` field; pi loads TypeScript directly, so there is no build step.
- pi bundles `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
  `typebox`; this package declares them as `peerDependencies` with `"*"` and
  has no runtime dependencies of its own.
- The pi package gallery shows previews for packages that declare an `image`
  (or `video`) field in the `pi` manifest; add one when a banner asset exists.

## License

[MIT](LICENSE)
