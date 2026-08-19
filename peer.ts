/**
 * Claude Code peer protocol 1 adapter for the pi cross-session extension.
 *
 * Implements the same-machine side of Claude Code's cross-session messaging:
 *
 * - Discovers live Claude Code sessions from their on-disk session registry
 *   (`<pid>.json` files in `~/.claude/sessions`) and validates them strictly:
 *   peer protocol 1, a live process owned by the current user, and an inbox
 *   socket in the socket directory.
 * - Delivers one bounded plain-text frame to a named session's per-session
 *   Unix-domain inbox socket in the native wire format
 *   (`{"type":"user","message":{"role":"user","content":...},...}`).
 * - Advertises the pi session as a `pi-*` peer through one process-owned
 *   registry record plus one inbox socket, so Claude Code's native
 *   `ListAgents`/`SendMessage` tools reach pi unchanged.
 * - Parses inbound peer frames and writes native `peer_message_status`
 *   control frames back to senders.
 *
 * The registry and wire shapes are not a documented third-party API. Every
 * consumed field, frame, socket, and process fact is validated immediately
 * before use; drift degrades the feature loudly instead of guessing.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Dirent, constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";

export const CLAUDE_PEER_PROTOCOL = 1;
export const PI_ADVERTISEMENT_VERSION = 1;
export const PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGISTRY_FILE_PATTERN = /^([1-9][0-9]{0,9})\.json$/;
const SOCKET_FILE_PATTERN = /^([1-9][0-9]{0,9})\.sock$/;
const MAX_PID = 2_147_483_647;

export const PEER_KINDS = ["interactive", "bg", "daemon", "daemon-worker"] as const;
export const PEER_STATUSES = ["busy", "shell", "idle", "waiting"] as const;
export type PeerKind = (typeof PEER_KINDS)[number];
export type PeerStatus = (typeof PEER_STATUSES)[number];

export interface DiscoveredPeer {
	name: string;
	/** Stable short suffix of the session identity, used only to disambiguate shared names. */
	ref: string;
	kind: PeerKind;
	status: PeerStatus;
	cwd: string;
}

export const PEER_REJECTION_CODES = [
	"ENTRY_LIMIT_EXCEEDED",
	"INVALID_FILE_NAME",
	"REGISTRY_NOT_REGULAR",
	"REGISTRY_TOO_LARGE",
	"REGISTRY_INVALID_JSON",
	"REGISTRY_INVALID_SCHEMA",
	"PID_MISMATCH",
	"PID_NOT_LIVE",
	"PID_OWNER_MISMATCH",
	"SOCKET_OUTSIDE_ROOT",
	"SOCKET_NOT_SOCKET",
	"PEER_NOT_FOUND",
	"PEER_NAME_AMBIGUOUS",
	"CONTENT_INVALID",
	"CONTENT_TOO_LARGE",
	"CONNECT_TIMEOUT",
	"WRITE_FAILED",
	"WRITE_AMBIGUOUS",
] as const;
export type PeerRejectionCode = (typeof PEER_REJECTION_CODES)[number];

export class PeerError extends Error {
	readonly code: string;
	readonly recoverable: boolean;
	readonly errnoCode: string | undefined;

	constructor(code: string, message: string, recoverable = false, errnoCode?: string) {
		super(message);
		this.name = "PeerError";
		this.code = code;
		this.recoverable = recoverable;
		this.errnoCode = errnoCode;
	}
}

export interface PeerLimits {
	maxFrameBytes: number;
	connectTimeoutMs: number;
	maxConnections: number;
	connectionIdleMs: number;
	maxFramesPerConnection: number;
	maxRegistryEntries: number;
	maxRegistryBytes: number;
}

export const DEFAULT_PEER_LIMITS: PeerLimits = {
	maxFrameBytes: 64 * 1024,
	connectTimeoutMs: 2_000,
	maxConnections: 32,
	connectionIdleMs: 5_000,
	maxFramesPerConnection: 8,
	maxRegistryEntries: 256,
	maxRegistryBytes: 16 * 1024,
};

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && byteLength(value) <= maxBytes;
}

function exactMode(mode: number): number {
	return mode & 0o777;
}

function parsePositiveInteger(value: string): number | undefined {
	if (!/^[1-9][0-9]*$/.test(value)) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > MAX_PID) return undefined;
	return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const permitted = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => permitted.has(key));
}

/**
 * Attests that a directory is a real directory owned by the expected user
 * with the exact mode 0700, optionally creating it first. The create path
 * re-lstats after creation so a pre-existing foreign entry can never pass.
 */
export async function attestPeerDirectory(
	candidate: string,
	expectedUid: number,
	options: { create?: boolean } = {},
): Promise<void> {
	if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
		throw new PeerError("INVALID_PEER_PATH", "The peer directory must be an absolute path.");
	}
	let stat: Stats;
	try {
		stat = await lstat(candidate);
	} catch (error) {
		const errno = (error as NodeJS.ErrnoException).code;
		if (errno !== "ENOENT" || options.create !== true) {
			throw new PeerError("UNSAFE_PEER_DIRECTORY", "The peer directory could not be inspected.", false, errno);
		}
		try {
			await mkdir(candidate, { mode: 0o700 });
		} catch (mkdirError) {
			if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new PeerError("UNSAFE_PEER_DIRECTORY", "The peer directory could not be created.");
			}
		}
		stat = await lstat(candidate);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new PeerError("UNSAFE_PEER_DIRECTORY", "The peer directory is not a real directory.");
	}
	if (stat.uid !== expectedUid) {
		throw new PeerError("UNSAFE_PEER_DIRECTORY", "The peer directory owner is unsafe.");
	}
	if (exactMode(stat.mode) !== 0o700) {
		throw new PeerError("UNSAFE_PEER_DIRECTORY", "The peer directory mode is unsafe.");
	}
}

interface ParsedRegistryRecord {
	pid: number;
	sessionId: string;
	cwd: string;
	kind: PeerKind;
	entrypoint: string;
	name: string;
	nameSource: "derived" | "user" | "other";
	status: PeerStatus;
	procStart?: number | string;
	messagingSocketPath?: string;
	version?: string;
}

