import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { objectRecognitionFixture } from "./object-recognition.fixture";
test("authenticated upload → detection → stored source → conversation; command package opens the artifact", async () => {
	const f = objectRecognitionFixture();
	const h = await harness({ model: f.model, recognitionFetcher: f.fetcher });
	try {
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-only-recognition-credential",
		});
		const raw = {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "カメラの物体を調べる画面を開いて",
		};
		const run = await (await h.request("/api/runs", raw)).json();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(f.stages).toEqual(["route", "command", "answer"]);
		expect(
			await (
				await h.request("/api/object-recognition/commands?conversationId=main")
			).json(),
		).toContain(run.id);
		expect(f.calls).toEqual([]);
		const id = crypto.randomUUID();
		const form = new FormData();
		form.append(
			"file",
			new File([new Uint8Array(await f.bytes())], "desk.png", {
				type: "image/png",
			}),
		);
		const path = `/api/object-recognition?requestId=${id}&conversationId=main`;
		expect(
			(await h.app.request(path, { method: "POST", body: form })).status,
		).toBe(401);
		const result = await h.app.request(path, {
			method: "POST",
			headers: { Authorization: "Bearer fixture-token-for-toolchain-browser" },
			body: form,
		});
		expect(result.status).toBe(202);
		for (
			let i = 0;
			i < 100 &&
			h.objectRecognition!.get("local:owner", id).state !== "completed";
			i++
		)
			await Bun.sleep(10);
		const saved = await (
			await h.request(`/api/object-recognition/${id}`)
		).json();
		expect(saved.state).toBe("completed");
		expect(saved.result.objects[0].box).toEqual([30, 40, 90, 150]);
		expect(
			(await h.app.request(`/api/object-recognition/${id}/content`)).status,
		).toBe(401);
		const content = await h.request(`/api/object-recognition/${id}/content`);
		expect(content.headers.get("content-type")).toBe("image/png");
		expect((await content.arrayBuffer()).byteLength).toBeGreaterThan(100);
		const incorporated = await (
			await h.request(`/api/object-recognition/${id}/conversation`, {
				requestId: crypto.randomUUID(),
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(incorporated.id, { timeoutMs: 5000 }))
				?.status,
		).toBe("completed");
		expect(
			h.conversation
				.get("main")
				.messages.some((m) => m.text.includes("cup [30, 40, 90, 150]")),
		).toBe(true);
		expect(JSON.stringify(saved)).not.toContain(
			"fixture-only-recognition-credential",
		);
		const settings = await (
			await h.request("/api/settings/object-recognition")
		).json();
		expect(settings.credentialConfigured).toBe(true);
		expect(settings.credential).toBeUndefined();
		expect(f.contexts.join("\n")).not.toContain(
			"fixture-only-recognition-credential",
		);
	} finally {
		await h.close();
	}
});

test("settings API switches recognition to the existing backend LARM token without leaking it or changing the endpoint", async () => {
	const f = objectRecognitionFixture();
	const token = "fixture-shared-larm-business-token";
	let authorized = false;
	const h = await harness({
		model: f.model,
		settingsEnv: { LARM_API_TOKEN: token },
		recognitionFetcher: (async (url, init) => {
			authorized =
				new Headers(init?.headers).get("Authorization") === `Bearer ${token}`;
			return f.fetcher(url, init);
		}) as typeof fetch,
	});
	try {
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-dedicated-recognition-token",
		});
		const change = await h.app.request("/api/settings/object-recognition", {
			method: "PUT",
			headers: {
				Authorization: "Bearer fixture-token-for-toolchain-browser",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ expectedRevision: 1, credentialSource: "larm" }),
		});
		expect(change.status).toBe(200);
		const status = await change.json();
		expect(status).toMatchObject({
			baseUrl: "http://127.0.0.1:18786",
			credentialSource: "larm",
			credentialConfigured: true,
		});
		expect(JSON.stringify(status)).not.toContain(token);
		const form = new FormData();
		form.append(
			"file",
			new File([new Uint8Array(await f.bytes())], "desk.png", {
				type: "image/png",
			}),
		);
		const id = crypto.randomUUID();
		await h.app.request(
			`/api/object-recognition?requestId=${id}&conversationId=main`,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer fixture-token-for-toolchain-browser",
				},
				body: form,
			},
		);
		for (
			let i = 0;
			i < 100 &&
			h.objectRecognition!.get("local:owner", id).state !== "completed";
			i++
		)
			await Bun.sleep(10);
		expect(authorized).toBe(true);
		expect(h.objectRecognition!.get("local:owner", id).state).toBe("completed");
		const bindings = h.store.read((db) =>
			db
				.query(
					"SELECT connection_json FROM object_recognition_inputs WHERE id=?",
				)
				.get(id),
		);
		expect(JSON.stringify(bindings)).not.toContain(token);
		expect(f.contexts.join("\n")).not.toContain(token);
	} finally {
		await h.close();
	}
});
