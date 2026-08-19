/**
 * Claude Code cross-session messaging for pi.
 *
 * Registers the same two tools Claude Code's own cross-session messaging
 * exposes, with identical definitions:
 *
 * - `ListAgents`: discover live, messaging-enabled Claude Code sessions on
 *   this machine.
 * - `SendMessage`: deliver a plain-text message to one of them by exact
 *   session name (with ` [ref]` disambiguation when names collide), over
 *   that session's native inbox socket.
 *
 * The reverse direction works natively: pi advertises itself as a `pi-*`
 * peer in Claude Code's own session registry, so Claude's ListAgents shows
 * this pi session and Claude's SendMessage reaches it unchanged. Inbound
 * messages are delivered to the pi agent between tool calls (or start a new
 * turn when pi is idle), and senders receive native delivery receipts.
 *
 * Usage: copy this directory to ~/.pi/agent/extensions/ (global) or
 * .pi/extensions/ (project-local). Requires Claude Code 2.1.224+ on macOS or
 * Linux. Set PI_CLAUDE_MESSAGING=off to disable the feature entirely.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ClaudeInbox,
	type ClaudeInboxOptions,
	type DiscoveredPeer,
	discoverClaudePeers,
	type InboundPeerMessage,
	type InboundPeerStatus,
	PEER_NAME_PATTERN,
	sendToNamedPeer,
} from "./peer.ts";

const MESSAGE_CUSTOM_TYPE = "claude-message";
const STATUS_CUSTOM_TYPE = "claude-message-status";
const PEER_LIST_ENTRY_TYPE = "claude-peers";
const MAX_PENDING_INBOUND = 50;
const MAX_LISTED_PEERS = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;

function messagingDisabled(): boolean {
	const value = process.env.PI_CLAUDE_MESSAGING?.toLowerCase();
	return value === "0" || value === "off" || value === "no" || value === "false";
}

function sanitizeName(input: string): string | undefined {
	const trimmed = input.trim();
	return PEER_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

function derivedName(cwd: string): string {
	const base =
		path
			.basename(cwd)
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^[^a-z0-9]+/, "")
			.slice(0, 45) || "session";
	return `pi-${base}-${randomUUID().slice(0, 3)}`;
}

function formatCwd(cwd: string): string {
	const home = os.homedir();
	return cwd === home ? "~" : cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
}

function statusText(status: InboundPeerStatus["status"]): string {
	switch (status) {
		case "held":
			return "held for the receiving user's approval";
		case "denied":
			return "refused by the receiving session";
		case "expired":
			return "dropped after the approval deadline expired";
		case "delivered":
			return "delivered to Claude";
	}
}

function peerListText(peers: DiscoveredPeer[]): string {
	// A row's name is the address. Append the ` [ref]` disambiguator only when
	// the bare name is not enough, exactly like Claude Code's own listing.
	const nameCounts = new Map<string, number>();
	for (const peer of peers) nameCounts.set(peer.name, (nameCounts.get(peer.name) ?? 0) + 1);
	return peers
		.map((peer) => {
			const address = (nameCounts.get(peer.name) ?? 0) > 1 ? `${peer.name} [${peer.ref}]` : peer.name;
			return `${address} local ${peer.status} - ${formatCwd(peer.cwd)}`;
		})
		.join("\n");
}

export default function claudeCrossSessionExtension(pi: ExtensionAPI) {
	let inbox: ClaudeInbox | undefined;
	let roots: { sessionsDir: string; socketDir: string } | undefined;
	let degraded: string | undefined;
	let advertisedName: string | undefined;
	let pendingInbound = 0;

	const unavailableReason = (): string | undefined => {
		if (messagingDisabled()) return "PI_CLAUDE_MESSAGING is off";
		if (process.platform !== "linux" && process.platform !== "darwin") {
			return `unsupported platform ${process.platform} (Claude Code cross-session messaging runs on macOS and Linux)`;
		}
		return degraded;
	};

	const handleInbound = (message: InboundPeerMessage): void => {
		// Bounded: cap messages waiting to be read, like Claude Code's own
		// 50-per-session limit. An overflow is dropped without a receipt.
		if (pendingInbound >= MAX_PENDING_INBOUND) return;
		const sender = message.senderName;
		const body = message.content;
		const content =
			sender !== undefined
				? `Message from Claude Code session "${sender}":\n\n${body}\n\n(To reply, use SendMessage with to="${sender}".)`
				: `Message from an unverified local peer:\n\n${body}`;
		pendingInbound += 1;
		try {
			pi.sendMessage(
				{
					customType: MESSAGE_CUSTOM_TYPE,
					content,
					display: true,
					details: { senderName: sender, rawText: body, timestamp: Date.now() },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			pendingInbound -= 1;
		}
	};

	const handleStatus = (status: InboundPeerStatus): void => {
		void inbox
			?.resolveSenderName(status.fromAddress)
			.then((name) => {
				const sender = name !== undefined ? `Claude Code session "${name}"` : "a Claude Code session";
				try {
					pi.sendMessage(
						{
							customType: STATUS_CUSTOM_TYPE,
							content: `Delivery notice: your message to ${sender} was ${statusText(status.status)}.`,
							display: true,
						},
						{ triggerTurn: false },
					);
				} catch {
					// Delivery notices are best-effort display only.
				}
			})
			.catch(() => undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		degraded = undefined;
		const disabledReason = unavailableReason();
		if (disabledReason !== undefined) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Claude cross-session messaging unavailable: ${disabledReason}`, "warning");
			}
			return;
		}
		const expectedUid = process.getuid?.();
		if (expectedUid === undefined) {
			degraded = "no OS user identity";
			return;
		}
		const sessionName = pi.getSessionName();
		const name = sanitizeName(sessionName ?? "") ?? derivedName(ctx.cwd);
		roots = { sessionsDir: path.join(os.homedir(), ".claude", "sessions"), socketDir: "/tmp/cc-socks" };
		try {
			const options: ClaudeInboxOptions = {
				sessionsDir: roots.sessionsDir,
				socketDir: roots.socketDir,
				expectedUid,
				name,
				nameSource: sessionName !== undefined && sanitizeName(sessionName) !== undefined ? "user" : "derived",
				cwd: ctx.cwd,
				sessionId: randomUUID(),
				platform: process.platform,
				onMessage: handleInbound,
				onStatus: handleStatus,
			};
			inbox = await ClaudeInbox.create(options);
			advertisedName = name;
			if (ctx.hasUI) {
				ctx.ui.notify(`Claude cross-session messaging on: visible to Claude Code as "${name}"`, "info");
			}
		} catch (error) {
			inbox = undefined;
			degraded = error instanceof Error ? error.message : "unknown failure";
			if (ctx.hasUI) {
				ctx.ui.notify(`Claude cross-session messaging unavailable: ${degraded}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		const current = inbox;
		inbox = undefined;
		advertisedName = undefined;
		pendingInbound = 0;
		if (current !== undefined) {
			try {
				await current.close();
			} catch {
				// Cleanup failures leave bounded artifacts for the next start.
			}
		}
	});

	pi.on("session_info_changed", async (event) => {
		if (inbox === undefined) return;
		const next = sanitizeName(event.name ?? "");
		if (next === undefined || next === advertisedName) return;
		try {
			await inbox.rename(next, "user");
			advertisedName = next;
		} catch {
			// A rename failure keeps the previous advertised name.
		}
	});

	pi.on("agent_start", () => {
		if (inbox === undefined) return;
		void inbox.updateStatus("busy").catch(() => undefined);
	});

	pi.on("agent_settled", () => {
		pendingInbound = 0;
		if (inbox === undefined) return;
		void inbox.updateStatus("idle").catch(() => undefined);
	});

	const runListAgents = async (): Promise<AgentToolResult<{ peers: DiscoveredPeer[] }>> => {
		const reason = unavailableReason();
		if (reason !== undefined) {
			return {
				content: [{ type: "text", text: `Claude Code cross-session messaging is unavailable here: ${reason}.` }],
				details: { peers: [] },
			};
		}
		if (roots === undefined || process.getuid === undefined) {
			return {
				content: [{ type: "text", text: "Claude Code cross-session messaging has not started in this session." }],
				details: { peers: [] },
			};
		}
		const discovery = await discoverClaudePeers({
			sessionsDir: roots.sessionsDir,
			socketDir: roots.socketDir,
			expectedUid: process.getuid(),
			ownPid: process.pid,
			platform: process.platform,
		});
		if (discovery.registryMissing) {
			return {
				content: [
					{
						type: "text",
						text: "No Claude sessions registry exists for this user account (~/.claude/sessions). Start Claude Code once to create it.",
					},
				],
				details: { peers: [] },
			};
		}
		const listed = discovery.peers.slice(0, MAX_LISTED_PEERS);
		if (listed.length === 0) {
			const extra =
				discovery.unreachable > 0
					? ` ${discovery.unreachable} live session(s) exist without a bound inbox socket and cannot receive messages.`
					: "";
			return {
				content: [
					{
						type: "text",
						text: `No reachable Claude Code sessions on this machine. A session appears here only when it runs with cross-session messaging enabled (Claude Code 2.1.224+) and binds its inbox socket.${extra}`,
					},
				],
				details: { peers: [] },
			};
		}
		const listing = peerListText(listed);
		const extra =
			discovery.unreachable > 0
				? `\n${discovery.unreachable} other live session(s) have no inbox socket and cannot receive messages.`
				: "";
		return {
			content: [{ type: "text", text: `${listing}${extra}` }],
			details: { peers: listed },
		};
	};

	const runSendMessage = async (to: string, text: string): Promise<AgentToolResult<unknown>> => {
		const reason = unavailableReason();
		if (reason !== undefined) {
			return {
				content: [{ type: "text", text: `Cross-session messaging is unavailable here: ${reason}.` }],
				details: {},
			};
		}
		if (roots === undefined || inbox === undefined || process.getuid === undefined) {
			return {
				content: [{ type: "text", text: "Cross-session messaging is not active in this session." }],
				details: {},
			};
		}
		if (text.length === 0 || text.includes("\0") || Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
			return {
				content: [
					{
						type: "text",
						text: `Message text must be non-empty, NUL-free, and at most ${MAX_MESSAGE_BYTES} bytes.`,
					},
				],
				details: {},
			};
		}
		const result = await sendToNamedPeer({
			sessionsDir: roots.sessionsDir,
			socketDir: roots.socketDir,
			expectedUid: process.getuid(),
			ownPid: process.pid,
			name: to,
			content: text,
			fromAddress: inbox.address,
			platform: process.platform,
		});
		if (result.ok) {
			return {
				content: [
					{
						type: "text",
						text: `Message sent to "${to}". It reached the session's inbox; the receiving session's own crossSessionInbound setting decides whether Claude reads it. If accepted, its Claude may reply to "${advertisedName ?? "this session"}" by name.`,
					},
				],
				details: {},
			};
		}
		return {
			content: [{ type: "text", text: result.message }],
			details: { code: result.code },
		};
	};

	pi.registerTool({
		name: "ListAgents",
		label: "ListAgents",
		description:
			'Lists agents you can SendMessage to — in-process subagents you spawned, other local Claude sessions on this machine, your Claude sessions running in the cloud (when this session has cloud access), and (when Remote Control is connected here) your account\'s other sessions — Remote Control sessions on other machines and cloud sessions, each row labeled by kind. Names are the address: send with `SendMessage({to: "<name>", message: "..."})`, copying the name exactly as a row prints it. Append a row\'s ` [ref]` only when the bare name is not enough — two rows share it, or an error asks you to disambiguate.',
		promptSnippet: "Lists agents you can SendMessage to",
		parameters: Type.Object(
			{
				channel: Type.Optional(
					Type.String({ maxLength: 256, description: "Not available in this build; leave unset." }),
				),
				q: Type.Optional(Type.String({ maxLength: 256, description: "Not available in this build; leave unset." })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return await runListAgents();
		},
	});

	pi.registerTool({
		name: "SendMessage",
		label: "SendMessage",
		description: "Send a message to another agent",
		promptSnippet: "Send a message to another agent",
		promptGuidelines: [
			"Use SendMessage to hand findings, decisions, or status to a Claude Code session when that session needs them mid-task.",
			"Address SendMessage only to an exact current session name returned by ListAgents. If the name does not resolve, run ListAgents again; never guess a name.",
		],
		parameters: Type.Object(
			{
				to: Type.String({
					pattern: "^[^\\n\\r]{0,200}$",
					description:
						'Recipient: a name from ListAgents (append its " [ref]" only when a listing or an error shows one), a teammate name, "main", or a background agent\'s agentId',
				}),
				summary: Type.Optional(
					Type.String({
						maxLength: 200,
						description:
							"A 5-10 word summary shown as a one-line preview in the UI. Defaults to the first line of a plain-text message; longer summaries are truncated to 200 characters rather than rejected.",
					}),
				),
				message: Type.String({ description: "Plain text message content" }),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// `summary` is a UI-only preview in Claude Code; it never travels
			// with the message body and is accepted here without effect.
			return await runSendMessage(params.to, params.message);
		},
	});

	pi.registerCommand("list-agents", {
		description: "List Claude Code sessions reachable via cross-session messaging",
		handler: async (_args, ctx) => {
			const result = await runListAgents();
			const summary = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "";
			pi.appendEntry(PEER_LIST_ENTRY_TYPE, { peers: result.details.peers, summary });
			ctx.ui.notify(`${result.details.peers.length} reachable Claude Code session(s)`, "info");
		},
	});

	pi.registerCommand("peers", {
		description: "Alias of /list-agents",
		handler: async (_args, ctx) => {
			const result = await runListAgents();
			pi.appendEntry(PEER_LIST_ENTRY_TYPE, { peers: result.details.peers });
			ctx.ui.notify(`${result.details.peers.length} reachable Claude Code session(s)`, "info");
		},
	});

	pi.registerEntryRenderer<{ peers: DiscoveredPeer[] }>(PEER_LIST_ENTRY_TYPE, (entry, _options, theme) => {
		const peers = entry.data?.peers ?? [];
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", "[Claude Code sessions]"), 0, 0));
		if (peers.length === 0) {
			box.addChild(new Text(theme.fg("dim", "(none reachable)"), 0, 0));
			return box;
		}
		const nameCounts = new Map<string, number>();
		for (const peer of peers) nameCounts.set(peer.name, (nameCounts.get(peer.name) ?? 0) + 1);
		for (const peer of peers) {
			const address = (nameCounts.get(peer.name) ?? 0) > 1 ? `${peer.name} [${peer.ref}]` : peer.name;
			const line = `${address}${theme.fg("dim", `  local ${peer.status} - ${formatCwd(peer.cwd)}`)}`;
			box.addChild(new Text(line, 0, 0));
		}
		return box;
	});

	pi.registerMessageRenderer<{ senderName?: string; rawText?: string }>(
		MESSAGE_CUSTOM_TYPE,
		(message, { outputPad }, theme) => {
			const details = message.details ?? {};
			const header =
				details.senderName !== undefined
					? `[Claude Code session "${details.senderName}"]`
					: "[cross-session message]";
			const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("accent", header), 0, 0));
			const body = details.rawText ?? (typeof message.content === "string" ? message.content : "");
			for (const line of body.split("\n")) box.addChild(new Text(line, 0, 0));
			return box;
		},
	);
}