/**
 * Parses one registry record. Unknown top-level fields are tolerated because
 * this adapter never consumes them; every consumed field is strict. A record
 * whose peer protocol is not 1 is rejected in isolation.
 */
function parseRegistryRecord(value: unknown, expectedPid: number): ParsedRegistryRecord | undefined {
	if (!isObject(value)) return undefined;
	const required = [
		"pid",
		"sessionId",
		"cwd",
		"startedAt",
		"procStart",
		"peerProtocol",
		"kind",
		"entrypoint",
		"name",
		"updatedAt",
	] as const;
	if (!required.every((key) => Object.hasOwn(value, key))) return undefined;
	if (value.pid !== expectedPid) return undefined;
	if (typeof value.sessionId !== "string" || !UUID_PATTERN.test(value.sessionId)) return undefined;
	if (!isBoundedString(value.cwd, 4096) || !path.isAbsolute(value.cwd) || value.cwd.includes("\0")) return undefined;
	if (!Number.isSafeInteger(value.startedAt) || (value.startedAt as number) < 0) return undefined;
	if (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0) return undefined;
	if (!(typeof value.procStart === "number" || isBoundedString(value.procStart, 256))) return undefined;
	if (value.peerProtocol !== CLAUDE_PEER_PROTOCOL) return undefined;
	if (typeof value.kind !== "string" || !(PEER_KINDS as readonly string[]).includes(value.kind)) return undefined;
	if (!isBoundedString(value.entrypoint, 64) || !/^[A-Za-z0-9._-]+$/.test(value.entrypoint)) return undefined;
	if (typeof value.name !== "string" || !PEER_NAME_PATTERN.test(value.name)) return undefined;
	if (value.nameSource !== undefined && !isBoundedString(value.nameSource, 64)) return undefined;
	if (
		value.status !== undefined &&
		(typeof value.status !== "string" || !(PEER_STATUSES as readonly string[]).includes(value.status))
	) {
		return undefined;
	}
	if (value.statusUpdatedAt !== undefined && !Number.isSafeInteger(value.statusUpdatedAt)) return undefined;
	if (value.version !== undefined && !isBoundedString(value.version, 64)) return undefined;
	if (
		value.messagingSocketPath !== undefined &&
		(!isBoundedString(value.messagingSocketPath, 4096) ||
			!path.isAbsolute(value.messagingSocketPath) ||
			value.messagingSocketPath.includes("\0"))
	) {
		return undefined;
	}
	return {
		pid: expectedPid,
		sessionId: value.sessionId.toLowerCase(),
		cwd: value.cwd,
		kind: value.kind as PeerKind,
		entrypoint: value.entrypoint,
		name: value.name,
		nameSource: value.nameSource === "user" ? "user" : value.nameSource === "derived" ? "derived" : "other",
		status: (value.status ?? "busy") as PeerStatus,
		...(typeof value.procStart === "number" || typeof value.procStart === "string"
			? { procStart: value.procStart }
			: {}),
		...(typeof value.messagingSocketPath === "string" ? { messagingSocketPath: value.messagingSocketPath } : {}),
		...(typeof value.version === "string" ? { version: value.version } : {}),
	};
}

type FileGeneration = { dev: number; ino: number; size: number; mtimeMs: number };

function generationOf(stat: { dev: number; ino: number; size: number; mtimeMs: number }): FileGeneration {
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFileGeneration(left: FileGeneration, right: FileGeneration): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
	);
}

/** Reads a registry file with symlink and race protection. */
async function readRegistryFile(registryPath: string, maxBytes: number): Promise<unknown> {
	const before = await lstat(registryPath);
	if (before.isSymbolicLink() || !before.isFile()) {
		throw new PeerError("REGISTRY_NOT_REGULAR", "Unsafe registry file type.");
	}
	if (before.size > maxBytes) {
		throw new PeerError("REGISTRY_TOO_LARGE", "Registry file is too large.");
	}
	const handle = await open(registryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		const openedGeneration = generationOf(opened);
		if (!sameFileGeneration(generationOf(before), openedGeneration)) {
			throw new PeerError("REGISTRY_NOT_REGULAR", "Registry file changed while opening.");
		}
		const buffer = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > maxBytes) {
			throw new PeerError("REGISTRY_TOO_LARGE", "Registry file is too large.");
		}
		const after = await lstat(registryPath);
		if (!sameFileGeneration(openedGeneration, generationOf(after))) {
			throw new PeerError("REGISTRY_NOT_REGULAR", "Registry file changed while reading.");
		}
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset))) as unknown;
		} catch {
			throw new PeerError("REGISTRY_INVALID_JSON", "Registry JSON is invalid.");
		}
	} finally {
		await handle.close();
	}
}

/** Extracts /proc/<pid>/stat field 22 (process start time in clock ticks). */
function statStartTime(content: string): number | undefined {
	const closing = content.lastIndexOf(")");
	if (closing < 0) return undefined;
	const rest = content.slice(closing + 2).split(" ");
	const ticks = Number(rest[19]);
	return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : undefined;
}

function readProcFile(filePath: string): Promise<string | undefined> {
	return readFile(filePath, "utf8").then(
		(content) => content,
		() => undefined,
	);
}

