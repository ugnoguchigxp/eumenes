import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { createShell, registerShell } from "..";
import { APPROVAL_MS } from "../contracts";
import { childEnv } from "../../../infrastructure/pty";
import { waitFor } from "../../../infrastructure/wait-for";
import { createOutput } from "../service/output";
import { fakePty, harness, request } from "./shell.fixture";
const opened: Array<ReturnType<typeof harness>> = [];
const make = (...args: Parameters<typeof harness>) => {
	const h = harness(...args);
	opened.push(h);
	return h;
};
afterEach(async () => {
	for (const h of opened.splice(0)) await h.close();
});

test("commit gate, rollback, replay conflicts, input validation, FIFO and exit codes", async () => {
	const h = make();
	const a = request();
	const b = request({ task: "次の確認" });
	await h.enqueue(a);
	expect(h.pty.spawned).toHaveLength(0);
	await expect(
		h.store.write((db) => {
			h.shell.enqueueRunInTransaction(db, b);
			throw new Error("rollback");
		}),
	).rejects.toThrow("rollback");
	expect(h.view(b.attemptId)).toBeNull();
	await h.shell.recover(); // Startup invalidates pre-existing queued work.
	expect(h.view(a.attemptId)?.state).toBe("cancelled");
	const first = request();
	await h.enqueue(first);
	await waitFor(() => h.pty.spawned.length === 1);
	await h.enqueue(b);
	await Bun.sleep(10);
	expect(h.pty.spawned).toHaveLength(1);
	const replay = await h.enqueue(first);
	expect(replay.state).toBe("running");
	await expect(h.enqueue({ ...first, command: "different" })).rejects.toThrow(
		"shell_run_conflict",
	);
	await expect(h.enqueue(request({ command: "bad\x1b" }))).rejects.toThrow(
		"shell_command_invalid",
	);
	await expect(h.enqueue(request({ projectId: "unknown" }))).rejects.toThrow(
		"shell_project_unknown",
	);
	h.pty.spawned[0]!.data("\x1b[31mfirst\x1b[0m\r\n");
	h.pty.spawned[0]!.exit(7);
	await waitFor(() => h.view(first.attemptId)?.state === "completed");
	expect(h.view(first.attemptId)).toMatchObject({
		exitCode: 7,
		output: "first\n",
	});
	await waitFor(() => h.pty.spawned.length === 2);
	expect(h.pty.spawned[1]!.command).toEqual(["/bin/sh", "-l", "-c", b.command]);
	h.pty.spawned[1]!.exit(0);
	await waitFor(() => h.view(b.attemptId)?.state === "completed");
	expect(h.shell.list().sessions).toHaveLength(1);
});

test("terminal subscribers roll back the final state; after-commit reports fire once", async () => {
	const h = make();
	await h.shell.recover();
	const committed: string[] = [];
	h.shell.onFinishedCommitted((r) => committed.push(r.id));
	let failing = true;
	h.shell.onFinishedInTransaction(() => {
		if (failing) throw new Error("reject");
	});
	const a = request();
	await h.enqueue(a);
	await waitFor(() => h.pty.spawned.length === 1);
	h.pty.spawned[0]!.exit(0);
	await Bun.sleep(20);
	expect(h.view(a.attemptId)?.state).toBe("running");
	expect(committed).toHaveLength(0);
	failing = false;
	await waitFor(() => h.view(a.attemptId)?.state === "completed");
	expect(committed).toEqual([a.attemptId]);
	const cancel = request(); // Block its dispatch by doing cancellation in the same transaction.
	await h.store.write((db) => {
		h.shell.enqueueRunInTransaction(db, cancel);
		h.shell.cancelInTransaction(db, cancel.attemptId);
	});
	expect(h.view(cancel.attemptId)?.state).toBe("cancelled");
	expect(committed).toEqual([a.attemptId, cancel.attemptId]);
});

