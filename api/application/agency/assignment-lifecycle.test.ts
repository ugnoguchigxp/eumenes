import { expect, test } from "bun:test";
import { hash } from "../../domains/capabilities";
import { waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";
import { agendaFixture, composeSay, type CallKind } from "./always-on.fixture";

/**
 * What an assignment (work the user asked a toolchain for) lives through besides its own run: a change of the agency's
 * settings, the unrelated words around it, a result whose request is no longer saved, and a report Live says.
 */
type Fixture = Awaited<ReturnType<typeof agendaFixture>>;

const said = (kind: CallKind) =>
	kind === "compose" ? composeSay("できました。") : undefined;

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

function assign(
	f: Fixture,
	source: Awaited<ReturnType<typeof userWords>>,
	revisionId?: string,
) {
	const found = f.h.store
		.read((db) => f.port.catalogInTransaction(db))
		.find((c) => c.revisionId.startsWith("toolchain:image.create@"))!;
	return f.host.dialoguePort.assign!({
		toolchainId: "image.create",
		revisionId: revisionId ?? found.revisionId,
		title: found.title,
		request: source.request,
		references: [],
		source,
	});
}

type Work = {
	root_id: string;
	ticket_id: string;
	execution_id: string | null;
	returned: number;
	revoked: number;
};
const works = (f: Fixture) =>
	f.h.store.read((db) =>
		db
			.query(
				"SELECT root_id,ticket_id,execution_id,returned,revoked FROM dialogue_agency_work ORDER BY created_at,root_id",
			)
			.all(),
	) as Work[];
const executions = (f: Fixture) => f.h.toolchain.agents.executions.list("ao");
const snapshot = (f: Fixture) => f.host.inspect("ao")!.snapshot;

const until = (f: Fixture, condition: () => boolean, timeout = 15_000) =>
	waitFor(
		async () => {
			await f.advance(1000);
			return condition();
		},
		{ timeout },
	);

test("a change of the agency's settings keeps the user's running assignment: its work goes on and its result is adopted", async () => {
	const gate = Promise.withResolvers<void>();
	const f = await agendaFixture({
		media: imageFixture("success", gate.promise),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(assign(f, source)).toMatchObject({ status: "accepted" });
		await until(f, () => works(f).some((w) => w.execution_id));
		const [work] = works(f);
		const epoch = f.h.store.read((db) => f.port.epochInTransaction(db, "ao"));
		// The settings the agenda host reads change: the host is made again (its digest differs).
		const config = f.h.settings.get();
		config.agency.interests = ["海"];
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: config.revision,
			settings: config,
			keys: [],
		});
		await f.restart();
		// The request, its item and its running work are all still there under the same epoch.
		expect(f.h.store.read((db) => f.port.epochInTransaction(db, "ao"))).toBe(
			epoch,
		);
		expect(works(f)).toEqual([work!]);
		expect(snapshot(f).tickets).toHaveLength(1);
		expect(snapshot(f).assignments).toHaveLength(1);
		expect(snapshot(f).agent.items.filter((i) => i.delegatedTo)).toHaveLength(
			1,
		);
		expect(executions(f)).toHaveLength(1);
		expect(executions(f)[0]!.status).not.toBe("cancelled");
		gate.resolve();
		await until(f, () => snapshot(f).notes.length === 1);
		expect(executions(f)[0]).toMatchObject({ status: "completed" });
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("a change of the agency's settings still revokes a checkpoint that holds no request of the user's", async () => {
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: said,
	});
	try {
		await f.start();
		await f.user("user-a");
		const epoch = f.h.store.read((db) => f.port.epochInTransaction(db, "ao"));
		const config = f.h.settings.get();
		config.agency.interests = ["海"];
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: config.revision,
			settings: config,
			keys: [],
		});
		await f.restart();
		expect(f.h.store.read((db) => f.port.epochInTransaction(db, "ao"))).toBe(
			epoch + 1,
		);
	} finally {
		await f.close();
	}
}, 30_000);

