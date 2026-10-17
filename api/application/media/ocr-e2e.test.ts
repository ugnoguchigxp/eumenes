import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";
const result = {
	kind: "image",
	model: "ocr-fixture",
	width: 100,
	height: 100,
	text: "原文のまま",
	lines: [
		{
			text: "原文のまま",
			confidence: 0.82,
			polygon: [
				[1, 2],
				[31, 2],
				[31, 18],
				[1, 18],
			],
		},
	],
};
test.each(["LARM_API_TOKEN", "LARM_CONTROL_TOKEN"])(
	"OCR uses backend %s for authenticated upload without exposing the credential",
	async (tokenVariable) => {
		let posts = 0;
		const token = "fixture-shared-larm-token";
		const h = await harness({
			settingsEnv: { [tokenVariable]: token },
			ocrFetcher: (async (_url, init) => {
				posts++;
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					`Bearer ${token}`,
				);
				return Response.json(result);
			}) as typeof fetch,
		});
		try {
			const initial = await (await h.request("/api/settings/ocr")).json();
			expect(initial).toMatchObject({
				baseUrl: null,
				credentialConfigured: false,
				sharedCredentialAvailable: true,
			});
			expect(JSON.stringify(initial)).not.toContain(token);
			const unsafe = await h.app.request("/api/settings/ocr", {
				method: "PUT",
				headers: {
					authorization: "Bearer fixture-token-for-toolchain-browser",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					expectedRevision: 0,
					baseUrl: "https://attacker.example/",
				}),
			});
			expect(unsafe.status).toBe(400);
			const configuration = await h.app.request("/api/settings/ocr", {
				method: "PUT",
				headers: {
					authorization: "Bearer fixture-token-for-toolchain-browser",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					expectedRevision: 0,
					baseUrl: "http://127.0.0.1:18794/",
				}),
			});
			expect(configuration.status).toBe(200);
			const status = await configuration.json();
			expect(status.credentialConfigured).toBe(true);
			expect(status.sharedCredentialAvailable).toBe(true);
			expect(JSON.stringify(status)).not.toContain(token);
			const id = crypto.randomUUID();
			const form = new FormData();
			form.append("file", new File(["png"], "note.png", { type: "image/png" }));
			const path = `/api/ocr?conversationId=main&requestId=${id}`;
			expect(
				(await h.app.request(path, { method: "POST", body: form })).status,
			).toBe(401);
			const upload = await h.app.request(path, {
				method: "POST",
				headers: {
					authorization: "Bearer fixture-token-for-toolchain-browser",
				},
				body: form,
			});
			expect(upload.status).toBe(202);
			await waitFor(() => h.ocr!.get("local:owner", id).state === "completed");
			const saved = await (await h.request(`/api/ocr/${id}`)).json();
			expect(saved.state).toBe("completed");
			expect(saved.result.text).toBe("原文のまま");
			expect(posts).toBe(1);
			expect(
				(await h.request(`/api/ocr/${id}/content`)).headers.get("content-type"),
			).toBe("image/png");
			const incorporated = await (
				await h.request(`/api/ocr/${id}/conversation`, {
					requestId: crypto.randomUUID(),
					lineIndexes: [0],
				})
			).json();
			expect(
				(await h.dialogue.waitForTerminal(incorporated.id, { timeoutMs: 5000 }))
					?.status,
			).toBe("completed");
			expect(
				h.conversation
					.get("main")
					.messages.some((m) => m.text.includes("原文のまま")),
			).toBe(true);
			const list = await (
				await h.request("/api/ocr?conversationId=main")
			).json();
			expect(list).toHaveLength(1);
			const deleted = await h.app.request(`/api/ocr/${id}`, {
				method: "DELETE",
				headers: {
					authorization: "Bearer fixture-token-for-toolchain-browser",
				},
			});
			expect(deleted.status).toBe(204);
			expect(
				await (await h.request("/api/ocr?conversationId=main")).json(),
			).toHaveLength(0);
		} finally {
			await h.close();
		}
	},
);