test("timeout, unconfirmed stop and cancellation never overwrite a terminal result", async () => {
	const h = make();
	await h.shell.recover();
	const a = request({ timeoutSeconds: 1 });
	await h.enqueue(a);
	await waitFor(() => h.view(a.attemptId)?.state === "timed_out", {
		timeout: 2500,
	});
	expect(h.pty.spawned[0]!.signals).toEqual(["SIGTERM"]);
	expect(await h.shell.stop(a.attemptId)).toBe("final");
	const ignored = make({}, fakePty(true));
	await ignored.shell.recover();
	const b = request();
	await ignored.enqueue(b);
	await waitFor(() => ignored.pty.spawned.length === 1);
	expect(await ignored.shell.stop(b.attemptId)).toBe("unconfirmed");
	expect(ignored.view(b.attemptId)).toMatchObject({
		state: "unknown",
		reason: "stop_unconfirmed",
	});
	const c = request();
	await ignored.enqueue(c);
	await Bun.sleep(20);
	expect(ignored.pty.spawned).toHaveLength(1);
	ignored.pty.spawned[0]!.exit(0);
	await waitFor(() => ignored.pty.spawned.length === 2);
	expect(ignored.view(b.attemptId)?.state).toBe("unknown");
});

test("running work recovers as unknown and queued work as cancelled without relaunch", async () => {
	const h = make();
	await h.shell.recover();
	const a = request();
	await h.enqueue(a);
	await waitFor(() => h.pty.spawned.length === 1);
	const b = request();
	await h.enqueue(b);
	h.shell.closeAll();
	const pty = fakePty();
	const next = createShell({
		store: h.store,
		shell: "/bin/sh",
		spawn: pty.spawn,
	});
	try {
		await next.recover();
		expect(h.view(a.attemptId)).toMatchObject({
			state: "unknown",
			reason: "restarted",
		});
		expect(h.view(b.attemptId)?.state).toBe("cancelled");
		expect(pty.spawned).toHaveLength(0);
	} finally {
		next.closeAll();
	}
});

test("screen reconnect, restart, run input and SSE replay use the authenticated API mount", async () => {
	const h = make();
	const app = new Hono();
	registerShell(app, h.shell);
	const res = await app.request("/api/shell/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cols: 80, rows: 24 }),
	});
	expect(res.status).toBe(201);
	const s = await res.json();
	expect(h.pty.spawned[0]!.command).toEqual(["/bin/sh", "-l"]);
	expect(h.shell.start({ cols: 80, rows: 24 }).id).toBe(s.id);
	expect(h.pty.spawned).toHaveLength(1);
	h.pty.spawned[0]!.data("hello");
	const stream = h.shell.stream(s.id, new AbortController().signal);
	const reader = stream.body!.getReader();
	const frame = new TextDecoder().decode((await reader.read()).value);
	expect(frame).toContain(Buffer.from("hello").toString("base64"));
	await reader.cancel();
	h.shell.input(s.id, "typed\r");
	expect(h.pty.spawned[0]!.writes).toEqual(["typed\r"]);
	h.pty.spawned[0]!.exit(0);
	await waitFor(() => h.shell.list().sessions[0]?.status === "exited");
	expect(h.shell.restart(s.id, { cols: 90, rows: 30 }).run).toBe(2);
	await h.shell.recover();
	const a = request();
	await h.enqueue(a);
	await waitFor(() => h.pty.spawned.length === 3);
	const run = h.shell.list().sessions.find((s) => s.kind === "run")!;
	h.shell.input(run.id, "answer\r");
	expect(h.pty.spawned[2]!.writes).toEqual(["answer\r"]);
	expect(() => h.shell.restart(run.id, { cols: 80, rows: 24 })).toThrow(
		"shell_run_not_restartable",
	);
});

test("bounded plain output preserves head and tail and child environment excludes secrets", () => {
	const output = createOutput();
	output.add(new TextEncoder().encode("HEAD" + "あ".repeat(40_000) + "TAIL"));
	output.finish();
	const r = output.result();
	expect(r.outputTruncated).toBe(true);
	expect(r.output.length).toBeLessThanOrEqual(30_000);
	expect(r.output.startsWith("HEAD")).toBe(true);
	expect(r.output.endsWith("TAIL")).toBe(true);
	expect(
		childEnv({
			EUMENES_TOKEN: "secret",
			LARM_API_TOKEN: "larm-secret",
			CLAUDECODE: "parent",
			PATH: "/bin",
		}),
	).toEqual({ PATH: "/bin", TERM: "xterm-256color", COLORTERM: "truecolor" });
});

