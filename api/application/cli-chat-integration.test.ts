import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createChatSession } from "../../cli/chat-session";
import { conversationClient } from "../../client/conversation";
import { dialogueClient } from "../../client/dialogue";
import { eventsClient } from "../../client/events";
import type { Transport } from "../../client/transport";
import { harness } from "./toolchain/toolchain.fixture";
import { assignmentFixture } from "./toolchain/assignment.fixture";
import { waitFor } from "../infrastructure/wait-for";
import { run as runCommand } from "../../cli/commands/run";
import type { CliArgs, CliIo } from "../../cli/commands/types";
import { registerDialogue } from "../domains/dialogue";
import {
	choice,
	setup as dialogueFixture,
} from "../domains/dialogue/test/generation.fixture";

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

test("CLI run --context and Web read the same selected input over the run API", async () => {
	const fixture = await dialogueFixture({
		debugDiagnostics: { enabled: () => true },
	});
	try {
		fixture.state.steps.push(
			choice({ choice: "none" }),
			{ calls: [{ name: "read_history", args: { query: "fixture" } }] },
			{ text: "完了しました。" },
		);
		const run = await fixture.say("履歴を確認してください。");
		const app = new Hono();
		registerDialogue(app, fixture.dialogue);
		const client = connect(app);
		const online = await client.runContext(run.id);
		const seen: unknown[] = [];
		const args = {
			command: "run",
			positional: [run.id],
			context: true,
			json: true,
		} as CliArgs;
		const io: CliIo = {
			client: client as CliIo["client"],
			show: (value) => {
				seen.push(value);
			},
			error: () => {},
		};
		expect(await runCommand(args, io)).toBe(0);
		expect(seen[0]).toEqual({
			...online,
			capture: await client.contextCapture(run.id, online.preferredId!),
		});
		expect(await runCommand({ ...args, contextCall: 1 }, io)).toBe(0);
		expect(seen[1]).toEqual({
			...online,
			capture: await client.contextCapture(run.id, online.captures[0]!.id),
		});
	} finally {
		await fixture.close();
	}
});

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

test("a CLI creation request is handed to the agent as an assignment and its report reaches the CLI without rendering an artifact", async () => {
	const f = await assignmentFixture({ timers: true });
	const lifetime = new AbortController();
	const shown: string[] = [];
	const errors: string[] = [];
	const client = connect(f.h.app);
	const session = createChatSession({
		client,
		conversationId: f.conversationId,
		signal: lifetime.signal,
		message: (message) => shown.push(message.text),
		error: (text) => errors.push(text),
	});
	try {
		await session.start();
		expect(await session.send("3分タイマーを作って")).toBe("completed");
		// What `delegate` hands the agent for those words: the work is the agent's assignment, not a conversation turn.
		const run = (await client.runs(f.conversationId))[0]!;
		await f.assignRun(run.id, "timers.manage");
		await f.settled();
		await f.until(() => f.notes().length === 1);
		expect(f.h.timers!.list().items).toMatchObject([
			{ durationSeconds: 180, state: "active" },
		]);
		expect(
			(await client.conversation(f.conversationId)).messages[0]?.text,
		).toBe("3分タイマーを作って");
		await f.until(() => f.reports().length > 0);
		await waitFor(() => shown.includes("できました。"));
		expect(shown[0]).toBe("3分タイマーを作って");
		expect(errors).toEqual([]);
	} finally {
		lifetime.abort();
		session.stop();
		await f.close();
	}
}, 20000);