async function processState(
	pid: number,
	expectedUid: number,
	expectedStartTime: number | string | undefined,
	platform: NodeJS.Platform,
): Promise<"live" | "missing" | "foreign"> {
	if (platform === "linux") {
		const [stat, status] = await Promise.all([
			readProcFile(`/proc/${pid}/stat`),
			readProcFile(`/proc/${pid}/status`),
		]);
		if (stat === undefined || status === undefined) return "missing";
		const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
		const uid = uidMatch === null ? undefined : Number(uidMatch[1]);
		if (uid === undefined) return "missing";
		if (uid !== expectedUid) return "foreign";
		if (typeof expectedStartTime === "number") {
			const start = statStartTime(stat);
			if (start === undefined || start !== expectedStartTime) return "missing";
		}
		return "live";
	}
	// macOS has no /proc. `ps` proves liveness and ownership; the record's
	// procStart format is Claude-Code-internal there, so it is not compared.
	return await new Promise((resolve) => {
		execFile(
			"/bin/ps",
			["-o", "uid=", "-p", String(pid)],
			{ encoding: "utf8", timeout: 1_000, maxBuffer: 4_096 },
			(error, stdout) => {
				if (error) {
					resolve("missing");
					return;
				}
				const match = /^\s*(\d+)\s*$/.exec(stdout);
				resolve(match !== null && Number(match[1]) === expectedUid ? "live" : "missing");
			},
		);
	});
}

function socketDirCandidates(socketDir: string): string[] {
	// /tmp symlinks to /private/tmp on macOS; records may use either spelling.
	return socketDir === "/tmp/cc-socks" ? ["/tmp/cc-socks", "/private/tmp/cc-socks"] : [socketDir];
}

function conventionalSocketPath(socketDir: string, pid: number): string {
	return path.join(socketDir, `${pid}.sock`);
}

/** Returns the validated socket path for a record, or undefined when unsafe. */
function socketPathForRecord(record: ParsedRegistryRecord, socketDir: string): string | undefined {
	const candidates = new Set(socketDirCandidates(socketDir));
	const declared = record.messagingSocketPath;
	if (declared !== undefined) {
		if (candidates.has(path.dirname(declared)) && path.basename(declared) === `${record.pid}.sock`) {
			return declared;
		}
		return undefined;
	}
	// Older records omit the field; the inbox socket path follows the
	// `<pid>.sock` convention inside the socket directory.
	const conventional = conventionalSocketPath(socketDir, record.pid);
	return candidates.has(path.dirname(conventional)) ? conventional : undefined;
}

async function validatePeerSocket(socketPath: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await lstat(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new PeerError("SOCKET_NOT_SOCKET", "The peer inbox socket does not exist.");
		}
		throw new PeerError("SOCKET_NOT_SOCKET", "The peer inbox socket could not be inspected.");
	}
	if (stat.isSymbolicLink() || !stat.isSocket()) {
		throw new PeerError("SOCKET_NOT_SOCKET", "The peer endpoint is not a socket.");
	}
}

interface RegistryScan {
	sessionsDir: string;
	socketDir: string;
	expectedUid: number;
	ownPid: number;
	platform: NodeJS.Platform;
	limits: PeerLimits;
}

type EntryOutcome =
	| { kind: "peer"; pid: number; record: ParsedRegistryRecord; socketPath: string }
	| { kind: "reject"; code: PeerRejectionCode }
	| { kind: "unreachable" }
	| { kind: "self" };

async function examineRegistryEntry(scan: RegistryScan, entryName: string): Promise<EntryOutcome> {
	const match = REGISTRY_FILE_PATTERN.exec(entryName);
	if (match === null) return { kind: "reject", code: "INVALID_FILE_NAME" };
	const pid = parsePositiveInteger(match[1] ?? "");
	if (pid === undefined) return { kind: "reject", code: "INVALID_FILE_NAME" };
	if (pid === scan.ownPid) return { kind: "self" };
	try {
		const value = await readRegistryFile(path.join(scan.sessionsDir, entryName), scan.limits.maxRegistryBytes);
		if (isObject(value) && value.pid !== pid) return { kind: "reject", code: "PID_MISMATCH" };
		const record = parseRegistryRecord(value, pid);
		if (record === undefined) return { kind: "reject", code: "REGISTRY_INVALID_SCHEMA" };
		const state = await processState(pid, scan.expectedUid, record.procStart, scan.platform);
		if (state === "missing") return { kind: "reject", code: "PID_NOT_LIVE" };
		if (state === "foreign") return { kind: "reject", code: "PID_OWNER_MISMATCH" };
		const socketPath = socketPathForRecord(record, scan.socketDir);
		if (socketPath === undefined) return { kind: "reject", code: "SOCKET_OUTSIDE_ROOT" };
		try {
			await validatePeerSocket(socketPath);
		} catch {
			return { kind: "unreachable" };
		}
		return { kind: "peer", pid, record, socketPath };
	} catch (error) {
		const code =
			error instanceof PeerError && (PEER_REJECTION_CODES as readonly string[]).includes(error.code)
				? (error.code as PeerRejectionCode)
				: "REGISTRY_NOT_REGULAR";
		return { kind: "reject", code };
	}
}

export interface PeerDiscovery {
	peers: DiscoveredPeer[];
	registryMissing: boolean;
	unreachable: number;
	rejected: Partial<Record<PeerRejectionCode, number>>;
	entriesScanned: number;
}