test("real PTY executes a command and exposes the same output through the screen", async () => {
	const h = make({ spawn: undefined });
	await h.shell.recover();
	const a = request({ command: "printf 'actual-pty\\n'; exit 3" });
	await h.enqueue(a);
	await waitFor(() => h.view(a.attemptId)?.state === "completed");
	expect(h.view(a.attemptId)).toMatchObject({
		exitCode: 3,
		output: "actual-pty\n",
	});
	const s = h.shell.list().sessions[0]!;
	expect(s.exitCode).toBe(3);
	const stream = h.shell.stream(s.id, new AbortController().signal);
	expect(await stream.text()).toContain(
		Buffer.from("actual-pty\r\n").toString("base64"),
	);
});

test("ANSI and Unicode chunks are stripped before counting and truncation", () => {
	const output = createOutput();
	for (const chunk of [
		"\x1b[",
		"31m",
		"あ",
		"\x1b[0",
		"m\x1b]0;title",
		"\x1b\\",
		"b\r\n",
	])
		output.add(new TextEncoder().encode(chunk));
	output.add(new TextEncoder().encode("\x1b[31m".repeat(8000)));
	output.finish();
	expect(output.result()).toEqual({ output: "あb\n", outputTruncated: false });
	const unicode = createOutput();
	const bytes = new TextEncoder().encode("😀");
	unicode.add(bytes.slice(0, 2));
	unicode.add(bytes.slice(2));
	unicode.finish();
	expect(unicode.result().output).toBe("😀");
});

test("retention keeps open work and the newest 2000 terminal runs", async () => {
	const h = make();
	const open = request();
	let latest = "";
	await h.store.write((db) => {
		h.shell.enqueueRunInTransaction(db, open);
		for (let i = 0; i < 2002; i++) {
			const r = request();
			latest = r.attemptId;
			h.shell.enqueueRunInTransaction(db, r);
			h.shell.cancelInTransaction(db, r.attemptId);
		}
	});
	expect(
		await h.store.write((db) => h.shell.pruneInTransaction(db, new Date())),
	).toBe(2);
	expect(h.view(open.attemptId)?.state).toBe("queued");
	expect(h.view(latest)?.state).toBe("cancelled");
	expect(
		await h.store.write((db) =>
			h.shell.pruneInTransaction(db, new Date(Date.now() + 31 * 86400_000)),
		),
	).toBe(2000);
	expect(h.view(open.attemptId)?.state).toBe("queued");
});

test("spawn failure, unavailable shell and confirmed stop are explicit terminal outcomes", async () => {
	const bad = make({
		spawn: () => {
			throw new Error("spawn_failed");
		},
	});
	await bad.shell.recover();
	const a = request();
	await bad.enqueue(a);
	await waitFor(() => bad.view(a.attemptId)?.state === "cancelled");
	expect(bad.view(a.attemptId)?.reason).toBe("spawn_failed");
	const missing = make({ shell: null });
	expect(missing.shell.available()).toBe(false);
	expect(() => missing.shell.start({ cols: 80, rows: 24 })).toThrow(
		"shell_unavailable",
	);
	const h = make();
	await h.shell.recover();
	const r = request();
	await h.enqueue(r);
	await waitFor(() => h.pty.spawned.length === 1);
	expect(await h.shell.stop(r.attemptId)).toBe("stopped");
	expect(h.view(r.attemptId)).toMatchObject({
		state: "unknown",
		reason: "stopped_by_person",
	});
});

test("an unconfirmed stop remains unconfirmed while the process is alive", async () => {
	const h = make({}, fakePty(true));
	await h.shell.recover();
	const r = request();
	await h.enqueue(r);
	await waitFor(() => h.pty.spawned.length === 1);
	expect(await h.shell.stop(r.attemptId)).toBe("unconfirmed");
	expect(await h.shell.stop(r.attemptId)).toBe("unconfirmed");
	h.pty.spawned[0]!.exit(0);
	await waitFor(() => h.shell.list().sessions[0]?.status === "exited");
	expect(await h.shell.stop(r.attemptId)).toBe("final");
});

