import { afterEach, expect, test } from "bun:test";
import { REASONING_ALLOWANCE_TOKENS } from "../service/attempt-work";
import { attemptDuration } from "../service/attempt-work";
import { cleanup, messages, setup } from "./inference.fixture";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
test("control calls preserve exact context, stay local, skip emotion judgement, and rejected JSON is never adopted", async () => {
	let judgement = 0;
	let opts: unknown;
	const h = await setup({
		dataset: true,
		judge: async () => {
			judgement++;
			throw new Error("unexpected_judge");
		},
		local: async (_messages, _signal, options) => {
			opts = options;
			return '{"action":"respond"}';
		},
	});
	const id = await h.store.write((db) => {
		h.inference.captureInTransaction(
			db,
			"root-control",
			"llm",
			Date.now() + 10000,
		);
		return h.inference.captureControlInTransaction(db, {
			subject: "agent:control:1",
			policySubject: "root-control",
			deadline: Date.now() + 9000,
			maxOutputTokens: 2048,
		});
	});
	const receipt = await h.inference.executeControl(
		id,
		messages,
		new AbortController().signal,
	);
	expect(receipt.value).toBe('{"action":"respond"}');
	expect(opts).toMatchObject({
		contextPolicy: "exact",
		maxOutputTokens: 2048 + REASONING_ALLOWANCE_TOKENS,
		jsonOutput: true,
	});
	expect(judgement).toBe(0);
	expect(h.calls).toHaveLength(0);
	expect(receipt.delivery).toBeUndefined();
	await h.store.write((db) =>
		h.inference.rejectControlInTransaction(db, receipt, "invalid_control_json"),
	);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(false);
	expect(
		h.store.read((db) =>
			db.query("SELECT status,mode FROM inference_requests WHERE id=?").get(id),
		),
	).toEqual({ status: "rejected", mode: "control" });
});
test("only a structured-output control request sends the output schema to LARM; others stay plain JSON-object", async () => {
	const seen: Array<Record<string, unknown> | undefined> = [];
	const h = await setup({
		local: async (_messages, _signal, options) => {
			seen.push(options?.jsonSchema);
			return "{}";
		},
	});
	const outputSchema = {
		type: "object",
		properties: { done: { type: "boolean" } },
		required: ["done"],
		additionalProperties: false,
	};
	const background = (decisionId: string, structuredOutput?: boolean) =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				route: "conversation",
				...(structuredOutput ? { structuredOutput } : {}),
			}),
		);
	const control = { instructions: "step", outputSchema };
	const signal = new AbortController().signal;
	const plain = await h.store.write((db) =>
		h.inference.captureMaintenanceControlInTransaction(db, {
			subject: "schema-route",
			deadline: Date.now() + 30000,
			maxOutputTokens: 512,
		}),
	);
	await h.inference.executeControl(plain, messages, signal, control);
	await h.inference.executeControl(
		await background("plain"),
		messages,
		signal,
		control,
	);
	await h.inference.executeControl(
		await background("structured", true),
		messages,
		signal,
		control,
	);
	await h.inference.answer(messages, signal);
	expect(seen).toEqual([undefined, undefined, outputSchema, undefined]);
});
test("a background control keeps the conversation route only when asked, and a different binding conflicts", async () => {
	const h = await setup();
	const capture = (decisionId: string, route?: "conversation") =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				...(route ? { route } : {}),
			}),
		);
	const routeOf = (id: string) =>
		h.store.read((db) => {
			const row = db
				.query("SELECT snapshot FROM inference_requests WHERE id=?")
				.get(id) as { snapshot: string };
			const { llm } = JSON.parse(row.snapshot).routes;
			return [llm.mode, llm.cloudAllowed];
		});
	const larmOnly = await capture("a");
	expect(routeOf(larmOnly)).toEqual(["larm-only", false]);
	const conversation = await capture("b", "conversation");
	expect(routeOf(conversation)).not.toEqual(["larm-only", false]);
	await expect(capture("b")).rejects.toThrow("background_control_conflict");
});
test("a background control on a saved resource goes to that resource only, and falls back to the conversation route when it can not be used", async () => {
	const h = await setup();
	const capture = (decisionId: string, resourceId: string) =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				route: { resourceId },
			}),
		);
	const routeOf = (id: string) =>
		h.store.read((db) => {
			const row = db
				.query("SELECT snapshot FROM inference_requests WHERE id=?")
				.get(id) as { snapshot: string };
			const { llm } = JSON.parse(row.snapshot).routes;
			return [llm.mode, llm.fallbackId];
		});
	const saved = h.settings.get();
	const llm = saved.resources.find((r) => r.purpose === "llm")!;
	const extra = crypto.randomUUID();
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: {
			...saved,
			resources: [
				...saved.resources,
				{ ...llm, id: extra, model: "fixture-llm-2" },
			],
		},
		keys: [],
	});
	expect(routeOf(await capture("a", extra))).toEqual(["cloud-only", extra]);
	// Not a registered LLM resource: no path to compare with the conversation route's cloud, so LARM only.
	expect(routeOf(await capture("b", crypto.randomUUID()))).toEqual([
		"larm-only",
		llm.id,
	]);
	// The conversation route forbids the cloud: the resource is not used.
	const now = h.settings.get();
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: now.revision,
		settings: {
			...now,
			routes: {
				...now.routes,
				llm: { ...now.routes.llm, cloudAllowed: false },
			},
		},
		keys: [],
	});
	expect(routeOf(await capture("c", extra))).toEqual([
		"larm-preferred",
		llm.id,
	]);
});
test("a dedicated resource that can not be used falls back to the conversation route only on the same billing path", async () => {
	const h = await setup();
	const saved = h.settings.get();
	const llm = saved.resources.find((r) => r.purpose === "llm")!;
	const conversation = saved.connections.find(
		(c) => c.id === llm.connectionId,
	)!;
	const make = (kind: "codex-sdk" | undefined) => {
		const connectionId = crypto.randomUUID();
		const resourceId = crypto.randomUUID();
		return {
			connection: { ...conversation, id: connectionId, enabled: false, kind },
			resource: { ...llm, id: resourceId, connectionId },
		};
	};
	const samePath = make(undefined);
	const otherPath = make("codex-sdk");
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: {
			...saved,
			connections: [
				...saved.connections,
				samePath.connection,
				otherPath.connection,
			],
			resources: [...saved.resources, samePath.resource, otherPath.resource],
		},
		keys: [],
	});
	const routeOf = (id: string) =>
		h.store.read((db) => {
			const row = db
				.query("SELECT snapshot FROM inference_requests WHERE id=?")
				.get(id) as { snapshot: string };
			const { llm } = JSON.parse(row.snapshot).routes;
			return [llm.mode, llm.cloudAllowed, llm.fallbackId];
		});
	const background = (decisionId: string, resourceId: string) =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				route: { resourceId },
			}),
		);
	const root = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "root", "llm", Date.now() + 60000),
	);
	expect(root).toBeTruthy();
	// Same billing path: the saved conversation route, as before.
	const keep = ["larm-preferred", true, llm.id];
	expect(routeOf(await background("same", samePath.resource.id))).toEqual(keep);
	// Another billing path: the call stays on LARM, it is not moved to the conversation's cloud.
	const larmOnly = ["larm-only", false, llm.id];
	expect(routeOf(await background("other", otherPath.resource.id))).toEqual(
		larmOnly,
	);
	// A child has no separate route: it inherits the parent's selected LLM.
	const plain = await h.store.write((db) =>
		h.inference.captureControlInTransaction!(db, {
			subject: "agent:plain",
			policySubject: "root",
			deadline: Date.now() + 20000,
			maxOutputTokens: 512,
		}),
	);
	expect(routeOf(plain)).toEqual(keep);
});
test("a control request may ask for a long output (a large draft), up to 32k tokens", async () => {
	let opts: unknown;
	const h = await setup({
		local: async (_messages, _signal, options) => {
			opts = options;
			return '{"action":"respond"}';
		},
	});
	const capture = (maxOutputTokens: number, n: number) =>
		h.store.write((db) => {
			h.inference.captureInTransaction(
				db,
				`root-long-${n}`,
				"llm",
				Date.now() + 10000,
			);
			return h.inference.captureControlInTransaction(db, {
				subject: `agent:long:${n}`,
				policySubject: `root-long-${n}`,
				deadline: Date.now() + 9000,
				maxOutputTokens,
			});
		});
	await h.inference.executeControl(
		await capture(24_576, 1),
		messages,
		new AbortController().signal,
	);
	expect(opts).toMatchObject({
		maxOutputTokens: 24_576 + REASONING_ALLOWANCE_TOKENS,
	});
	await h.inference.executeControl(
		await capture(100_000, 2),
		messages,
		new AbortController().signal,
	);
	expect(opts).toMatchObject({
		maxOutputTokens: 32_768 + REASONING_ALLOWANCE_TOKENS,
	});
});
test("a toolchain's own limits: the run's requests are moved later (never earlier) and an attempt carries its own time", async () => {
	let opts: unknown;
	const h = await setup({
		local: async (_messages, _signal, options) => {
			opts = options;
			return '{"action":"respond"}';
		},
	});
	const now = Date.now();
	const deadlineOf = (subject: string) =>
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT deadline FROM inference_requests WHERE subject=?")
						.get(subject) as { deadline: number }
				).deadline,
		);
	const id = await h.store.write((db) => {
		h.inference.captureInTransaction(db, "root-slow", "llm", now + 10_000);
		h.inference.extendDeadlineInTransaction(db, "root-slow", now + 900_000);
		h.inference.extendDeadlineInTransaction(db, "root-slow", now + 5_000);
		return h.inference.captureControlInTransaction(db, {
			subject: "agent:slow",
			policySubject: "root-slow",
			deadline: now + 800_000,
			maxOutputTokens: 1000,
			attemptMs: 600_000,
		});
	});
	expect(deadlineOf("root-slow")).toBe(now + 900_000);
	expect(deadlineOf("agent:slow")).toBe(now + 800_000);
	await h.inference.executeControl(id, messages, new AbortController().signal);
	expect(opts).toMatchObject({ attemptMs: 600_000 });
	// Running it bounds the request by its own attempt time, not the usual 180 s.
	expect(deadlineOf("agent:slow")).toBeGreaterThanOrEqual(now + 600_000);
	expect(deadlineOf("agent:slow")).toBeLessThan(now + 800_000);
	const plain = await h.store.write((db) => {
		h.inference.captureInTransaction(db, "root-plain", "llm", now + 10_000);
		return h.inference.captureControlInTransaction(db, {
			subject: "agent:plain",
			policySubject: "root-plain",
			deadline: now + 9_000,
			maxOutputTokens: 1000,
		});
	});
	await h.inference.executeControl(
		plain,
		messages,
		new AbortController().signal,
	);
	expect(opts).not.toHaveProperty("attemptMs");
});
test("an attempt's own time replaces the LARM and cloud defaults, within the request's deadline", () => {
	const request = (attemptMs: number | null, deadlineIn: number) =>
		({
			env: { options: {} },
			row: {
				purpose: "llm",
				attemptMs,
				snapshot: { routes: { llm: { mode: "larm-only" } } },
			},
			deadline: Date.now() + deadlineIn,
		}) as unknown as Parameters<typeof attemptDuration>[0];
	// Without its own time, a LARM chat attempt may take the request's whole deadline.
	const whole = attemptDuration(request(null, 900_000), "larm");
	expect(whole).toBeLessThanOrEqual(900_000);
	expect(whole).toBeGreaterThan(899_000);
	expect(attemptDuration(request(null, 900_000), "cloud")).toBe(60_000);
	expect(attemptDuration(request(600_000, 900_000), "larm")).toBe(600_000);
	expect(attemptDuration(request(600_000, 900_000), "cloud")).toBe(600_000);
	const short = attemptDuration(request(600_000, 30_000), "cloud");
	expect(short).toBeLessThanOrEqual(30_000);
	expect(short).toBeGreaterThan(29_000);
});
