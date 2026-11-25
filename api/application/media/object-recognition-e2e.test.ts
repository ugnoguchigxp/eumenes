import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { objectRecognitionFixture } from "./object-recognition.fixture";
import { hash } from "../../domains/capabilities";
import { waitFor } from "../../infrastructure/wait-for";
import {
	assign,
	ask,
	assignmentAgenda,
	ended,
	executions,
	plannedBy,
	until,
} from "./assignment.fixture";

/** What the recognition command of each execution answered (the call that ran it, and its result). */
const commandResults = (h: { store: { read: Function } }) =>
	(
		h.store.read((db: import("bun:sqlite").Database) =>
			db
				.query(
					"SELECT call_id, result_json FROM object_recognition_execution_commands ORDER BY rowid",
				)
				.all(),
		) as Array<{ call_id: string; result_json: string }>
	).map((row) => ({ callId: row.call_id, ...JSON.parse(row.result_json) }));
test("authenticated upload → detection → stored source → chat attachment with detections; command package opens the artifact", async () => {
	const f = objectRecognitionFixture();
	const a = await assignmentAgenda({
		harness: {
			model: plannedBy({ other: f }),
			recognitionFetcher: f.fetcher,
		},
	});
	const h = a.h;
	try {
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-only-recognition-credential",
		});
		await a.start();
		await ask(
			a,
			"object-recognition.manage",
			"カメラの物体を調べる画面を開いて",
		);
		await until(a, () => ended(a));
		expect(executions(a)).toHaveLength(1);
		expect(f.stages).toEqual(["command"]);
		// The command ran as the assignment's own execution: its result is kept under its call.
		expect(commandResults(h)).toMatchObject([
			{ action: "open", state: "ready_for_input" },
		]);
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
		await waitFor(
			() => h.objectRecognition!.get("local:owner", id).state === "completed",
		);
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
		// "会話に追加" saves a pending chat attachment with the detections; nothing is sent.
		const before = h.conversation.get("main").messages.length;
		const attachment = await (
			await h.request(`/api/object-recognition/${id}/attachment`, {
				requestId: crypto.randomUUID(),
			})
		).json();
		expect(attachment.mime).toBe("image/png");
		expect(attachment.annotation).toMatchObject({
			source: "object-recognition",
			data: { captureSource: "file", image: { width: 320, height: 240 } },
		});
		expect(attachment.annotation.data.objects[0]).toEqual({
			label: "cup",
			box: [30, 40, 90, 150],
			score: 0.9,
		});
		expect(h.conversation.get("main").messages.length).toBe(before);
		// A client cannot make its own annotation through the chat upload.
		const plain = new FormData();
		plain.set(
			"file",
			new File([new Uint8Array(await f.bytes())], "plain.png", {
				type: "image/png",
			}),
		);
		plain.set("annotation", JSON.stringify({ source: "x", data: {} }));
		const uploaded = await h.app.request(
			`/api/conversations/main/attachments?requestId=${crypto.randomUUID()}`,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer fixture-token-for-toolchain-browser",
				},
				body: plain,
			},
		);
		if (uploaded.ok) expect((await uploaded.json()).annotation).toBeUndefined();
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
		await waitFor(
			() => h.objectRecognition!.get("local:owner", id).state === "completed",
		);
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

test("an agreed capture request: the screen's still and its detections become one user message, once", async () => {
	const f = objectRecognitionFixture({
		action: "capture",
		id: "",
		frameIndex: -1,
		source: "camera",
		question: "今日の服装を見てほしい",
	});
	const a = await assignmentAgenda({
		harness: {
			model: plannedBy({ other: f }),
			recognitionFetcher: f.fetcher,
		},
	});
	const h = a.h;
	try {
		await a.start();
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-only-recognition-credential",
		});
		await ask(a, "object-recognition.manage", "いいよ、撮って");
		await until(a, () => ended(a));
		const pending = await (
			await h.request("/api/object-recognition/handoffs?conversationId=ao")
		).json();
		// The handoff is the assignment's command call: the screen's still goes to it.
		const run = { id: commandResults(h)[0]!.callId };
		expect(pending).toMatchObject([
			{ id: run.id, source: "camera", state: "pending" },
		]);
		const id = crypto.randomUUID();
		const form = new FormData();
		form.append(
			"file",
			new File([new Uint8Array(await f.bytes())], "camera.png", {
				type: "image/png",
			}),
		);
		expect(
			(
				await h.app.request(
					`/api/object-recognition?requestId=${id}&conversationId=ao&origin=camera`,
					{
						method: "POST",
						headers: {
							Authorization: "Bearer fixture-token-for-toolchain-browser",
						},
						body: form,
					},
				)
			).status,
		).toBe(202);
		await waitFor(
			() => h.objectRecognition!.get("local:owner", id).state === "completed",
		);
		const send = () =>
			h.request(`/api/object-recognition/handoffs/${run.id}/send`, {
				recognitionId: id,
			});
		const sent = await (await send()).json();
		expect((await (await send()).json()).id).toBe(sent.id);
		const message = h.conversation
			.get("ao")
			.messages.find((m) => m.id === sent.inputMessageId);
		expect(message?.text).toBe("今日の服装を見てほしい");
		expect(message?.attachments?.[0]?.annotation).toMatchObject({
			source: "object-recognition",
			data: { captureSource: "camera", recognitionId: id },
		});
		// The assignment of the sent message asks to capture again, but that message already
		// carries the image: the host shows it instead of asking for another still.
		const words = {
			conversationId: "ao",
			messageId: sent.inputMessageId,
			runId: sent.id,
			request: message!.text,
			digest: hash(message!.text),
		};
		await a.h.dialogue.waitForTerminal(sent.id, { timeoutMs: 5000 });
		await assign(a, words, "object-recognition.manage");
		await until(a, () => ended(a, 2));
		expect(
			await (
				await h.request("/api/object-recognition/handoffs?conversationId=ao")
			).json(),
		).toEqual([]);
		expect(commandResults(h)[1]).toMatchObject({
			action: "capture",
			state: "already_attached",
		});
		const cancelled = await h.request(
			`/api/object-recognition/handoffs/${run.id}/cancel`,
			{},
		);
		expect((await cancelled.json()).state).toBe("sent");
	} finally {
		await h.close();
	}
});