test("live output is complete even when one chunk is larger than the bounded replay", async () => {
	const h = make({ backlogBytes: 4 });
	const s = h.shell.start({ cols: 80, rows: 24 });
	const reader = h.shell
		.stream(s.id, new AbortController().signal)
		.body!.getReader();
	h.pty.spawned[0]!.data("12345678");
	expect(new TextDecoder().decode((await reader.read()).value)).toContain(
		Buffer.from("12345678").toString("base64"),
	);
	await reader.cancel();
	const replay = h.shell
		.stream(s.id, new AbortController().signal)
		.body!.getReader();
	expect(new TextDecoder().decode((await replay.read()).value)).toContain(
		Buffer.from("5678").toString("base64"),
	);
	await replay.cancel();
});

test("a conversation command waits for the displayed digest and does not run before that", async () => {
	const h = make();
	await h.shell.recover();
	const r = request({ origin: "conversation", conversationId: "main" });
	await h.enqueue(r);
	expect(h.view(r.attemptId)?.state).toBe("awaiting_approval");
	expect(h.pty.spawned).toHaveLength(0);
	const digest = h.shell.list().approvals[0]?.digest ?? "";
	await expect(
		h.shell.decide(r.attemptId, {
			decision: "execute",
			digest: "0".repeat(64),
		}),
	).rejects.toThrow("shell_run_conflict");
	expect(h.pty.spawned).toHaveLength(0);
	await h.shell.decide(r.attemptId, { decision: "execute", digest });
	await waitFor(() => h.pty.spawned.length === 1);
	expect(h.pty.spawned[0]?.command.at(-1)).toBe(r.command);
});

test("executing an expired approval cancels it without rolling the cancel back", async () => {
	let now = new Date("2026-10-31T00:00:00.000Z");
	const h = make({ now: () => now });
	await h.shell.recover();
	const r = request({
		origin: "conversation",
		conversationId: "main",
		command: "printf late",
	});
	await h.enqueue(r);
	const digest = h.shell.list().approvals[0]!.digest;
	now = new Date(now.getTime() + APPROVAL_MS + 1000);
	await expect(
		h.shell.decide(r.attemptId, { decision: "execute", digest }),
	).rejects.toThrow("shell_not_found");
	expect(h.view(r.attemptId)).toMatchObject({
		state: "cancelled",
		reason: "approval_expired",
	});
	expect(h.pty.spawned).toHaveLength(0);
});

test("cancelling a waiting command and letting it expire both leave it unrun", async () => {
	let now = new Date("2026-10-31T00:00:00.000Z");
	const h = make({ now: () => now });
	await h.shell.recover();
	const cancelled = request({ origin: "conversation", conversationId: "main" });
	await h.enqueue(cancelled);
	await h.shell.decide(cancelled.attemptId, {
		decision: "cancel",
		digest: h.shell.list().approvals[0]!.digest,
	});
	expect(h.view(cancelled.attemptId)).toMatchObject({
		state: "cancelled",
		reason: "cancelled_by_person",
	});
	const waiting = request({
		origin: "conversation",
		conversationId: "main",
		command: "printf later",
	});
	await h.enqueue(waiting);
	h.shell.closeAll();
	const pty = fakePty();
	const next = createShell({
		store: h.store,
		shell: "/bin/sh",
		spawn: pty.spawn,
		now: () => now,
	});
	try {
		await next.recover();
		expect(h.view(waiting.attemptId)?.state).toBe("awaiting_approval");
		expect(pty.spawned).toHaveLength(0);
		next.closeAll();
		now = new Date(now.getTime() + APPROVAL_MS + 1000);
		const later = createShell({
			store: h.store,
			shell: "/bin/sh",
			spawn: pty.spawn,
			now: () => now,
		});
		try {
			await later.recover();
			expect(h.view(waiting.attemptId)).toMatchObject({
				state: "cancelled",
				reason: "approval_expired",
			});
			expect(pty.spawned).toHaveLength(0);
		} finally {
			later.closeAll();
		}
	} finally {
		next.closeAll();
	}
});
