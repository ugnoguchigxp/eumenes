import { afterEach, expect, test } from "bun:test";
import { cleanup, messages, setup } from "./inference.fixture";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
test("a failed optional auxiliary call leaves the answer request usable, with the failed attempt recorded", async () => {
	let calls = 0;
	const h = await setup({
		local: async () => {
			if (++calls === 1) throw new Error("provider_fixture_failure");
			return "answer";
		},
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"shared-answer",
			"llm",
			Date.now() + 30000,
		),
	);
	const signal = new AbortController().signal;
	await expect(
		h.inference.executeStream(
			id,
			messages,
			signal,
			() => {},
			undefined,
			undefined,
			{
				sessionRole: "auxiliary",
				failureScope: "call",
			},
		),
	).rejects.toThrow("provider_fixture_failure");
	const result = await h.inference.executeStream(
		id,
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main" },
	);
	expect(result.value).toBe("answer");
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, result)),
	).toBe(true);
	expect(
		h.store.read((db) =>
			db
				.query(
					"SELECT status FROM inference_attempts WHERE request_id=? ORDER BY rowid",
				)
				.all(id),
		),
	).toEqual([{ status: "failed" }, { status: "succeeded" }]);
});
test("optional work cannot weaken a main/control request or cancellation, and never streams hidden text", async () => {
	const controller = new AbortController();
	const h = await setup({
		local: async () => {
			controller.abort();
			throw new Error("provider_fixture_failure");
		},
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"cancelled-helper",
			"llm",
			Date.now() + 30000,
		),
	);
	await expect(
		h.inference.executeStream(
			id,
			messages,
			new AbortController().signal,
			() => {},
			undefined,
			undefined,
			{ sessionRole: "main", failureScope: "call" },
		),
	).rejects.toThrow("invalid_failure_scope");
	const control = await h.store.write((db) =>
		h.inference.captureMaintenanceControlInTransaction(db, {
			subject: "control-helper",
			deadline: Date.now() + 30000,
			maxOutputTokens: 100,
		}),
	);
	await expect(
		h.inference.executeControl(
			control,
			messages,
			new AbortController().signal,
			undefined,
			{ failureScope: "call" },
		),
	).rejects.toThrow("invalid_failure_scope");
	await expect(
		h.inference.executeStream(
			id,
			messages,
			controller.signal,
			() => {},
			undefined,
			undefined,
			{ failureScope: "call" },
		),
	).rejects.toThrow("cancelled");
	await expect(
		h.inference.executeStream(
			id,
			messages,
			new AbortController().signal,
			() => {},
		),
	).rejects.toThrow("permission_revoked");
	let streamed = false;
	const hidden = await setup({
		local: async () => "hidden result",
		localStream: async (_m, _s, delta) => {
			delta("hidden");
			throw new Error("unexpected_stream");
		},
	});
	const hiddenId = await hidden.store.write((db) =>
		hidden.inference.captureInTransaction(
			db,
			"hidden-helper",
			"llm",
			Date.now() + 30000,
		),
	);
	expect(
		(
			await hidden.inference.executeStream(
				hiddenId,
				messages,
				new AbortController().signal,
				() => {
					streamed = true;
				},
				undefined,
				undefined,
				{ failureScope: "call" },
			)
		).value,
	).toBe("hidden result");
	expect(streamed).toBe(false);
});
test("a call without a role is auxiliary: the output mode no longer decides the session", async () => {
	const roles: unknown[] = [];
	const h = await setup({
		local: async (_messages, _signal, options) => {
			roles.push(options?.sessionRole);
			return "{}";
		},
	});
	await h.inference.answer(messages, new AbortController().signal);
	const id = await h.store.write((db) =>
		h.inference.captureMaintenanceControlInTransaction(db, {
			subject: "independent-helper",
			deadline: Date.now() + 30000,
			maxOutputTokens: 512,
		}),
	);
	await h.inference.executeControl(id, messages, new AbortController().signal);
	expect(roles).toEqual(["auxiliary", "auxiliary"]);
});
test("the caller sets the session role per call; it is validated and recorded with the task on each attempt", async () => {
	const seen: unknown[] = [];
	const h = await setup({
		local: async (_messages, _signal, options) => {
			seen.push([options?.sessionRole, options?.taskId]);
			return "{}";
		},
	});
	const signal = new AbortController().signal;
	const answerRequest = () =>
		h.store.write((db) =>
			h.inference.captureInTransaction(
				db,
				crypto.randomUUID(),
				"llm",
				Date.now() + 30000,
			),
		);
	const controlRequest = () =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction(db, {
				taskId: "task",
				decisionId: crypto.randomUUID(),
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
			}),
		);
	// One answer request: a one-shot call, then the main answer, with the same request id.
	const shared = await answerRequest();
	const stream = (
		id: string,
		session?: Parameters<typeof h.inference.executeStream>[6],
	) =>
		h.inference.executeStream(
			id,
			messages,
			signal,
			() => {},
			undefined,
			undefined,
			session,
		);
	await stream(shared, { sessionRole: "auxiliary" });
	await stream(shared, { sessionRole: "main" });
	await stream(await answerRequest());
	// Control mode: a sub-agent call is allowed and carries its task.
	await h.inference.executeControl(
		await controlRequest(),
		messages,
		signal,
		undefined,
		{ sessionRole: "subagent", taskId: "agent:task-1" },
	);
	expect(seen).toEqual([
		["auxiliary", undefined],
		["main", undefined],
		["auxiliary", undefined],
		["subagent", "agent:task-1"],
	]);
	// Rejected before any attempt starts: main on a control request, a sub-agent without a task, a task on another role.
	const before = h.inference.usage().length;
	await expect(
		h.inference.executeControl(
			await controlRequest(),
			messages,
			signal,
			undefined,
			{
				sessionRole: "main",
			},
		),
	).rejects.toThrow("invalid_session_role");
	await expect(
		h.inference.executeControl(
			await controlRequest(),
			messages,
			signal,
			undefined,
			{
				sessionRole: "subagent",
			},
		),
	).rejects.toThrow("invalid_session_role");
	await expect(
		h.inference.executeControl(
			await controlRequest(),
			messages,
			signal,
			undefined,
			{
				sessionRole: "auxiliary",
				taskId: "task",
			},
		),
	).rejects.toThrow("invalid_session_role");
	// A read-ahead is only a call on the conversation's connection.
	await expect(
		h.inference.executeControl(
			await controlRequest(),
			messages,
			signal,
			undefined,
			{ sessionRole: "auxiliary", readAhead: true },
		),
	).rejects.toThrow("invalid_session_role");
	await expect(
		stream(await answerRequest(), {
			sessionRole: "subagent",
			taskId: "bad id",
		}),
	).rejects.toThrow("invalid_session_role");
	expect(h.inference.usage()).toHaveLength(before);
	const attempts = h.store.read((db) =>
		db
			.query(
				"SELECT source,session_role,task_id,billing_path FROM inference_attempts ORDER BY started,rowid",
			)
			.all(),
	);
	expect(attempts).toEqual([
		{
			source: "larm",
			session_role: "auxiliary",
			task_id: null,
			billing_path: "larm",
		},
		{
			source: "larm",
			session_role: "main",
			task_id: null,
			billing_path: "larm",
		},
		{
			source: "larm",
			session_role: "auxiliary",
			task_id: null,
			billing_path: "larm",
		},
		{
			source: "larm",
			session_role: "subagent",
			task_id: "agent:task-1",
			billing_path: "larm",
		},
	]);
});
test("a cloud fallback attempt records the role and the connection's billing path", async () => {
	const h = await setup();
	await h.inference.answer(messages, new AbortController().signal);
	const row = h.store.read((db) =>
		db
			.query(
				"SELECT session_role,billing_path FROM inference_attempts WHERE source='cloud'",
			)
			.get(),
	);
	expect(row).toEqual({
		session_role: "auxiliary",
		billing_path: "openai-compatible",
	}); // The usage listing carries the path, for the chat screen's last-used display.
	expect(
		(h.inference.usage() as { source: string; billingPath: string }[])
			.filter((u) => u.source === "cloud")
			.map((u) => u.billingPath),
	).toEqual(["openai-compatible"]);
});
test("a main call's reasoning reaches the LARM stream call, and any other role is rejected", async () => {
	const seen: Array<unknown> = [];
	const h = await setup({
		localStream: async (_messages, _signal, onDelta, options) => {
			seen.push(options?.reasoning);
			onDelta("answer");
			return "answer";
		},
	});
	const capture = (subject: string) =>
		h.store.write((db) =>
			h.inference.captureInTransaction(db, subject, "llm", Date.now() + 30000),
		);
	const signal = new AbortController().signal;
	await h.inference.executeStream(
		await capture("with-reasoning"),
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", reasoning: { larm: "off", cloud: "high" } },
	);
	await h.inference.executeStream(
		await capture("without-reasoning"),
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main" },
	);
	expect(seen).toEqual(["off", undefined]);
	for (const session of [
		{ reasoning: { larm: "low", cloud: "low" } as const },
		{
			sessionRole: "auxiliary" as const,
			reasoning: { larm: "low", cloud: "low" } as const,
		},
		{
			sessionRole: "subagent" as const,
			taskId: "t",
			reasoning: { larm: "low", cloud: "low" } as const,
		},
	])
		await expect(
			h.inference.executeStream(
				await capture(`rejected-${session.sessionRole ?? "default"}`),
				messages,
				signal,
				() => {},
				undefined,
				undefined,
				session,
			),
		).rejects.toThrow("invalid_session_role");
});