export async function discoverClaudePeers(options: {
	sessionsDir: string;
	socketDir: string;
	expectedUid: number;
	ownPid: number;
	platform?: NodeJS.Platform;
	limits?: Partial<PeerLimits>;
}): Promise<PeerDiscovery> {
	const limits = { ...DEFAULT_PEER_LIMITS, ...options.limits };
	const scan: RegistryScan = {
		sessionsDir: options.sessionsDir,
		socketDir: options.socketDir,
		expectedUid: options.expectedUid,
		ownPid: options.ownPid,
		platform: options.platform ?? process.platform,
		limits,
	};
	try {
		await attestPeerDirectory(options.sessionsDir, options.expectedUid);
	} catch (error) {
		if (error instanceof PeerError && error.errnoCode === "ENOENT") {
			return { peers: [], registryMissing: true, unreachable: 0, rejected: {}, entriesScanned: 0 };
		}
		throw error;
	}
	const rejected: Partial<Record<PeerRejectionCode, number>> = {};
	const reject = (code: PeerRejectionCode): void => {
		rejected[code] = (rejected[code] ?? 0) + 1;
	};
	const entries: Dirent[] = [];
	const directory = await opendir(options.sessionsDir);
	for await (const entry of directory) {
		if (entries.length >= limits.maxRegistryEntries) {
			reject("ENTRY_LIMIT_EXCEEDED");
			break;
		}
		entries.push(entry);
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	const peers: DiscoveredPeer[] = [];
	let unreachable = 0;
	for (const entry of entries) {
		const outcome = await examineRegistryEntry(scan, entry.name);
		if (outcome.kind === "self") continue;
		if (outcome.kind === "unreachable") {
			unreachable += 1;
			continue;
		}
		if (outcome.kind === "reject") {
			reject(outcome.code);
			continue;
		}
		peers.push({
			name: outcome.record.name,
			ref: outcome.record.sessionId.slice(-4),
			kind: outcome.record.kind,
			status: outcome.record.status,
			cwd: outcome.record.cwd,
		});
	}
	peers.sort((left, right) => left.name.localeCompare(right.name));
	return { peers, registryMissing: false, unreachable, rejected, entriesScanned: entries.length };
}

export type SendToPeerResult =
	| { ok: true; messageId: string }
	| { ok: false; code: PeerRejectionCode; message: string };

/** Splits a `name [ref]` address into its name and optional disambiguator. */
function parsePeerAddress(to: string): { name: string; ref?: string } {
	const match = /^(.+?)\s+\[([A-Za-z0-9]{1,16})\]$/.exec(to.trim());
	if (match === null) return { name: to.trim() };
	return { name: (match[1] ?? to).trim(), ref: match[2] };
}

async function resolvePeerBinding(
	scan: RegistryScan,
	name: string,
	ref?: string,
): Promise<{ ok: true; pid: number; socketPath: string } | { ok: false; code: PeerRejectionCode; message: string }> {
	try {
		await attestPeerDirectory(scan.sessionsDir, scan.expectedUid);
	} catch (error) {
		if (error instanceof PeerError && error.errnoCode === "ENOENT") {
			return {
				ok: false,
				code: "PEER_NOT_FOUND",
				message: "The Claude sessions registry does not exist on this machine.",
			};
		}
		throw error;
	}
	const matches: Array<{ pid: number; socketPath: string; ref: string; cwd: string }> = [];
	const directory = await opendir(scan.sessionsDir);
	let scanned = 0;
	for await (const entry of directory) {
		scanned += 1;
		if (scanned > scan.limits.maxRegistryEntries) break;
		const outcome = await examineRegistryEntry(scan, entry.name);
		if (outcome.kind !== "peer" || outcome.record.name !== name) continue;
		if (ref !== undefined && outcome.record.sessionId.slice(-4) !== ref) continue;
		matches.push({
			pid: outcome.pid,
			socketPath: outcome.socketPath,
			ref: outcome.record.sessionId.slice(-4),
			cwd: outcome.record.cwd,
		});
	}
	if (matches.length === 0) {
		return {
			ok: false,
			code: "PEER_NOT_FOUND",
			message:
				ref === undefined
					? `No reachable Claude Code session named "${name}". Run ListAgents for the current names.`
					: `No reachable Claude Code session named "${name} [${ref}]". Run ListAgents for the current names.`,
		};
	}
	if (matches.length > 1) {
		const rows = matches.map((match) => `"${name} [${match.ref}]" (${match.cwd})`).join(", ");
		return {
			ok: false,
			code: "PEER_NAME_AMBIGUOUS",
			message: `Several live Claude Code sessions share the name "${name}": ${rows}. Send again with to set to one exact row's name.`,
		};
	}
	const match = matches[0];
	if (match === undefined) {
		return { ok: false, code: "PEER_NOT_FOUND", message: `No reachable Claude Code session named "${name}".` };
	}
	return { ok: true, pid: match.pid, socketPath: match.socketPath };
}

export function encodePeerUserFrame(input: {
	messageId: string;
	content: string;
	from?: string;
	maxFrameBytes?: number;
}): Buffer {
	const maxFrameBytes = input.maxFrameBytes ?? DEFAULT_PEER_LIMITS.maxFrameBytes;
	if (!UUID_PATTERN.test(input.messageId)) {
		throw new PeerError("INVALID_PEER_MESSAGE_ID", "The peer message ID must be a UUID.");
	}
	const content = input.content;
	if (
		typeof content !== "string" ||
		content.length === 0 ||
		content.includes("\0") ||
		byteLength(content) > maxFrameBytes
	) {
		throw new PeerError(
			"CONTENT_INVALID",
			"Peer content must be a non-empty bounded UTF-8 string without NUL bytes.",
		);
	}
	if (
		input.from !== undefined &&
		(!input.from.startsWith("uds:") || !path.isAbsolute(input.from.slice(4)) || input.from.includes("\0"))
	) {
		throw new PeerError("INVALID_PEER_REPLY_ADDRESS", "The peer reply address must be an absolute uds address.");
	}
	const frame: Record<string, unknown> = {
		msgV: 1,
		msg_id: input.messageId,
		type: "user",
		message: { role: "user", content },
		priority: "next",
	};
	if (input.from !== undefined) frame.from = input.from;
	const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
	if (encoded.length > maxFrameBytes + 1) {
		throw new PeerError("CONTENT_TOO_LARGE", "The encoded peer frame exceeds the configured limit.");
	}
	return encoded;
}

export function encodePeerStatusFrame(input: {
	messageId: string;
	status: "held" | "denied" | "expired" | "delivered";
	from: string;
	originalMessageId: string;
	reason?: string;
}): Buffer {
	if (!UUID_PATTERN.test(input.messageId) || !UUID_PATTERN.test(input.originalMessageId)) {
		throw new PeerError("INVALID_PEER_MESSAGE_ID", "The peer message IDs must be UUIDs.");
	}
	if (!input.from.startsWith("uds:") || !path.isAbsolute(input.from.slice(4)) || input.from.includes("\0")) {
		throw new PeerError("INVALID_PEER_REPLY_ADDRESS", "The peer reply address must be an absolute uds address.");
	}
	return Buffer.from(
		`${JSON.stringify({
			type: "control",
			action: "peer_message_status",
			status: input.status,
			reason: input.reason ?? input.status,
			from: input.from,
			orig_msg_id: input.originalMessageId,
			msgV: 1,
			msg_id: input.messageId,
		})}\n`,
		"utf8",
	);
}

export type ParsedPeerFrame =
	| { type: "user"; content: string; messageId?: string; fromAddress?: string }
	| {
			type: "control";
			status: "held" | "denied" | "expired" | "delivered";
			fromAddress: string;
			originalMessageId: string;
	  };

export function parsePeerFrame(line: Buffer, maxFrameBytes: number): ParsedPeerFrame {
	if (line.length === 0 || line.length > maxFrameBytes) {
		throw new PeerError("INVALID_PEER_FRAME", "Invalid peer frame size.");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(line);
	} catch {
		throw new PeerError("INVALID_PEER_UTF8", "Invalid peer frame encoding.");
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new PeerError("INVALID_PEER_FRAME", "Invalid peer frame JSON.");
	}
	if (!isObject(value) || typeof value.type !== "string") {
		throw new PeerError("INVALID_PEER_FRAME", "Invalid peer frame shape.");
	}
	if (value.type === "user") {
		if (
			!hasExactKeys(value, ["type", "message"], ["msgV", "msg_id", "priority", "from"]) ||
			!isObject(value.message) ||
			!hasExactKeys(value.message, ["role", "content"]) ||
			value.message.role !== "user"
		) {
			throw new PeerError("INVALID_PEER_FRAME", "Invalid user frame shape.");
		}
		const canonicalFields = [value.msgV, value.msg_id, value.priority];
		const canonicalCount = canonicalFields.filter((field) => field !== undefined).length;
		if (
			canonicalCount !== 0 &&
			(canonicalCount !== 3 ||
				value.msgV !== 1 ||
				typeof value.msg_id !== "string" ||
				!UUID_PATTERN.test(value.msg_id) ||
				value.priority !== "next")
		) {
			throw new PeerError("INVALID_PEER_FRAME", "Invalid canonical user frame fields.");
		}
		if (value.from !== undefined && (!isBoundedString(value.from, 4096) || !value.from.startsWith("uds:"))) {
			throw new PeerError("INVALID_PEER_FRAME", "Invalid reply address.");
		}
		const content = value.message.content;
		if (
			typeof content !== "string" ||
			content.length === 0 ||
			content.includes("\0") ||
			byteLength(content) > maxFrameBytes
		) {
			throw new PeerError("INVALID_PEER_FRAME", "Invalid user frame content.");
		}
		return {
			type: "user",
			content,
			...(typeof value.msg_id === "string" ? { messageId: value.msg_id } : {}),
			...(typeof value.from === "string" ? { fromAddress: value.from } : {}),
		};
	}
	if (value.type === "control") {
		if (
			!hasExactKeys(value, ["type", "action", "status", "reason", "from", "orig_msg_id", "msgV", "msg_id"]) ||
			value.action !== "peer_message_status" ||
			!["held", "denied", "expired", "delivered"].includes(String(value.status)) ||
			!isBoundedString(value.reason, 1024) ||
			!isBoundedString(value.from, 4096) ||
			!value.from.startsWith("uds:") ||
			typeof value.orig_msg_id !== "string" ||
			!UUID_PATTERN.test(value.orig_msg_id) ||
			value.msgV !== 1 ||
			typeof value.msg_id !== "string" ||
			!UUID_PATTERN.test(value.msg_id)
		) {
			throw new PeerError("INVALID_PEER_FRAME", "Invalid peer status frame.");
		}
		return {
			type: "control",
			status: value.status as "held" | "denied" | "expired" | "delivered",
			fromAddress: value.from,
			originalMessageId: value.orig_msg_id,
		};
	}
	throw new PeerError("UNSUPPORTED_PEER_FRAME", "Unsupported peer frame type.");
}

async function writeSocketPayload(
	connect: (socketPath: string) => Socket,
	socketPath: string,
	payload: Buffer,
	timeoutMs: number,
): Promise<void> {
	return await new Promise<void>((resolve, reject) => {
		const socket = connect(socketPath);
		let settled = false;
		let writeStarted = false;
		const timer = setTimeout(
			() => finish(new PeerError("CONNECT_TIMEOUT", "The peer socket write timed out.", true)),
			timeoutMs,
		);
		timer.unref();
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error === undefined) {
				resolve();
			} else if (writeStarted) {
				reject(
					new PeerError(
						"WRITE_AMBIGUOUS",
						"The peer write began but its outcome is ambiguous; do not retry automatically.",
					),
				);
			} else {
				reject(error);
			}
		};
		socket.once("error", finish);
		socket.once("connect", () => {
			writeStarted = true;
			socket.end(payload, () => finish());
		});
	});
}

