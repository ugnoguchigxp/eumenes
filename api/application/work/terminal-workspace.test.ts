import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readWorkspaceGuard,
	reserveWorkspaceInTransaction,
} from "../../domains/kanban";
import {
	createTerminals,
	registerTerminals,
	type SpawnPty,
} from "../../domains/terminals";
import { openStore } from "../../infrastructure/sqlite";
import { createApp } from "../app";
import { migrations } from "../migrations";
import { createTerminalWorkspacePort } from "./terminal-workspace";

const workspaceRef = "eumenes";
const hostBootedAt = Date.parse("2026-11-17T10:00:00Z");
const token = "fixture-terminal-workspace";
const size = { cols: 80, rows: 24 };
const request = {
	owner: "direct",
	target: "new",
	mode: "work",
	projectId: workspaceRef,
	prompt: "fixture prompt",
	task: "fixture task",
	origin: "conversation",
	conversationId: "main",
} as const;

function fixture(spawn: SpawnPty, stopConfirmMs = 100) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-terminal-workspace-"));
	const store = openStore(join(dir, "db"), migrations);
	const terminals = createTerminals({
		store,
		cwd: dir,
		command: ["fixture-claude"],
		spawn,
		stopConfirmMs,
		killAfterMs: stopConfirmMs / 2,
		hookBaseUrl: "http://127.0.0.1:8787",
		curl: "curl",
		workspace: createTerminalWorkspacePort({
			store,
			workspaceRef: () => workspaceRef,
			executorId: "claude-code",
			hostBootedAtMs: hostBootedAt,
		}),
	});
	const app = createApp({
		token,
		origin: "http://localhost",
		modules: [{ mount: (app) => registerTerminals(app, terminals) }],
	});
	return {
		terminals,
		store,
		guard: () =>
			store.readSnapshot((tx) => readWorkspaceGuard(tx, workspaceRef)),
		start: () =>
			app.request("/api/terminals", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(size),
			}),
		async close() {
			await terminals.closeAll();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function fakeSpawn(confirmStop = true): ReturnType<SpawnPty> {
	const { promise, resolve } = Promise.withResolvers<number | null>();
	return {
		exited: promise,
		write() {},
		resize() {},
		close() {},
		kill() {
			if (confirmStop) resolve(0);
		},
	};
}

test.each(["held", "unknown"] as const)(
	"starting Claude Code reports a workspace conflict in state %s",
	async (state) => {
		const h = fixture(() => {
			throw new Error("unexpected_launch");
		});
		const guard = {
			workspaceRef,
			ownerRef: "kanban:fixture",
			executorId: "codex",
			epoch: "fixture",
			state,
		} as const;
		try {
			await h.store.write((tx) => reserveWorkspaceInTransaction(tx, guard));
			const response = await h.start();
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: "terminal_workspace_busy",
			});
			expect(h.guard()).toEqual(guard);
		} finally {
			await h.close();
		}
	},
);

const priorBootActivity = "2026-11-15T13:00:00.000Z";
const currentBootActivity = "2026-11-17T11:00:00.000Z";
const previousTerminal = "direct:previous-session";

test.each([
	[
		"a direct terminal from before the host reboot",
		previousTerminal,
		"held",
		priorBootActivity,
		201,
		"completed",
	],
	[
		"a direct terminal with an unfinished request from before the host reboot",
		previousTerminal,
		"held",
		priorBootActivity,
		201,
		"started",
	],
	[
		"a direct terminal from the current host boot",
		previousTerminal,
		"held",
		currentBootActivity,
		409,
		"completed",
	],
	[
		"a direct terminal with no saved evidence",
		previousTerminal,
		"held",
		null,
		409,
		"completed",
	],
	[
		"a direct terminal whose reservation is unknown",
		previousTerminal,
		"unknown",
		priorBootActivity,
		409,
		"completed",
	],
	[
		"a Kanban terminal reservation",
		"kanban:fixture",
		"held",
		priorBootActivity,
		409,
		"completed",
	],
] as const)(
	"startup handles %s",
	async (
		_case,
		ownerRef,
		state,
		lastActivity,
		expectedStatus,
		requestState,
	) => {
		const h = fixture(() => fakeSpawn());
		const guard = {
			workspaceRef,
			ownerRef,
			executorId: "claude-code",
			epoch: "previous-epoch",
			state,
		};
		try {
			await h.store.write((tx) => {
				reserveWorkspaceInTransaction(tx, guard);
				if (!lastActivity) return;
				const attemptId = crypto.randomUUID();
				h.terminals.enqueueInTransaction(tx, { ...request, attemptId });
				tx.query(
					"UPDATE terminal_requests SET terminal_session_id=?, state=?, updated_at=? WHERE id=?",
				).run("previous-session", requestState, lastActivity, attemptId);
			});
			await h.terminals.recover();
			expect(h.guard()).toEqual(expectedStatus === 201 ? null : guard);
			expect((await h.start()).status).toBe(expectedStatus);
		} finally {
			await h.close();
		}
	},
);

