import { afterEach, expect, test } from "bun:test";
import { cleanup, messages, setup } from "./inference.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

for (const mode of ["cloud-only", "larm-only"] as const)
	test(`a child control uses its parent's ${mode} LLM route and exact context`, async () => {
		let localCalls = 0;
		const cloud: Record<string, unknown>[] = [];
		const h = await setup({
			local: async () => {
				localCalls++;
				return '{"action":"finish"}';
			},
			fetch: (async (_url, init) => {
				cloud.push(JSON.parse(init!.body as string));
				return Response.json({
					choices: [{ message: { content: '{"action":"finish"}' } }],
				});
			}) as typeof fetch,
		});
		const settings = h.settings.get();
		settings.routes.llm.mode = mode;
		settings.routes.llm.cloudAllowed = mode === "cloud-only";
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const parentDeadline = Date.now() + 10000;
		const id = await h.store.write((db) => {
			h.inference.captureInTransaction(
				db,
				"selected-route-parent",
				"llm",
				parentDeadline,
			);
			return h.inference.captureControlInTransaction(db, {
				subject: "agent:selected-route",
				policySubject: "selected-route-parent",
				deadline: Date.now() + 20000,
				maxOutputTokens: 512,
			});
		});
		const saved = h.store.read((db) =>
			db
				.query(
					"SELECT snapshot,context_policy,deadline,control_policy_request_id FROM inference_requests WHERE id=?",
				)
				.get(id),
		) as {
			snapshot: string;
			context_policy: string;
			deadline: number;
			control_policy_request_id: string;
		};
		expect(JSON.parse(saved.snapshot).routes.llm).toEqual(
			h.settings.get().routes.llm,
		);
		expect(saved.context_policy).toBe("exact");
		expect(saved.deadline).toBe(parentDeadline);
		expect(saved.control_policy_request_id).toBeTruthy();
		const receipt = await h.inference.executeControl(
			id,
			messages,
			new AbortController().signal,
			undefined,
			{ sessionRole: "subagent", taskId: "fixture-child" },
		);
		expect(receipt.value).toBe('{"action":"finish"}');
		expect(localCalls).toBe(mode === "larm-only" ? 1 : 0);
		expect(cloud).toHaveLength(mode === "cloud-only" ? 1 : 0);
		if (mode === "cloud-only")
			expect(cloud[0]!.model).toBe(
				settings.resources.find((r) => r.id === settings.routes.llm.fallbackId)!
					.model,
			);
		const current = h.settings.get();
		current.connections[0]!.enabled = false;
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: current.revision,
			settings: current,
			keys: [],
		});
		if (mode === "cloud-only")
			expect(
				await h.store.write((db) =>
					h.inference.acceptInTransaction(db, receipt),
				),
			).toBe(false);
	});

test("an independent subagent uses the current conversation route while other independent controls retain their local default", async () => {
	let localCalls = 0;
	let cloudCalls = 0;
	const h = await setup({
		local: async () => {
			localCalls++;
			return "{}";
		},
		fetch: (async (_url, _init) => {
			cloudCalls++;
			return Response.json({ choices: [{ message: { content: "{}" } }] });
		}) as typeof fetch,
	});
	const settings = h.settings.get();
	settings.routes.llm.mode = "cloud-only";
	settings.routes.llm.cloudAllowed = true;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	for (const route of ["subagent", undefined] as const) {
		const id = await h.store.write((db) =>
			h.inference.captureUserControlInTransaction(db, {
				subject: `execution:${crypto.randomUUID()}`,
				deadline: Date.now() + 9000,
				maxOutputTokens: 512,
				...(route ? { route } : {}),
			}),
		);
		await h.inference.executeControl(
			id,
			messages,
			new AbortController().signal,
			undefined,
			{ sessionRole: "subagent", taskId: crypto.randomUUID() },
		);
	}
	const maintenance = await h.store.write((db) =>
		h.inference.captureMaintenanceControlInTransaction(db, {
			subject: "maintenance:route-regression",
			deadline: Date.now() + 9000,
			maxOutputTokens: 512,
		}),
	);
	await h.inference.executeControl(
		maintenance,
		messages,
		new AbortController().signal,
	);
	expect(cloudCalls).toBe(1);
	expect(localCalls).toBe(2);
});