async function writePeerSocket(
	socketPath: string,
	payload: Buffer,
	limits: PeerLimits,
): Promise<{ ok: true } | { ok: false; code: PeerRejectionCode; message: string }> {
	try {
		await writeSocketPayload(
			(candidate) => net.createConnection({ path: candidate }),
			socketPath,
			payload,
			limits.connectTimeoutMs,
		);
		return { ok: true };
	} catch (error) {
		if (error instanceof PeerError && error.code === "CONNECT_TIMEOUT") {
			return { ok: false, code: "CONNECT_TIMEOUT", message: error.message };
		}
		if (error instanceof PeerError && error.code === "WRITE_AMBIGUOUS") {
			return { ok: false, code: "WRITE_AMBIGUOUS", message: error.message };
		}
		return { ok: false, code: "WRITE_FAILED", message: "The peer socket write failed before any bytes were sent." };
	}
}

export async function sendToNamedPeer(options: {
	sessionsDir: string;
	socketDir: string;
	expectedUid: number;
	ownPid: number;
	name: string;
	content: string;
	fromAddress?: string;
	platform?: NodeJS.Platform;
	limits?: Partial<PeerLimits>;
}): Promise<SendToPeerResult> {
	const limits = { ...DEFAULT_PEER_LIMITS, ...options.limits };
	const { name, ref } = parsePeerAddress(options.name);
	if (!PEER_NAME_PATTERN.test(name)) {
		return { ok: false, code: "PEER_NOT_FOUND", message: `"${options.name}" is not a valid session address.` };
	}
	const messageId = randomUUID();
	let frame: Buffer;
	try {
		frame = encodePeerUserFrame({
			messageId,
			content: options.content,
			...(options.fromAddress === undefined ? {} : { from: options.fromAddress }),
			maxFrameBytes: limits.maxFrameBytes,
		});
	} catch (error) {
		const code =
			error instanceof PeerError && error.code === "CONTENT_TOO_LARGE" ? "CONTENT_TOO_LARGE" : "CONTENT_INVALID";
		return { ok: false, code, message: error instanceof Error ? error.message : "Invalid message content." };
	}
	const scan: RegistryScan = {
		sessionsDir: options.sessionsDir,
		socketDir: options.socketDir,
		expectedUid: options.expectedUid,
		ownPid: options.ownPid,
		platform: options.platform ?? process.platform,
		limits,
	};
	const binding = await resolvePeerBinding(scan, name, ref);
	if (!binding.ok) return binding;
	const write = await writePeerSocket(binding.socketPath, frame, limits);
	if (!write.ok) return write;
	return { ok: true, messageId };
}

