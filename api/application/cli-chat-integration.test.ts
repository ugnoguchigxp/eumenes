import { expect, test } from "bun:test";
import { createChatSession } from "../../cli/chat-session";
import { conversationClient } from "../../client/conversation";
import { dialogueClient } from "../../client/dialogue";
import { eventsClient } from "../../client/events";
import type { Transport } from "../../client/transport";
import { harness } from "./toolchain/toolchain.fixture";
import { waitFor } from "../infrastructure/wait-for";

function connect(app: Awaited<ReturnType<typeof harness>>["app"]) {
	const transport: Transport = {
		identity: "http://localhost",
		async call(path, init = {}) {
			const headers = new Headers(init.headers);
			headers.set(
				"authorization",
				"Bearer fixture-token-for-toolchain-browser",
			);
			const response = await app.request(
				new Request(new URL(path, "http://localhost"), { ...init, headers }),
			);
			if (!response.ok)
				throw new Error(
					`test_http_${response.status}: ${await response.text()}`,
				);
			return response;
		},
	};
	return {
		...conversationClient(transport),
		...dialogueClient(transport),
		...eventsClient(transport),
	};
}

// Exercise real HTTP handlers and SSE streams in memory: no listener or product server is started.
test("CLI and Web read the same persisted utterances and full answers through the existing APIs and change stream", async () => {
	const h = await harness({
		parentAnswer: "返事の全文です。\n二行目も共有します。",
	});
	const lifetime = new AbortController();
	const shown: string[] = [];
	const errors: string[] = [];
	const client = connect(h.app);
	const session = createChatSession({
		client,
		conversationId: "main",
		signal: lifetime.signal,
		message: (message) => shown.push(message.text),
		error: (text) => errors.push(text),
	});
	try {
		await session.start();
		await session.send("CLIからこんにちは");
		const web = await client.conversation("main");
		expect(web.messages.map((m) => m.text)).toEqual(shown);
		expect(shown).toContain("CLIからこんにちは");
		expect(shown).toContain("返事の全文です。\n二行目も共有します。");
		const webRun = await client.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "Webからこんにちは",
		});
		await client.watchRun(webRun.id, lifetime.signal, () => {});
		await waitFor(
			() => shown.includes("Webからこんにちは") && shown.length === 4,
		);
		expect(
			(await client.conversation("main")).messages.map((m) => m.text),
		).toEqual(shown);
		expect(errors).toEqual([]);
	} finally {
		lifetime.abort();
		session.stop();
		await h.close();
	}
}, 20000);

test("a CLI creation request executes an existing toolchain without rendering its artifact", async () => {
	const h = await harness({
		timers: true,
		announcement: "タイマーを作ります。",
	});
	const lifetime = new AbortController();
	const shown: string[] = [];
	const errors: string[] = [];
	const client = connect(h.app);
	const session = createChatSession({
		client,
		conversationId: "main",
		signal: lifetime.signal,
		message: (message) => shown.push(message.text),
		error: (text) => errors.push(text),
	});
	try {
		await session.start();
		expect(await session.send("3分タイマーを作って")).toBe("completed");
		expect(h.timers!.list().items).toMatchObject([
			{ durationSeconds: 180, state: "active" },
		]);
		expect((await client.conversation("main")).messages[0]?.text).toBe(
			"3分タイマーを作って",
		);
		expect((await client.runs("main"))[0]?.announcement).toBe(
			"タイマーを作ります。",
		);
		expect(shown).toEqual(["3分タイマーを作って", "タイマーを作ります。"]);
		expect(errors).toEqual([]);
	} finally {
		lifetime.abort();
		session.stop();
		await h.close();
	}
}, 20000);
