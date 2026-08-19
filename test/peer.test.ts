import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ClaudeInbox,
	discoverClaudePeers,
	encodePeerStatusFrame,
	encodePeerUserFrame,
	PeerError,
	type PeerLimits,
	parsePeerFrame,
	sendToNamedPeer,
} from "../peer.ts";

/**
 * Functional tests for the Claude Code peer protocol adapter. Everything runs
 * against test-owned temporary directories and fake sockets; the tests never
 * touch the real ~/.claude/sessions registry, /tmp/cc-socks, or a live peer.
 */

const LIMITS: Partial<PeerLimits> = { maxFrameBytes: 64 * 1024 };

function makeDirs(): { root: string; sessionsDir: string; socketDir: string } {
	const root = join(tmpdir(), `pi-claude-peer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionsDir = join(root, "sessions");
	const socketDir = join(root, "socks");
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	chmodSync(sessionsDir, 0o700);
	chmodSync(socketDir, 0o700);
	return { root, sessionsDir, socketDir };
}

/** Spawns a live child process owned by the test user, for fake peer PIDs. */
function spawnChild(): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		child.once("spawn", () => resolve(child));
		child.once("error", reject);
	});
}

/** Reads /proc/<pid>/stat starttime ticks, mirroring the adapter's own logic. */
function procStartOf(pid: number): number | string {
	if (process.platform !== "linux") return "0";
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const closing = stat.lastIndexOf(")");
	const ticks = Number(stat.slice(closing + 2).split(" ")[19]);
	return Number.isSafeInteger(ticks) ? ticks : 0;
}

function writeRegistryRecord(sessionsDir: string, pid: number, patch: Record<string, unknown>): void {
	const record: Record<string, unknown> = {
		pid,
		sessionId: randomUUID(),
		cwd: "/home/fake/project",
		startedAt: Date.now(),
		version: "2.1.228",
		peerProtocol: 1,
		kind: "interactive",
		entrypoint: "cli",
		name: "fake-peer",
		nameSource: "derived",
		status: "idle",
		updatedAt: Date.now(),
		statusUpdatedAt: Date.now(),
		...patch,
	};
	if (record.procStart === undefined) {
		record.procStart = process.platform === "linux" ? procStartOf(pid) : "0";
	}
	writeFileSync(join(sessionsDir, `${pid}.json`), `${JSON.stringify(record)}\n`);
}

function bindSocket(socketDir: string, pid: number): Promise<{ server: Server; path: string }> {
	return new Promise((resolve, reject) => {
		const socketPath = join(socketDir, `${pid}.sock`);
		const server = net.createServer(() => undefined);
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve({ server, path: socketPath });
		});
	});
}

/** Collects newline-delimited frames written to a socket until a predicate matches. */
function captureFrames(
	server: Server,
	done: (frame: Record<string, unknown>) => boolean,
	timeoutMs = 5000,
): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const frames: Record<string, unknown>[] = [];
		let buffered = "";
		const timer = setTimeout(() => {
			server.removeListener("connection", onConnection);
			reject(new Error("timed out waiting for socket frames"));
		}, timeoutMs);
		const onConnection = (socket: Socket): void => {
			socket.on("data", (chunk: Buffer) => {
				buffered += chunk.toString("utf8");
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					frames.push(JSON.parse(line) as Record<string, unknown>);
					if (frames.some(done)) {
						clearTimeout(timer);
						server.removeListener("connection", onConnection);
						resolve(frames);
						return;
					}
					newline = buffered.indexOf("\n");
				}
			});
		};
		server.on("connection", onConnection);
	});
}

const children: ChildProcess[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const server of servers) server.close();
	servers.length = 0;
	for (const child of children) child.kill("SIGKILL");
	children.length = 0;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

describe("peer frame encoding and parsing", () => {
	it("round-trips a canonical user frame", () => {
		const frame = encodePeerUserFrame({
			messageId: "11111111-2222-4333-8444-555555555555",
			content: "hello from pi",
			from: "uds:/tmp/cc-socks/123.sock",
			maxFrameBytes: LIMITS.maxFrameBytes,
		});
		const parsed = parsePeerFrame(frame.subarray(0, frame.length - 1), LIMITS.maxFrameBytes ?? 64 * 1024);
		expect(parsed).toEqual({
			type: "user",
			content: "hello from pi",
			messageId: "11111111-2222-4333-8444-555555555555",
			fromAddress: "uds:/tmp/cc-socks/123.sock",
		});
	});

	it("rejects oversized, NUL-bearing, and non-user frames", () => {
		expect(() => encodePeerUserFrame({ messageId: randomUUID(), content: "a\0b", maxFrameBytes: 64 })).toThrow(
			PeerError,
		);
		expect(() => parsePeerFrame(Buffer.from(`${JSON.stringify({ type: "agent" })}\n`), 64 * 1024)).toThrow(PeerError);
		expect(() =>
			parsePeerFrame(
				Buffer.from(`${JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(100) } })}\n`),
				64,
			),
		).toThrow(PeerError);
	});

	it("parses a native peer_message_status control frame", () => {
		const frame = encodePeerStatusFrame({
			messageId: randomUUID(),
			status: "delivered",
			from: "uds:/tmp/cc-socks/1.sock",
			originalMessageId: "11111111-2222-4333-8444-555555555555",
		});
		const parsed = parsePeerFrame(frame.subarray(0, frame.length - 1), 64 * 1024);
		expect(parsed).toEqual({
			type: "control",
			status: "delivered",
			fromAddress: "uds:/tmp/cc-socks/1.sock",
			originalMessageId: "11111111-2222-4333-8444-555555555555",
		});
	});
});

describe("discovery", () => {
	it("reports a missing registry without failing", async () => {
		const { root } = makeDirs();
		const discovery = await discoverClaudePeers({
			sessionsDir: join(root, "no-such-sessions"),
			socketDir: join(root, "no-such-socks"),
			expectedUid: process.getuid?.() ?? 0,
			ownPid: process.pid,
			limits: LIMITS,
		});
		expect(discovery.registryMissing).toBe(true);
		expect(discovery.peers).toEqual([]);
	});

	it("discovers live same-user sessions and counts the rest loudly", async () => {
		const { sessionsDir, socketDir } = makeDirs();
		tempDirs.push(join(sessionsDir, ".."));
		const reachable = await spawnChild();
		const socketless = await spawnChild();
		const dead = await spawnChild();
		children.push(reachable, socketless, dead);
		writeRegistryRecord(sessionsDir, dead.pid ?? 0, { name: "dead-peer" });
		await new Promise((resolve) => {
			dead.once("exit", resolve);
			dead.kill("SIGKILL");
		});

		writeRegistryRecord(sessionsDir, reachable.pid ?? 0, {
			name: "reachable-peer",
			messagingSocketPath: join(socketDir, `${reachable.pid}.sock`),
		});
		writeRegistryRecord(sessionsDir, socketless.pid ?? 0, {
			name: "socketless-peer",
			messagingSocketPath: join(socketDir, `${socketless.pid}.sock`),
		});
		writeRegistryRecord(sessionsDir, 4_000_000, { name: "wrong-protocol", peerProtocol: 2, procStart: "0" });
		// Need a live pid for the protocol-2 record; reuse the reachable child
		// via a second file name is impossible, so write it under a bogus pid
		// and accept the schema rejection path.
		const { server } = await bindSocket(socketDir, reachable.pid ?? 0);
		servers.push(server);

		const discovery = await discoverClaudePeers({
			sessionsDir,
			socketDir,
			expectedUid: process.getuid?.() ?? 0,
			ownPid: process.pid,
			limits: LIMITS,
		});
		expect(discovery.registryMissing).toBe(false);
		expect(discovery.peers[0]).toMatchObject({
			name: "reachable-peer",
			kind: "interactive",
			status: "idle",
			cwd: "/home/fake/project",
		});
		expect(discovery.peers[0]?.ref).toMatch(/^[0-9a-f]{4}$/);
		expect(discovery.unreachable).toBe(1);
		expect(discovery.rejected.PID_NOT_LIVE).toBeGreaterThanOrEqual(1);
		expect(discovery.rejected.REGISTRY_INVALID_SCHEMA).toBeGreaterThanOrEqual(1);
	});
});

describe("sendToNamedPeer", () => {
	it("writes a canonical frame to the named session's inbox socket", async () => {
		const { sessionsDir, socketDir } = makeDirs();
		tempDirs.push(join(sessionsDir, ".."));
		const child = await spawnChild();
		children.push(child);
		const pid = child.pid ?? 0;
		writeRegistryRecord(sessionsDir, pid, {
			name: "fake-peer",
			messagingSocketPath: join(socketDir, `${pid}.sock`),
		});
		const { server } = await bindSocket(socketDir, pid);
		servers.push(server);
		const captured = captureFrames(server, (frame) => frame.type === "user");

		const result = await sendToNamedPeer({
			sessionsDir,
			socketDir,
			expectedUid: process.getuid?.() ?? 0,
			ownPid: process.pid,
			name: "fake-peer",
			content: "please review this diff",
			fromAddress: `uds:${join(socketDir, `${process.pid}.sock`)}`,
			limits: LIMITS,
		});
		expect(result.ok).toBe(true);
		const frames = await captured;
		expect(frames[0]).toMatchObject({
			type: "user",
			message: { role: "user", content: "please review this diff" },
			priority: "next",
			from: `uds:${join(socketDir, `${process.pid}.sock`)}`,
		});
	});

	it("fails closed for unknown and ambiguous names", async () => {
		const { sessionsDir, socketDir } = makeDirs();
		tempDirs.push(join(sessionsDir, ".."));
		const first = await spawnChild();
		const second = await spawnChild();
		children.push(first, second);
		const firstPid = first.pid ?? 0;
		const secondPid = second.pid ?? 0;
		writeRegistryRecord(sessionsDir, firstPid, {
			name: "dup-peer",
			messagingSocketPath: join(socketDir, `${firstPid}.sock`),
		});
		writeRegistryRecord(sessionsDir, secondPid, {
			name: "dup-peer",
			messagingSocketPath: join(socketDir, `${secondPid}.sock`),
		});
		const firstServer = await bindSocket(socketDir, firstPid);
		const secondServer = await bindSocket(socketDir, secondPid);
		servers.push(firstServer.server, secondServer.server);

		const missing = await sendToNamedPeer({
			sessionsDir,
			socketDir,
			expectedUid: process.getuid?.() ?? 0,
			ownPid: process.pid,
			name: "no-such-session",
			content: "hello",
			limits: LIMITS,
		});
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("PEER_NOT_FOUND");

		const ambiguous = await sendToNamedPeer({
			sessionsDir,
			socketDir,
			expectedUid: process.getuid?.() ?? 0,
			ownPid: process.pid,
			name: "dup-peer",
			content: "hello",
			limits: LIMITS,
		});
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) expect(ambiguous.code).toBe("PEER_NAME_AMBIGUOUS");

		// The ` [ref]` disambiguator from a listing row resolves to one exact session.
		const firstRecord = JSON.parse(readFileSync(join(sessionsDir, `${firstPid}.json`), "utf8")) as {
			sessionId: string;
		};
		const disambiguated = await sendToNamedPeer({
			sessionsDir,
			socketDir,
			expectedUid: process.getuid?.() ?? 0,
			ownPid: process.pid,
			name: `dup-peer [${firstRecord.sessionId.slice(-4)}]`,
			content: "hello again",
			limits: LIMITS,
		});
		expect(disambiguated.ok).toBe(true);
	});
});

describe("ClaudeInbox", () => {
	it("advertises one exact-owned record and socket, updates, renames, and cleans up", async () => {
		const { sessionsDir, socketDir } = makeDirs();
		tempDirs.push(join(sessionsDir, ".."));
		const uid = process.getuid?.() ?? 0;
		const inbox = await ClaudeInbox.create({
			sessionsDir,
			socketDir,
			expectedUid: uid,
			name: "pi-test-abc",
			nameSource: "derived",
			cwd: "/home/fake/pi",
			sessionId: randomUUID(),
			platform: process.platform,
			onMessage: () => undefined,
			limits: LIMITS,
		});

		const recordPath = join(sessionsDir, `${process.pid}.json`);
		expect(existsSync(recordPath)).toBe(true);
		const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
		expect(record.piAdvertisementVersion).toBe(1);
		expect(record.peerProtocol).toBe(1);
		expect(record.name).toBe("pi-test-abc");
		expect(record.kind).toBe("interactive");
		expect(record.messagingSocketPath).toBe(join(socketDir, `${process.pid}.sock`));
		expect(lstatSync(join(socketDir, `${process.pid}.sock`)).isSocket()).toBe(true);

		await inbox.updateStatus("busy");
		expect((JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>).status).toBe("busy");

		await inbox.rename("pi-test-xyz", "user");
		expect((JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>).name).toBe("pi-test-xyz");

		// A second inbox in the same process must refuse to overwrite.
		await expect(
			ClaudeInbox.create({
				sessionsDir,
				socketDir,
				expectedUid: uid,
				name: "pi-second",
				nameSource: "derived",
				cwd: "/home/fake/pi",
				sessionId: randomUUID(),
				platform: process.platform,
				onMessage: () => undefined,
				limits: LIMITS,
			}),
		).rejects.toThrow(PeerError);

		await inbox.close();
		expect(existsSync(recordPath)).toBe(false);
		expect(existsSync(join(socketDir, `${process.pid}.sock`))).toBe(false);

		// After a clean close, the same process may advertise again.
		const again = await ClaudeInbox.create({
			sessionsDir,
			socketDir,
			expectedUid: uid,
			name: "pi-test-abc",
			nameSource: "derived",
			cwd: "/home/fake/pi",
			sessionId: randomUUID(),
			platform: process.platform,
			onMessage: () => undefined,
			limits: LIMITS,
		});
		await again.close();
	});

	it("never leaves the registry record behind when a status update races close", async () => {
		const { sessionsDir, socketDir } = makeDirs();
		tempDirs.push(join(sessionsDir, ".."));
		const uid = process.getuid?.() ?? 0;
		for (let iteration = 0; iteration < 10; iteration++) {
			const inbox = await ClaudeInbox.create({
				sessionsDir,
				socketDir,
				expectedUid: uid,
				name: "pi-race-test",
				nameSource: "derived",
				cwd: "/home/fake/pi",
				sessionId: randomUUID(),
				platform: process.platform,
				onMessage: () => undefined,
				limits: LIMITS,
			});
			await inbox.updateStatus("busy");
			// A turn settling into "idle" at the same moment the session shuts
			// down must not resurrect the record after close removes it.
			const settling = inbox.updateStatus("idle").catch(() => undefined);
			await inbox.close();
			await settling;
			expect(existsSync(join(sessionsDir, `${process.pid}.json`))).toBe(false);
			expect(existsSync(join(socketDir, `${process.pid}.sock`))).toBe(false);
		}
	});

	it("delivers inbound frames and acknowledges with a native status frame", async () => {
		const { sessionsDir, socketDir } = makeDirs();
		tempDirs.push(join(sessionsDir, ".."));
		const uid = process.getuid?.() ?? 0;
		const sender = await spawnChild();
		children.push(sender);
		const senderPid = sender.pid ?? 0;
		writeRegistryRecord(sessionsDir, senderPid, {
			name: "sender-session",
			messagingSocketPath: join(socketDir, `${senderPid}.sock`),
		});
		const senderSocket = await bindSocket(socketDir, senderPid);
		servers.push(senderSocket.server);
		const senderFrames = captureFrames(senderSocket.server, (frame) => frame.type === "control");

		const received: Array<{ content: string; senderName?: string }> = [];
		const inbox = await ClaudeInbox.create({
			sessionsDir,
			socketDir,
			expectedUid: uid,
			name: "pi-inbox-test",
			nameSource: "derived",
			cwd: "/home/fake/pi",
			sessionId: randomUUID(),
			platform: process.platform,
			onMessage: (message) => {
				received.push({ content: message.content, senderName: message.senderName });
			},
			limits: LIMITS,
		});

		const originalMessageId = randomUUID();
		const client = net.createConnection(inbox.socketPath);
		await new Promise<void>((resolve, reject) => {
			client.once("connect", () => {
				client.end(
					encodePeerUserFrame({
						messageId: originalMessageId,
						content: "the migration finished",
						from: `uds:${join(socketDir, `${senderPid}.sock`)}`,
						maxFrameBytes: LIMITS.maxFrameBytes,
					}),
					resolve,
				);
			});
			client.once("error", reject);
		});

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(received).toEqual([{ content: "the migration finished", senderName: "sender-session" }]);

		const frames = await senderFrames;
		expect(frames[0]).toMatchObject({
			type: "control",
			action: "peer_message_status",
			status: "delivered",
			orig_msg_id: originalMessageId,
		});

		await inbox.close();
	});
});