test("an assignment rests on the user's own words only: the words and memory around it neither end it nor are in its inputs", async () => {
	const gate = Promise.withResolvers<void>();
	const f = await agendaFixture({
		media: imageFixture("success", gate.promise),
		script: said,
	});
	try {
		await f.start();
		// Other words the agent has seen before the request.
		await f.user("user-before", "ao", "別の話をしていた");
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(assign(f, source)).toMatchObject({ status: "accepted" });
		await until(f, () => works(f).some((w) => w.execution_id));
		const own = f.h.store.read(
			(db) =>
				f.h.memory!.referenceInputs.captureInTransaction(db, {
					messageIds: [source.messageId],
				}).sources,
		);
		const [held] = snapshot(f).tickets;
		expect(held!.inputs).toEqual([...own]);
		expect(held!.refs).toEqual([source.messageId]);
		// The work's own record rests on those sources only.
		expect(
			JSON.parse(
				f.h.store.read(
					(db) =>
						db
							.query("SELECT source_refs_json AS s FROM dialogue_agency_work")
							.get() as { s: string },
				).s,
			),
		).toEqual([...own]);
		// Words that come later change nothing about it.
		await f.user("user-after", "ao", "もう一つ話す");
		await f.advance(1000);
		expect(works(f)[0]).toMatchObject({ revoked: 0, returned: 0 });
		expect(snapshot(f).tickets).toHaveLength(1);
		gate.resolve();
		await until(f, () => snapshot(f).notes.length === 1);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("the item of an assignment cites the words it was asked in, so forgetting them reaches it", async () => {
	const f = await agendaFixture({
		media: imageFixture("success", new Promise<void>(() => {})),
		script: said,
	});
	try {
		await f.start();
		// Other words are the agent's latest when the request arrives (it was asked in older words).
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		await f.user("user-later", "ao", "あとから別の話");
		expect(assign(f, source)).toMatchObject({ status: "accepted" });
		const item = f.host
			.inspect("ao")!
			.snapshot.agent.items.find((i) => i.delegatedTo)!;
		expect(item.refs).toEqual([source.messageId]);
	} finally {
		await f.close();
	}
}, 30_000);

test("a result whose assignment is no longer saved is discarded, never adopted under the agency's own grant", async () => {
	const gate = Promise.withResolvers<void>();
	const f = await agendaFixture({
		media: imageFixture("success", gate.promise),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(assign(f, source)).toMatchObject({ status: "accepted" });
		await until(f, () => works(f).some((w) => w.execution_id));
		// The saved request is gone (the ticket stays): nothing vouches for the result.
		await f.h.store.write((db) =>
			db
				.query(
					"UPDATE dialogue_agency_state SET snapshot_json=json_set(snapshot_json,'$.assignments',json('[]')) WHERE conversation_id='ao'",
				)
				.run(),
		);
		gate.resolve();
		await until(f, () => works(f).every((w) => w.returned === 1));
		expect(snapshot(f).notes).toHaveLength(0);
		// The execution is forgotten with its result.
		expect(executions(f)).toHaveLength(0);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);

test("an assignment cannot start under words other than the ones its request was saved with", async () => {
	const f = await agendaFixture({
		media: imageFixture("success", new Promise<void>(() => {})),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(assign(f, source)).toMatchObject({ status: "accepted" });
		await until(f, () => works(f).some((w) => w.execution_id));
		const [ticket] = snapshot(f).tickets;
		const saved = snapshot(f).assignments![0]!;
		const epoch = f.h.store.read((db) => f.port.epochInTransaction(db, "ao"));
		const start = (words: typeof saved.source) =>
			f.h.store.write((db) =>
				f.port.startInTransaction(db, {
					rootId: "agency:other:root",
					conversationId: "ao",
					epoch,
					ticketId: ticket!.id,
					question: ticket!.question,
					revisionId: ticket!.revisionId,
					deadline: f.now + 3_600_000,
					outboundIntervalMs: 0,
					sourceRefs: [...ticket!.inputs],
					assignment: true,
					references: ticket!.references ?? [],
					source: words,
				}),
			);
		await expect(
			start({ ...saved.source, request: "別の依頼" }),
		).rejects.toThrow("agency_origin_stale");
	} finally {
		await f.close();
	}
}, 30_000);

test("a start that is refused ends the assignment: the agent tells the user and nothing of it is held", async () => {
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: said,
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		// A capability that is not in the catalog: the start is refused.
		expect(assign(f, source, "toolchain:image.create@0")).toMatchObject({
			status: "accepted",
		});
		await until(f, () => snapshot(f).agent.items.every((i) => !i.delegatedTo));
		expect(snapshot(f).assignments).toEqual([]);
		expect(works(f)).toEqual([]);
	} finally {
		await f.close();
	}
}, 30_000);

test("a report a Live session says carries the resource chips on the words the session says", async () => {
	const routed: string[] = [];
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: said,
		// A Live session takes the line (it is not appended to the conversation by the agency).
		routeSpeech: (_db, _conversation, text) => {
			routed.push(text);
			return true;
		},
	});
	try {
		await f.start();
		const source = await userWords(f, "夕焼けの海の絵を描いて");
		expect(assign(f, source)).toMatchObject({ status: "accepted" });
		await until(f, () => routed.length === 1);
		expect(
			f.h.conversation
				.get("ao")
				.messages.some((m) => m.id.startsWith("agency:")),
		).toBe(false);
		// Live says it: its transcript is the message that shows the image.
		const said = "live-segment-1";
		await f.h.store.write((db) =>
			f.h.conversation.appendInTransaction(db, {
				id: said,
				conversationId: "ao",
				role: "assistant",
				text: "絵ができました。",
				runId: null,
				createdAt: new Date(f.now).toISOString(),
				attribution: {
					namespace: "live-voice",
					sourceId: said,
					displayName: "AI音声の文字起こし（再生範囲未確認）",
				},
			}),
		);
		const chips = async () =>
			(await (await f.h.request("/api/conversations/ao/resources")).json())
				.messages as Array<{ messageId: string }>;
		await waitFor(async () => {
			await f.advance(1000);
			return (await chips()).some((m) => m.messageId === said);
		});
		// Words of a session said later, when nothing is waiting, carry no chips of that report.
		const later = "live-segment-2";
		await f.h.store.write((db) =>
			f.h.conversation.appendInTransaction(db, {
				id: later,
				conversationId: "ao",
				role: "assistant",
				text: "ほかの話です。",
				runId: null,
				createdAt: new Date(f.now).toISOString(),
				attribution: {
					namespace: "live-voice",
					sourceId: later,
					displayName: "AI音声の文字起こし（再生範囲未確認）",
				},
			}),
		);
		await f.advance(1000);
		expect((await chips()).some((m) => m.messageId === later)).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);
