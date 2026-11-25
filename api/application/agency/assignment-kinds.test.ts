import { expect, test } from "bun:test";
import { hash } from "../../domains/capabilities";
import type { AssignmentDetails } from "../../domains/dialogue";
import type { LarmPort } from "../../domains/larm";
import { waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";
import { answerUtterance } from "../media/conversation-turn.fixture";
import { musicFixture } from "../media/music.fixture";
import { musicLibraryFixture } from "../media/music-library.fixture";
import {
	agendaFixture,
	composeSay,
	replyWith,
	type CallKind,
} from "./always-on.fixture";

/**
 * Every toolchain kind that is not instant and not a session starts as an agenda assignment (spec
 * toolchain-assignment-stage2-implementation-2026-11-25.md section 1): the user's words are the work's source, the
 * agent observes it, the reply answers or cancels it, and the agent's report line carries what it made.
 */
type Fixture = Awaited<ReturnType<typeof agendaFixture>>;

/**
 * The model of a conversation that asks for media: the conversation's own turns are answered in words (the user's
 * words are handed to a toolchain by the test, not by the conversation), and each toolchain's plan is the fixture
 * of that toolchain.
 */
function mediaModel(parts: {
	image?: ReturnType<typeof imageFixture>;
	music?: ReturnType<typeof musicFixture>;
	library?: ReturnType<typeof musicLibraryFixture>;
}): LarmPort {
	const base = [parts.image, parts.music, parts.library].find(Boolean)!.model;
	return {
		...base,
		answer: async (messages, signal, options) => {
			const talk = answerUtterance(
				options,
				messages,
				options?.onToolCalls,
				() => ({ text: "承知しました。" }),
			);
			if (talk !== undefined) return talk;
			const chosen = messages[1]?.content.includes("libraryTags")
				? parts.library
				: messages[0]!.content.includes("durationSeconds")
					? parts.music
					: parts.image;
			return (chosen?.model ?? base).answer(messages, signal, options);
		},
	};
}

/** The user's words as the conversation stores them (a run of their own), and the source an assignment of them has. */
async function userWords(f: Fixture, text: string) {
	const run = await f.h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "ao",
		text,
	});
	return {
		conversationId: "ao",
		messageId: run.inputMessageId,
		runId: run.id,
		request: text,
		digest: hash(text),
	};
}

function card(f: Fixture, toolchainId: string) {
	const found = f.h.store
		.read((db) => f.port.catalogInTransaction(db))
		.find((c) => c.revisionId.startsWith(`toolchain:${toolchainId}@`));
	if (!found) throw new Error(`fixture_toolchain_missing: ${toolchainId}`);
	return found;
}

/** What `delegate` hands the agent when the user asks a toolchain for something. */
function assign(
	f: Fixture,
	source: Awaited<ReturnType<typeof userWords>>,
	toolchainId: string,
	details?: AssignmentDetails,
	request = source.request,
) {
	const found = card(f, toolchainId);
	return f.host.dialoguePort.assign!({
		toolchainId,
		revisionId: found.revisionId,
		title: found.title,
		request,
		references: [],
		source,
		...(details ? { details } : {}),
	});
}

type Work = {
	root_id: string;
	toolchain_revision_id: string;
	execution_id: string | null;
	returned: number;
};
const works = (f: Fixture) =>
	f.h.store.read((db) =>
		db
			.query(
				"SELECT root_id,toolchain_revision_id,execution_id,returned FROM dialogue_agency_work ORDER BY created_at,root_id",
			)
			.all(),
	) as Work[];
const executions = (f: Fixture) => f.h.toolchain.agents.executions.list("ao");
const items = (f: Fixture) =>
	f.host.inspect("ao")!.snapshot.agent.items.filter((i) => i.delegatedTo);

/** Lets the agent's step run until the condition holds. */
const until = (f: Fixture, condition: () => boolean, timeout = 15_000) =>
	waitFor(
		async () => {
			await f.advance(1000);
			return condition();
		},
		{ timeout },
	);

const said = (kind: CallKind) =>
	kind === "compose" ? composeSay("できました。") : undefined;

