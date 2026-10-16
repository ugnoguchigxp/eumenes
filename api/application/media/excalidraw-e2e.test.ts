import { test, expect } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { excalidrawFixture } from "./excalidraw.fixture";
for (const action of ["create", "library"] as const)
	test(`drawing ${action}: conversation chooses the registered set, accepts the plan, and returns the browser entry`, async () => {
		const f = excalidrawFixture(action),
			h = await harness({
				model: f.model,
				drawingConnection: f.connection,
				drawingFetch: f.fetcher,
			});
		try {
			const r = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: "図を描く・編集する画面を開いて",
				})
			).json();
			const run = await h.dialogue.waitForTerminal(r.id, { timeoutMs: 5000 });
			expect(run?.status).toBe("completed");
			const operation = h.drawingOperations!.list("main")[0]!;
			expect(operation.state).toBe("completed");
			expect(f.stages).toEqual(["route", "plan", "answer"]);
			expect(f.contexts.join("\n")).not.toContain("consumer-");
			expect(f.contexts.join("\n")).not.toContain("business-");
			// A new drawing is an unsaved draft link: LARM is not contacted until it is saved.
			if (action === "create")
				expect(operation.url).toMatch(
					/^http:\/\/127\.0\.0\.1:5173\/#drawing\/new\/[0-9a-f-]{36}\?title=/,
				);
			expect(h.excalidraw!.list("main")).toHaveLength(0);
			expect(f.requests).toHaveLength(0);
			expect((await h.app.request("/api/excalidraw/references")).status).toBe(
				401,
			);
			expect(
				(
					await h.app.request("/api/excalidraw/sessions", {
						method: "POST",
						headers: {
							authorization: "Bearer fixture-token-for-toolchain-browser",
							origin: "https://other.example",
						},
						body: "{}",
					})
				).status,
			).toBe(403);
		} finally {
			await h.close();
		}
	});
test("dedicated credentials are encrypted, distinct, and missing configuration never falls back to the LLM token", async () => {
	const h = await harness();
	try {
		expect(h.settings.excalidrawCredentials()).toBeNull();
		const input = {
			expectedRevision: 0,
			gatewayUrl: "http://127.0.0.1:18791/",
			leaseEndpoint: "http://127.0.0.1:18790/",
			consumerToken: "consumer-".repeat(5),
			appToken: "business-".repeat(5),
		};
		await h.settings.configureExcalidraw(input);
		const publicConfig = await (
			await h.request("/api/settings/excalidraw")
		).json();
		expect(publicConfig.consumerConfigured).toBe(true);
		expect(JSON.stringify(publicConfig)).not.toContain(input.consumerToken);
		expect(h.settings.excalidrawCredentials()?.appToken).toBe(input.appToken);
		const row = h.store.read((db) =>
			db.query("SELECT * FROM settings_excalidraw").get(),
		);
		expect(JSON.stringify(row)).not.toContain(input.appToken);
		await expect(
			h.settings.configureExcalidraw({
				...input,
				expectedRevision: 1,
				appToken: input.consumerToken,
			}),
		).rejects.toThrow("invalid_excalidraw_credential_roles");
		await expect(h.settings.configureExcalidraw(input)).rejects.toThrow(
			"conflict_excalidraw_settings",
		);
	} finally {
		await h.close();
	}
});

test("scene writes require idempotency, reject malformed input, and keep HTTP errors distinguishable", async () => {
	const f = excalidrawFixture(),
		h = await harness({
			model: f.model,
			drawingConnection: f.connection,
			drawingFetch: f.fetcher,
		});
	try {
		const s = await h.excalidraw!.session({ requestId: crypto.randomUUID() });
		await h.excalidraw!.wait(s.id);
		const headers = {
			authorization: "Bearer fixture-token-for-toolchain-browser",
			"Content-Type": "application/json",
		};
		const path = `/api/excalidraw/sessions/${s.id}/document`;
		const scene = {
			elements: [],
			appState: { viewBackgroundColor: "#ffffff" },
			files: {},
		};
		expect(
			(
				await h.app.request(path, {
					method: "POST",
					headers,
					body: JSON.stringify({ title: "図", scene }),
				})
			).status,
		).toBe(400);
		for (const key of ["short", "has:colon-key"])
			expect(
				(
					await h.app.request(path, {
						method: "POST",
						headers: { ...headers, "Idempotency-Key": key },
						body: JSON.stringify({ title: "図", scene }),
					})
				).status,
			).toBe(400);
		const created = await h.app.request(path, {
			method: "POST",
			headers: { ...headers, "Idempotency-Key": "test-create" },
			body: JSON.stringify({ title: "最初の保存", scene }),
		});
		expect(created.status).toBe(200);
		const { referenceId } = await created.json();
		expect(h.excalidraw!.list("main").map((r) => r.id)).toEqual([referenceId]);
		expect(
			(await h.app.request(path, { method: "PUT", headers, body: "{}" }))
				.status,
		).toBe(400);
		const bad = await h.app.request(path, {
			method: "PUT",
			headers: { ...headers, "Idempotency-Key": "test-malformed" },
			body: JSON.stringify({
				title: "図",
				expectedRevision: 1,
				scene: { elements: [], appState: {} },
			}),
		});
		expect(bad.status).toBe(400);
		expect((await bad.json()).error).toBe("invalid_excalidraw_input");
		const doc = await h.excalidraw!.document(s.id, AbortSignal.timeout(1000));
		f.failSave(true);
		const failed = await h.app.request(path, {
			method: "PUT",
			headers: { ...headers, "Idempotency-Key": "test-failure" },
			body: JSON.stringify({
				title: doc.title,
				scene: doc.scene,
				expectedRevision: doc.revision,
			}),
		});
		expect(failed.status).toBe(502);
		expect((await failed.json()).error).toBe("excalidraw_http_503");
		f.failSave(false);
		const remove = (conversationId: string) =>
			h.app.request(
				`/api/excalidraw/references/${referenceId}?conversationId=${conversationId}`,
				{ method: "DELETE", headers },
			);
		expect((await remove("other")).status).toBe(404);
		expect((await remove("main")).status).toBe(204);
		expect(h.excalidraw!.list("main")).toHaveLength(0);
	} finally {
		await h.close();
	}
});
