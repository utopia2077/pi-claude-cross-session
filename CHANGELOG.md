# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] - unreleased

### Added

- `ListAgents` and `SendMessage` tools with Claude Code's own names,
  descriptions, and parameter schemas, including ` [ref]` disambiguation
  for shared session names.
- Claude Code peer protocol 1 adapter: strict registry discovery, native
  wire frames, `peer_message_status` receipts, and one process-owned inbox
  advertisement so Claude Code's native tools reach pi unchanged.
- `/list-agents` and `/peers` commands with a transcript entry renderer.
- Inbound delivery between tool calls (steer) or a new turn when idle,
  bounded at 50 pending messages.
- Bounded limits: 64 KiB frames, 32 connections, 8 frames per connection.
- `PI_CLAUDE_MESSAGING=off` opt-out.
- Unit tests for the protocol adapter (10 tests, fake sockets and
  test-owned directories only).