export interface InboundPeerMessage {
	content: string;
	messageId?: string;
	fromAddress?: string;
	senderName?: string;
}

export interface InboundPeerStatus {
	status: "held" | "denied" | "expired" | "delivered";
	fromAddress: string;
	originalMessageId: string;
}

/** A small promise-chain mutex serializing registry mutations and teardown. */
class AsyncMutex {
	#tail: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#tail;
		let release = (): void => undefined;
		this.#tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export interface ClaudeInboxOptions {
	sessionsDir: string;
	socketDir: string;
	expectedUid: number;
	name: string;
	nameSource: "derived" | "user";
	cwd: string;
	sessionId: string;
	platform?: NodeJS.Platform;
	onMessage: (message: InboundPeerMessage) => void | Promise<void>;
	onStatus?: (status: InboundPeerStatus) => void | Promise<void>;
	onNotice?: (code: string) => void;
	limits?: Partial<PeerLimits>;
	now?: () => number;
}

interface AdvertisedRecord {
	piAdvertisementVersion: typeof PI_ADVERTISEMENT_VERSION;
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
	procStart: number;
	version: string;
	peerProtocol: typeof CLAUDE_PEER_PROTOCOL;
	kind: "interactive";
	entrypoint: "cli";
	name: string;
	nameSource: "derived" | "user";
	status: PeerStatus;
	updatedAt: number;
	statusUpdatedAt: number;
	messagingSocketPath: string;
}

/**
 * One process-owned inbox: a Unix-domain socket at `<socketDir>/<pid>.sock`
 * plus one exact-owned registry record at `<sessionsDir>/<pid>.json`.
 * Claude Code's native ListAgents reads the record; its SendMessage writes
 * peer frames to the socket.
 */
export class ClaudeInbox {
	readonly address: string;
	readonly options: ClaudeInboxOptions;
	readonly limits: PeerLimits;
	readonly server: Server;
	readonly socketPath: string;
	readonly platform: NodeJS.Platform;
	readonly now: () => number;
	readonly connections = new Set<Socket>();
	readonly registryMutex = new AsyncMutex();
	socketGeneration: { dev: number; ino: number } | undefined;
	lastWritten: string | undefined;
	lastRecord: AdvertisedRecord | undefined;
	closing = false;
	closed = false;

	private constructor(options: ClaudeInboxOptions, server: Server, socketPath: string, limits: PeerLimits) {
		this.options = options;
		this.server = server;
		this.socketPath = socketPath;
		this.limits = limits;
		this.platform = options.platform ?? process.platform;
		this.now = options.now ?? Date.now;
		this.address = `uds:${socketPath}`;
		server.on("connection", (socket) => this.accept(socket));
		server.on("error", () => undefined);
	}