test("an image assignment starts as the user's work, shows as being worked on, and its report line carries the image", async () => {
	const gate = Promise.withResolvers<void>();
	const image = imageFixture("success", gate.promise);
	const f = await agendaFixture({
		media: image,
		harness: { model: mediaModel({ image }) },
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(await assign(f, source, "image.create")).toMatchObject({
			status: "accepted",
		});
		await until(f, () => works(f).some((w) => w.execution_id));
		// The toolchain took the user's words as its source, and the agent shows the work as going on.
		expect(executions(f)).toHaveLength(1);
		expect(items(f)).toHaveLength(1);
		await f.user("user-b");
		const { seen } = await replyWith(f, [], {
			runId: "run-state",
			messageIds: ["user-b"],
		});
		expect(seen[0]![1]!.content).toContain("進めている");
		gate.resolve();
		await until(f, () => f.host.inspect("ao")!.snapshot.notes.length === 1);
		expect(executions(f)[0]).toMatchObject({ status: "completed" });
		// An ended assignment is no longer an open item: its report note holds what came of it.
		expect(items(f)).toHaveLength(0);
		// The agent reports on its own; the line is linked to the image the work made.
		const line = () =>
			f.h.conversation
				.get("ao")
				.messages.find((m) => m.id.startsWith("agency:"));
		await until(f, () => !!line());
		const resources = await (
			await f.h.request("/api/conversations/ao/resources")
		).json();
		expect(resources.resources.map((r: { kind: string }) => r.kind)).toContain(
			"image",
		);
		expect(resources.messages).toContainEqual(
			expect.objectContaining({ messageId: line()!.id }),
		);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("an image and a song asked in one utterance both start: one source, two assignments", async () => {
	const image = imageFixture("success");
	const music = musicFixture("success");
	const f = await agendaFixture({
		media: image,
		harness: {
			model: mediaModel({ image, music }),
			musicGateway: music.gateway,
		},
		catalog: (id) =>
			id.startsWith("toolchain:image.create@") ||
			id.startsWith("toolchain:music.create@"),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの絵と、落ち着く曲を作って");
		expect(await assign(f, source, "image.create")).toMatchObject({
			status: "accepted",
		});
		expect(await assign(f, source, "music.create")).toMatchObject({
			status: "accepted",
		});
		await until(f, () => works(f).filter((w) => w.execution_id).length === 2);
		expect(executions(f)).toHaveLength(2);
		expect(
			new Set(works(f).map((w) => w.toolchain_revision_id.split("@")[0])),
		).toEqual(new Set(["toolchain:image.create", "toolchain:music.create"]));
		await until(f, () => f.host.inspect("ao")!.snapshot.notes.length === 2);
		expect(executions(f).map((e) => e.status)).toEqual([
			"completed",
			"completed",
		]);
	} finally {
		await f.close();
	}
}, 30_000);

test("a command assignment's question reaches the agent, the user's answer goes to it through the assignment tool, and it completes", async () => {
	let translations = 0;
	const f = await agendaFixture({
		harness: {
			timers: true,
			// The first reading of the request asks which timer; with the answer it lists them.
			command: () =>
				JSON.stringify(
					++translations === 1
						? { action: "clarify", question: "どのタイマーを止めますか？" }
						: { action: "invoke", tool: "timer.list", arguments: {} },
				),
		},
		catalog: (id) => id.startsWith("toolchain:timers.manage@"),
		script: said,
	});
	try {
		await f.h.timers!.start({
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			durationSeconds: 180,
			label: "お茶",
		});
		await f.start();
		const source = await userWords(f, "タイマーを止めて");
		await assign(f, source, "timers.manage");
		await until(f, () => executions(f)[0]?.status === "waiting_user");
		await until(f, () => !!items(f)[0]?.question);
		const asked = items(f)[0]!;
		expect(asked.question).toBe("どのタイマーを止めますか？");
		// The user answers in words of their own; the reply hands the answer to the assignee.
		const answer = await userWords(f, "お茶のタイマーです");
		const { seen } = await replyWith(
			f,
			[
				{
					name: "assignment",
					arguments: { id: asked.id, action: "answer", text: "お茶のタイマー" },
				},
			],
			{ runId: "run-answer", messageIds: [answer.messageId] },
		);
		expect(
			seen[1]!.filter((m) => m.role === "tool").map((m) => m.content),
		).toEqual([`answered: ${card(f, "timers.manage").title}に回答を渡した`]);
		await until(f, () => executions(f)[0]?.status === "completed");
		await until(f, () => f.host.inspect("ao")!.snapshot.notes.length === 1);
		expect(translations).toBe(2);
		// An ended assignment is no longer an open item: its report note holds what came of it.
		expect(items(f)).toHaveLength(0);
	} finally {
		await f.close();
	}
}, 30_000);

test("a pipeline assignment gets the routed steps it was asked with", async () => {
	const packets: Array<{
		request: string;
		routedSteps?: Array<{ text: string; entry: string; after: number[] }>;
	}> = [];
	const first = "一つ目のタイマーを作って";
	const second = "二つ目のタイマーを作って";
	const f = await agendaFixture({
		harness: {
			pipelines: true,
			timers: true,
			compose: (messages) => {
				const packet = JSON.parse(messages.at(-1)!.content);
				packets.push(packet);
				return {
					status: "ready",
					definition: {
						request: packet.request,
						steps: [
							{
								id: "first",
								bundle: "timers.manage",
								task: "一つ目のタイマー",
								from: ["request"],
								result: "保存済みタイマー",
							},
							{
								id: "second",
								bundle: "timers.manage",
								task: "二つ目のタイマー",
								from: ["first"],
								result: "保存済みタイマー",
							},
						],
						output: { from: ["second"], deliver: "結果を表示" },
					},
				};
			},
			command: () =>
				JSON.stringify({
					action: "invoke",
					tool: "timer.start",
					arguments: { durationSeconds: 60 },
				}),
		},
		catalog: (id) =>
			id.startsWith("toolchain:pipeline.execute@") ||
			id.startsWith("toolchain:timers.manage@"),
		script: said,
	});
	try {
		await f.start();
		const request = `${first}、終わったら${second}`;
		const source = await userWords(f, request);
		const timers = card(f, "timers.manage");
		const routedSteps = [
			{
				text: first,
				entry: "timers.manage",
				revisionId: timers.revisionId,
				after: [],
			},
			{
				text: second,
				entry: "timers.manage",
				revisionId: timers.revisionId,
				after: [0],
			},
		];
		await assign(f, source, "pipeline.execute", { routedSteps });
		await until(f, () => packets.length > 0);
		expect(packets[0]).toMatchObject({
			request,
			routedSteps: [
				{ text: first, entry: "timers.manage", after: [] },
				{ text: second, entry: "timers.manage", after: [0] },
			],
		});
		await until(f, () => executions(f)[0]?.status === "completed");
	} finally {
		await f.close();
	}
}, 30_000);

test("a ticket whose start details were changed after the user asked is not started", async () => {
	const gate = Promise.withResolvers<void>();
	const image = imageFixture("success", gate.promise);
	const f = await agendaFixture({
		media: image,
		harness: { model: mediaModel({ image }) },
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		await assign(f, source, "image.create", { target: "a1" });
		await until(f, () => works(f).some((w) => w.execution_id));
		const ticket = f.host.inspect("ao")!.snapshot.tickets[0]!;
		expect(ticket).toMatchObject({
			assignment: true,
			details: { target: "a1" },
		});
		const start = (details: AssignmentDetails) =>
			f.h.store.write((db) =>
				f.port.startInTransaction(db, {
					rootId: crypto.randomUUID(),
					conversationId: "ao",
					epoch: f.port.epochInTransaction(db, "ao"),
					ticketId: ticket.id,
					revisionId: ticket.revisionId,
					question: ticket.question,
					deadline: Date.now() + 600_000,
					sourceRefs: ticket.inputs,
					outboundIntervalMs: 0,
					assignment: true,
					references: ticket.references ?? [],
					source,
					details,
				}),
			);
		await expect(start({ target: "a2" })).rejects.toThrow(
			"agency_origin_stale",
		);
		await expect(start({})).rejects.toThrow("agency_origin_stale");
		expect(executions(f)).toHaveLength(1);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("a playback assignment makes its playlist appear in the conversation's list", async () => {
	const library = musicLibraryFixture();
	const f = await agendaFixture({
		harness: {
			model: mediaModel({ library }),
			musicGateway: library.gateway,
		},
		catalog: (id) => id.startsWith("toolchain:music.library@"),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "明るいピアノの曲を聴きたい");
		await assign(f, source, "music.library");
		await until(f, () => executions(f)[0]?.status === "completed");
		const list = await (
			await f.h.request("/api/music/playlists?conversationId=ao")
		).json();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			runId: source.runId,
			state: "completed",
		});
		expect(list[0].trackIds.length).toBeGreaterThan(0);
	} finally {
		await f.close();
	}
}, 30_000);
