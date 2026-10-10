import { afterEach, expect, test } from "bun:test";
import { dotsFixture } from "./dots-fixture";
import { Webhook } from "../../packages/dots-mcp/src";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0)) await close();
});
async function setup(now?: () => number) {
	const f = await dotsFixture(now);
	clean.push(f.close);
	const r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	return { ...f, r, c };
}
test("a startup blocker can be reported before any session or acknowledgement", async () => {
	const f = await setup();
	await f.dots.report(
		"dots",
		f.report(f.c, 1, "blocked", {
			question: {
				questionId: "startup",
				prompt: "Native tools unavailable",
				answerType: "text",
				choices: [],
			},
		}),
	);
	expect(f.tasks.get(f.r.taskId).task.state).toBe("waiting_user");
});
test("failure before session creation is recorded without claiming a session exists", async () => {
	const f = await setup();
	await f.dots.report("dots", f.report(f.c, 1, "failed"));
	expect(f.tasks.get(f.r.taskId).task.state).toBe("failed");
	expect(f.dots.taskSnapshot("dots", f.r.taskId).sessions).toEqual([]);
});
test("restricting the session budget still allows confirmation that all existing children stopped", async () => {
	const f = await setup(),
		sessions = [
			f.session,
			{
				...f.session,
				threadId: "session-2",
				parentThreadId: f.session.threadId,
			},
		];
	await f.dots.report(
		"dots",
		f.report(f.c, 1, "session_started", { sessions }),
	);
	const t = f.tasks.get(f.r.taskId).task;
	await f.tasks.amend(t.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: t.revision,
		grant: { ...t.grant, maxSessions: 1, operations: ["read"] },
	});
	const stop = f.command(t.id, "stop");
	await f.dots.claim("dots", {
		commandId: stop.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(stop, 2, "stopped", { sessions, childrenStopped: true }),
	);
	expect(f.tasks.get(t.id).task.state).toBe("paused");
});
test("an expired stop is renewed with the same lease and remains confirmable", async () => {
	let at = Date.now();
	const f = await setup(() => at);
	await f.dots.report(
		"dots",
		f.report(f.c, 1, "session_started", { sessions: [f.session] }),
	);
	const t = f.tasks.get(f.r.taskId).task;
	await f.tasks.stop(t.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: t.revision,
		intent: "cancel",
	});
	const stop = f.command(t.id, "stop"),
		leaseId = crypto.randomUUID();
	await f.dots.claim("dots", { commandId: stop.commandId, leaseId });
	at += 2 * 86400000;
	await f.tasks.maintenance();
	const renewed = f.dots.getCommand("dots", stop.commandId);
	expect(renewed.leaseId).toBe(leaseId);
	expect(renewed.expiresAt).toBeGreaterThan(at);
	await f.dots.report(
		"dots",
		f.report(renewed, 2, "stopped", {
			sessions: [f.session],
			childrenStopped: true,
		}),
	);
	expect(f.tasks.get(t.id).task.state).toBe("cancelled");
});
test("explicitly authorized continuation reuses a finished task's session, but not an active task's session", async () => {
	const f = await setup();
	await f.dots.report(
		"dots",
		f.report(f.c, 1, "session_started", { sessions: [f.session] }),
	);
	await f.dots.report(
		"dots",
		f.report(f.c, 2, "completed", {
			evidenceRefs: ["check"],
			completionChecks: [{ status: "satisfied", evidenceRefs: ["check"] }],
		}),
	);
	const { revision, ...project } = f.project;
	await f.dots.config.configureProject({
		...project,
		expectedRevision: revision,
		allowedOperations: [...project.allowedOperations, "continue_session"],
	});
	const input = f.input();
	if (input.kind !== "orchestration") throw new Error("fixture_kind");
	input.grant.operations = ["read", "continue_session"];
	input.grant.sessionRefs = [f.session.threadId];
	const next = await f.tasks.create(input),
		c = f.command(next.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(c, 1, "session_started", { sessions: [f.session] }),
	);
	expect(f.dots.taskSnapshot("dots", next.taskId).sessions).toEqual([
		f.session,
	]);
	await expect(
		f.tasks.create({ ...input, requestId: crypto.randomUUID() }),
	).rejects.toThrow("dots_conflict");
});
test("a local connection with an unstarted private task cannot transfer that history to an OAuth principal", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	await f.tasks.create({ ...f.input(), startMode: "register_only" });
	await expect(
		f.dots.config.configure({
			id: "dots",
			title: "dots",
			expectedRevision: 1,
			enabled: true,
			oauth: {
				issuer: "https://issuer.example",
				jwksUrl: "https://issuer.example/keys",
				resource: "https://product.example/mcp/dots/dots",
				subject: "new-owner",
			},
		}),
	).rejects.toThrow("dots_owner_immutable");
	expect(f.dots.config.authenticateLocal(f.connection.localToken!).id).toBe(
		"dots",
	);
});
test("cancelling before start still protects the retained private request from owner transfer", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	const r = await f.tasks.create({ ...f.input(), startMode: "register_only" }),
		t = f.tasks.get(r.taskId).task;
	await f.tasks.stop(t.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: t.revision,
		intent: "cancel",
	});
	expect(f.tasks.get(t.id).task.state).toBe("cancelled");
	await expect(
		f.dots.config.configure({
			id: "dots",
			title: "changed",
			expectedRevision: 1,
			enabled: true,
			oauth: {
				issuer: "https://issuer.example",
				jwksUrl: "https://issuer.example/keys",
				resource: "https://product.example/mcp/dots/dots",
				subject: "new-owner",
			},
		}),
	).rejects.toThrow("dots_owner_immutable");
});
test("answer and restart keep a reminder binding, and explicit rebinding after pause/start refreshes its authority", async () => {
	const f = await setup();
	await f.dots.report(
		"dots",
		f.report(f.c, 1, "session_started", { sessions: [f.session] }),
	);
	const bound = await f.dots.bindSchedule(f.r.taskId, "user-schedule");
	await f.dots.report(
		"dots",
		f.report(f.c, 2, "blocked", {
			question: {
				questionId: "question",
				prompt: "Choose scope",
				answerType: "text",
				choices: [],
			},
		}),
	);
	let t = f.tasks.get(f.r.taskId).task;
	await f.tasks.answer(t.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: t.revision,
		questionId: "question",
		answer: "scope",
	});
	expect(f.dots.getCommand("dots", bound.commandId).kind).toBe("reminder");
	await f.tasks.recover();
	await f.dots.recover();
	expect(f.dots.getCommand("dots", bound.commandId).kind).toBe("reminder");
	t = f.tasks.get(t.id).task;
	await f.tasks.stop(t.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: t.revision,
		intent: "pause",
	});
	const stop = f.command(t.id, "stop");
	await f.dots.claim("dots", {
		commandId: stop.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(stop, 3, "stopped", {
			childrenStopped: true,
			sessions: [f.session],
		}),
	);
	await f.tasks.start(t.id, {
		requestId: crypto.randomUUID(),
		expectedRevision: f.tasks.get(t.id).task.revision,
	});
	const rebound = await f.dots.bindSchedule(t.id, "user-schedule");
	expect(rebound.commandId).not.toBe(bound.commandId);
	expect(f.dots.getCommand("dots", rebound.commandId).kind).toBe("reminder");
});
test("a disabled connection can refresh reference delivery solely to finish pending stops", async () => {
	let at = Date.now();
	const f = await setup(() => at);
	await f.dots.report(
		"dots",
		f.report(f.c, 1, "session_started", { sessions: [f.session] }),
	);
	await f.dots.config.configure({
		id: "dots",
		title: "disabled",
		expectedRevision: 1,
		enabled: false,
		oauth: null,
	});
	at += 2 * 86400000;
	await f.tasks.maintenance();
	const stop = f.command(f.r.taskId, "stop");
	const subscription = {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret: "whsec_" + Buffer.alloc(32, 9).toString("base64"),
		},
	};
	await f.events.subscribe("dots", subscription);
	expect(f.events.status("dots").subscribed).toBe(true);
	expect(f.queue.list({ kind: "dots.event.v1" }).items).toHaveLength(1);
	await f.dots.claim("dots", {
		commandId: stop.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(stop, 2, "stopped", {
			sessions: [f.session],
			childrenStopped: true,
		}),
	);
	await expect(f.events.subscribe("dots", subscription)).rejects.toThrow(
		"dots_unavailable",
	);
});
test("webhook headers and signatures share one timestamp even across a second boundary", async () => {
	let at = Date.now();
	const f = await setup(() => (at += 1100)),
		secret = "whsec_" + Buffer.alloc(32, 5).toString("base64");
	await f.events.subscribe("dots", {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret,
		},
	});
	const challenge = f.deliveries[0]!;
	expect(
		new Webhook(secret).verify(challenge.body, challenge.headers),
	).toMatchObject({ type: "verification" });
});