	static async create(options: ClaudeInboxOptions): Promise<ClaudeInbox> {
		const limits = { ...DEFAULT_PEER_LIMITS, ...options.limits };
		if (!PEER_NAME_PATTERN.test(options.name)) {
			throw new PeerError("INVALID_PEER_NAME", "The advertised peer name is invalid.");
		}
		if (!path.isAbsolute(options.cwd) || options.cwd.includes("\0")) {
			throw new PeerError("INVALID_PEER_CWD", "The advertised peer working directory must be an absolute path.");
		}
		if (!UUID_PATTERN.test(options.sessionId)) {
			throw new PeerError("INVALID_PEER_SESSION_ID", "The advertised peer session ID must be a UUID.");
		}
		await attestPeerDirectory(options.sessionsDir, options.expectedUid);
		await attestPeerDirectory(options.socketDir, options.expectedUid, { create: true });
		const socketPath = conventionalSocketPath(options.socketDir, process.pid);
		try {
			await lstat(socketPath);
			throw new PeerError(
				"CLAUDE_PEER_CALLBACK_EXISTS",
				"The pi peer socket path already exists; it will not be unlinked.",
			);
		} catch (error) {
			if (error instanceof PeerError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new PeerError("CLAUDE_PEER_CALLBACK_EXISTS", "The pi peer socket path could not be inspected.");
			}
		}
		const server = net.createServer();
		const inbox = new ClaudeInbox(options, server, socketPath, limits);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		try {
			const stat = await lstat(socketPath);
			if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== options.expectedUid) {
				throw new PeerError("CLAUDE_PEER_CALLBACK_UNSAFE", "The bound pi peer socket failed its ownership policy.");
			}
			inbox.socketGeneration = { dev: stat.dev, ino: stat.ino };
			await inbox.advertise();
		} catch (error) {
			await inbox.close();
			throw error;
		}
		return inbox;
	}

	registryPath(): string {
		return path.join(this.options.sessionsDir, `${process.pid}.json`);
	}

	async procStartValue(): Promise<number> {
		if (this.platform === "linux") {
			const stat = await readProcFile("/proc/self/stat");
			if (stat !== undefined) {
				const start = statStartTime(stat);
				if (start !== undefined) return start;
			}
		}
		// Fallback for platforms without /proc: epoch milliseconds of process
		// start. Claude Code's own records carry its platform-specific value;
		// this field is best-effort diagnostics for our advertisement.
		return this.now() - Math.floor(process.uptime() * 1000);
	}

	serialize(record: AdvertisedRecord): string {
		return `${JSON.stringify(record)}\n`;
	}

	async readOwnRegistryFile(): Promise<string | undefined> {
		const registryPath = this.registryPath();
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(registryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				stat.uid !== this.options.expectedUid ||
				exactMode(stat.mode) !== 0o600 ||
				stat.size > this.limits.maxRegistryBytes
			) {
				return undefined;
			}
			const serialized = await handle.readFile({ encoding: "utf8" });
			return byteLength(serialized) > this.limits.maxRegistryBytes ? undefined : serialized;
		} finally {
			await handle.close();
		}
	}

	async advertise(): Promise<void> {
		const now = this.now();
		const record: AdvertisedRecord = {
			piAdvertisementVersion: PI_ADVERTISEMENT_VERSION,
			pid: process.pid,
			sessionId: this.options.sessionId,
			cwd: this.options.cwd,
			startedAt: now,
			procStart: await this.procStartValue(),
			version: "pi",
			peerProtocol: CLAUDE_PEER_PROTOCOL,
			kind: "interactive",
			entrypoint: "cli",
			name: this.options.name,
			nameSource: this.options.nameSource,
			status: "idle",
			updatedAt: now,
			statusUpdatedAt: now,
			messagingSocketPath: this.socketPath,
		};
		const serialized = this.serialize(record);
		try {
			await writeFile(this.registryPath(), serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new PeerError(
					"CLAUDE_PEER_CALLBACK_EXISTS",
					"The pi peer registry record already exists; it will not be overwritten.",
				);
			}
			throw error;
		}
		this.lastWritten = serialized;
		if ((await this.readOwnRegistryFile()) !== serialized) {
			throw new PeerError("REGISTRY_RACED", "The advertised peer registry record could not be exactly confirmed.");
		}
		this.lastRecord = record;
	}

	async rewrite(patch: { status?: PeerStatus; name?: string; nameSource?: "derived" | "user" }): Promise<void> {
		return await this.registryMutex.run(async () => {
			// A close in progress owns the record path now; never resurrect it.
			if (this.closing || this.closed || this.lastRecord === undefined || this.lastWritten === undefined) return;
			if (patch.name !== undefined && !PEER_NAME_PATTERN.test(patch.name)) {
				throw new PeerError("INVALID_PEER_NAME", "The advertised peer name is invalid.");
			}
			const registryPath = this.registryPath();
			if ((await this.readOwnRegistryFile()) !== this.lastWritten) {
				// Someone else owns the path now; abandon it rather than clobber.
				this.lastRecord = undefined;
				this.lastWritten = undefined;
				await this.options.onNotice?.("REGISTRY_RACED");
				return;
			}
			const now = this.now();
			const record: AdvertisedRecord = {
				...this.lastRecord,
				...(patch.status === undefined ? {} : { status: patch.status }),
				...(patch.name === undefined ? {} : { name: patch.name }),
				...(patch.nameSource === undefined ? {} : { nameSource: patch.nameSource }),
				updatedAt: now,
				statusUpdatedAt: now,
			};
			const serialized = this.serialize(record);
			const temporaryPath = path.join(
				this.options.sessionsDir,
				`.pi-peer-${process.pid}-${randomUUID().slice(0, 8)}.tmp`,
			);
			await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
			try {
				// A close in progress owns the record path now. Keep the tracked
				// state intact so close's exact-ownership unlink still matches.
				if (this.closing || this.closed) return;
				if ((await this.readOwnRegistryFile()) !== this.lastWritten) {
					this.lastRecord = undefined;
					this.lastWritten = undefined;
					await this.options.onNotice?.("REGISTRY_RACED");
					return;
				}
				await rename(temporaryPath, registryPath);
				if ((await this.readOwnRegistryFile()) !== serialized) {
					this.lastRecord = undefined;
					this.lastWritten = undefined;
					await this.options.onNotice?.("REGISTRY_RACED");
					return;
				}
				this.lastRecord = record;
				this.lastWritten = serialized;
			} finally {
				await unlink(temporaryPath).catch(() => undefined);
			}
		});
	}

	async updateStatus(status: PeerStatus): Promise<void> {
		if (this.lastRecord?.status === status) return;
		await this.rewrite({ status });
	}

	async rename(name: string, nameSource: "derived" | "user" = "user"): Promise<void> {
		if (this.lastRecord?.name === name && this.lastRecord.nameSource === nameSource) return;
		await this.rewrite({ name, nameSource });
	}

	/** Resolves a `uds:` reply address to the owning session's registry name. */
	async resolveSenderName(address: string): Promise<string | undefined> {
		if (!address.startsWith("uds:")) return undefined;
		const socketPath = address.slice(4);
		const candidates = new Set(socketDirCandidates(this.options.socketDir));
		if (!candidates.has(path.dirname(socketPath))) return undefined;
		const match = SOCKET_FILE_PATTERN.exec(path.basename(socketPath));
		const pid = match === null ? undefined : parsePositiveInteger(match[1] ?? "");
		if (pid === undefined || pid === process.pid) return undefined;
		try {
			const value = await readRegistryFile(
				path.join(this.options.sessionsDir, `${pid}.json`),
				this.limits.maxRegistryBytes,
			);
			const record = parseRegistryRecord(value, pid);
			return record?.name;
		} catch {
			return undefined;
		}
	}

	/** Writes one native peer_message_status control frame to a sender. */
	async ack(
		fromAddress: string,
		originalMessageId: string,
		status: "held" | "denied" | "expired" | "delivered",
	): Promise<void> {
		if (this.closed) return;
		if (!fromAddress.startsWith("uds:")) {
			throw new PeerError("UNREGISTERED_REPLY_ADDRESS", "Only local UDS reply addresses are accepted.");
		}
		const socketPath = fromAddress.slice(4);
		const candidates = new Set(socketDirCandidates(this.options.socketDir));
		if (!candidates.has(path.dirname(socketPath))) {
			throw new PeerError("UNREGISTERED_REPLY_ADDRESS", "The reply address is outside the trusted socket root.");
		}
		const match = SOCKET_FILE_PATTERN.exec(path.basename(socketPath));
		const pid = match === null ? undefined : parsePositiveInteger(match[1] ?? "");
		if (pid === undefined || pid === process.pid) {
			throw new PeerError("UNREGISTERED_REPLY_ADDRESS", "The reply address is not a registered peer socket.");
		}
		await validatePeerSocket(socketPath);
		const payload = encodePeerStatusFrame({
			messageId: randomUUID(),
			status,
			from: this.address,
			originalMessageId,
		});
		const write = await writePeerSocket(socketPath, payload, this.limits);
		if (!write.ok) {
			throw new PeerError(
				write.code,
				write.message,
				write.code === "CONNECT_TIMEOUT" || write.code === "WRITE_FAILED",
			);
		}
	}

	accept(socket: Socket): void {
		if (this.closed || this.connections.size >= this.limits.maxConnections) {
			socket.destroy();
			void this.options.onNotice?.("CONNECTION_LIMIT");
			return;
		}
		this.connections.add(socket);
		socket.setTimeout(this.limits.connectionIdleMs);
		let buffered = Buffer.alloc(0);
		let frames = 0;
		let rejected = false;
		let chain: Promise<void> = Promise.resolve();
		const reject = (code: string): void => {
			if (rejected) return;
			rejected = true;
			socket.destroy();
			void this.options.onNotice?.(code);
		};
		socket.on("timeout", () => reject("CONNECTION_TIMEOUT"));
		socket.on("error", () => undefined);
		socket.on("close", () => this.connections.delete(socket));
		socket.on("data", (chunk: Buffer) => {
			if (rejected) return;
			buffered = Buffer.concat([buffered, chunk]);
			if (buffered.length > this.limits.maxFrameBytes + 1) {
				const newline = buffered.indexOf(0x0a);
				if (newline < 0 || newline > this.limits.maxFrameBytes) {
					reject("FRAME_TOO_LARGE");
					return;
				}
			}
			while (!rejected) {
				const newline = buffered.indexOf(0x0a);
				if (newline < 0) break;
				if (newline > this.limits.maxFrameBytes) {
					reject("FRAME_TOO_LARGE");
					break;
				}
				const line = buffered.subarray(0, newline);
				buffered = buffered.subarray(newline + 1);
				frames += 1;
				if (frames > this.limits.maxFramesPerConnection) {
					reject("INVALID_FRAME");
					break;
				}
				let frame: ParsedPeerFrame;
				try {
					frame = parsePeerFrame(line, this.limits.maxFrameBytes);
				} catch (error) {
					const code =
						error instanceof PeerError && error.code === "INVALID_PEER_UTF8"
							? "INVALID_UTF8"
							: error instanceof PeerError && error.code === "UNSUPPORTED_PEER_FRAME"
								? "UNSUPPORTED_FRAME"
								: "INVALID_FRAME";
					reject(code);
					break;
				}
				chain = chain.then(async () => {
					if (rejected) return;
					try {
						await this.handleFrame(frame);
					} catch {
						reject("CALLBACK_ERROR");
					}
				});
			}
			if (!rejected && buffered.length > this.limits.maxFrameBytes) {
				reject("FRAME_TOO_LARGE");
			}
		});
		socket.on("end", () => {
			if (!rejected && buffered.length !== 0) reject("INVALID_FRAME");
		});
	}

	async handleFrame(frame: ParsedPeerFrame): Promise<void> {
		if (this.closed) return;
		if (frame.type === "control") {
			await this.options.onStatus?.({
				status: frame.status,
				fromAddress: frame.fromAddress,
				originalMessageId: frame.originalMessageId,
			});
			return;
		}
		let senderName: string | undefined;
		if (frame.fromAddress !== undefined) {
			senderName = await this.resolveSenderName(frame.fromAddress);
			if (senderName === undefined) {
				await this.options.onNotice?.("UNREGISTERED_REPLY_ADDRESS");
				return;
			}
		}
		await this.options.onMessage({
			content: frame.content,
			...(frame.messageId === undefined ? {} : { messageId: frame.messageId }),
			...(frame.fromAddress === undefined ? {} : { fromAddress: frame.fromAddress }),
			...(senderName === undefined ? {} : { senderName }),
		});
		if (frame.fromAddress !== undefined && frame.messageId !== undefined) {
			try {
				await this.ack(frame.fromAddress, frame.messageId, "delivered");
			} catch {
				await this.options.onNotice?.("CALLBACK_ERROR");
			}
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closing = true;
		const errors: unknown[] = [];
		// Serialize against in-flight status rewrites so a concurrent rename
		// can never resurrect the record after this unlink.
		await this.registryMutex.run(async () => {
			if (this.lastWritten !== undefined) {
				try {
					if ((await this.readOwnRegistryFile()) === this.lastWritten) {
						await unlink(this.registryPath());
					}
				} catch (error) {
					errors.push(error);
				}
			}
			this.lastRecord = undefined;
			this.lastWritten = undefined;
		});
		for (const socket of this.connections) socket.destroy();
		this.connections.clear();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		try {
			const stat = await lstat(this.socketPath);
			if (
				this.socketGeneration !== undefined &&
				stat.isSocket() &&
				stat.dev === this.socketGeneration.dev &&
				stat.ino === this.socketGeneration.ino
			) {
				await unlink(this.socketPath);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
		}
		this.closing = false;
		this.closed = true;
		if (errors.length > 0) {
			throw new AggregateError(errors, "The pi peer inbox closed with cleanup failures.");
		}
	}
}