test("a failed Claude Code launch leaves the workspace available for another start", async () => {
	let attempts = 0;
	const h = fixture(() => {
		if (++attempts === 1) throw new Error("fixture_spawn_failed");
		return fakeSpawn();
	});
	try {
		expect((await h.start()).status).toBe(500);
		expect(h.terminals.list().sessions).toEqual([]);
		expect(h.guard()).toBeNull();
		expect((await h.start()).status).toBe(201);
		expect(attempts).toBe(2);
	} finally {
		await h.close();
	}
});

test("a failed launch for a conversation request leaves the next request able to start", async () => {
	let attempts = 0;
	const h = fixture(() => {
		if (++attempts === 1) throw new Error("fixture_spawn_failed");
		return fakeSpawn();
	});
	async function enqueue() {
		const attemptId = crypto.randomUUID();
		await h.store.write((tx) =>
			h.terminals.enqueueInTransaction(tx, { ...request, attemptId }),
		);
		await h.terminals.settled();
		return h.store.read((tx) =>
			h.terminals.requestInTransaction(tx, attemptId),
		);
	}
	try {
		await h.terminals.recover();
		expect(await enqueue()).toMatchObject({
			state: "cancelled",
			reason: "send_failed",
		});
		expect(h.guard()).toBeNull();
		expect(await enqueue()).toMatchObject({ state: "delivered" });
		expect(attempts).toBe(2);
	} finally {
		await h.close();
	}
});

test("a queued request cancelled before dispatch leaves no workspace reservation", async () => {
	const h = fixture(() => {
		throw new Error("unexpected_launch");
	});
	try {
		await h.terminals.recover();
		const attemptId = crypto.randomUUID();
		const enqueue = h.store.write((tx) =>
			h.terminals.enqueueInTransaction(tx, { ...request, attemptId }),
		);
		const cancel = h.store.write((tx) =>
			h.terminals.cancelQueuedInTransaction(tx, attemptId),
		);
		await enqueue;
		expect(await cancel).toBe(true);
		await h.terminals.settled();
		expect(h.guard()).toBeNull();
	} finally {
		await h.close();
	}
});

test("a rejected restart preserves the reservation of a running terminal", async () => {
	const h = fixture(() => fakeSpawn());
	try {
		expect((await h.start()).status).toBe(201);
		const [current] = h.terminals.list().sessions;
		const guard = h.guard();
		await expect(h.terminals.restartGuarded(current!.id, size)).rejects.toThrow(
			"terminal_running",
		);
		expect(h.guard()).toEqual(guard);
	} finally {
		await h.close();
	}
});

test("a direct Claude Code exit releases the workspace before the next terminal starts", async () => {
	const pty = fakeSpawn();
	let launches = 0;
	const h = fixture(() => (launches++ === 0 ? pty : fakeSpawn()));
	try {
		const started = await h.start();
		expect(started.status).toBe(201);
		pty.kill();
		await pty.exited;
		expect((await h.start()).status).toBe(201);
		expect(launches).toBe(2);
	} finally {
		await h.close();
	}
});

test("closing the terminal service releases a direct reservation after confirmed exit", async () => {
	const h = fixture(() => fakeSpawn());
	try {
		expect((await h.start()).status).toBe(201);
		expect(h.guard()?.state).toBe("held");
		await h.terminals.closeAll();
		expect(h.guard()).toBeNull();
	} finally {
		await h.close();
	}
});

test("closing the terminal service retains a direct reservation when exit is unconfirmed", async () => {
	const h = fixture(() => fakeSpawn(false));
	try {
		expect((await h.start()).status).toBe(201);
		const guard = h.guard();
		expect(guard?.state).toBe("held");
		await h.terminals.closeAll();
		expect(h.guard()).toEqual(guard);
	} finally {
		await h.close();
	}
});
