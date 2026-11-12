import { expect, test } from "bun:test";
import { ADDED_WORDS_MARK } from "eumenes-agency/agenda";
import {
	agendaFixture,
	composeSay,
	planNothing,
	replyWith,
	type CallKind,
} from "./always-on.fixture";
import { agendaReplyRules } from "./always-on-system";
import { agencyReplyParts } from "./system-context";
import { researchRevision } from "./always-on-flow";
import { noteFromResult } from "./always-on-memory";
import { agendaClock } from "./always-on-scope";
import type { AgendaHostSnapshot } from "../../domains/dialogue";
import { createSwitchingAgencyHost } from "./switching-host";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";

const planResearch = (ref: string) => ({
	add: [
		{
			kind: "research",
			text: "fixture independent picture",
			refs: [ref],
			value: 5,
			reason: "fixture",
			topic: "picture",
		},
	],
	drop: [],
	focus: "picture",
});

const agencyMessages = (f: Awaited<ReturnType<typeof agendaFixture>>) =>
	f.h.conversation
		.get("ao")
		.messages.filter(
			(m) => m.role === "assistant" && m.id.startsWith("agency:"),
		);

test("a user line becomes a plan, a research, a note and the agent's own speech with an agency id", async () => {
	const media = imageFixture("success");
	let planned = false;
	const f = await agendaFixture({
		media,
		script: (kind: CallKind, request) => {
			if (kind === "plan" && !planned && request.prompt.includes("user-a")) {
				planned = true;
				return planResearch("user-a");
			}
			if (kind === "compose") return composeSay("fixture result ready");
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		// The plan became a research ticket: the ledger holds the work and the checkpoint its ticket.
		await waitFor(
			() => f.h.toolchain.agents.executions.list("ao").length === 1,
		);
		const snapshot = () => f.host.inspect("ao")!.snapshot;
		// The result comes back through the ledger as a note.
		await waitFor(() => snapshot().notes.length === 1);
		expect(snapshot().tickets).toHaveLength(0);
		expect(snapshot().notes[0]!.ticketId).toBeTruthy();
		// The note is kept as a Markdown document as it arrives, without anyone asking to see it.
		const [note] = snapshot().notes;
		await waitFor(() => f.documents.started.length === 1);
		expect(f.documents.started).toEqual([
			{ id: `doc-${note!.id}`, title: note!.title, markdown: note!.markdown },
		]);
		// The note is told to the user: own speech, delivered with the agency id.
		for (let i = 0; i < 20 && agencyMessages(f).length === 0; i++)
			await f.advance(15_000);
		const spoken = agencyMessages(f);
		expect(spoken).toHaveLength(1);
		expect(spoken[0]!.text).toBe("fixture result ready");
		expect(spoken[0]!.id).toStartWith("agency:");
		expect(f.host.status("ao").idle?.unanswered).toBe(1);
		// A restart brings the note back and asks for its document again: the same document, made once.
		f.documents.started.length = 0;
		await f.restart();
		await waitFor(() => f.documents.started.length === 1);
		expect(f.documents.started[0]!.id).toBe(`doc-${note!.id}`);
	} finally {
		await f.close();
	}
});

const planTalk = (ref: string) => ({
	add: [
		{
			kind: "talk",
			text: "fixture own thought",
			refs: [ref],
			value: 4,
			reason: "fixture",
			topic: "thought",
		},
	],
	drop: [],
	focus: "thought",
});

/** The pace of the agent's own speech, in the fixture's clock: advance until it has spoken. */
async function untilSpoken(f: Awaited<ReturnType<typeof agendaFixture>>) {
	for (let i = 0; i < 20 && agencyMessages(f).length === 0; i++)
		await f.advance(15_000);
}

test("typing, a foreground answer and a reply being made hold the agent's thinking and speech", async () => {
	let planned = false;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planTalk("user-a");
			}
			if (kind === "compose") return composeSay("fixture own speech");
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		const report = {
			screenId: crypto.randomUUID(),
			revision: 1,
			sentAt: Date.now(),
			typing: true,
			playing: false,
			visible: true,
		};
		await f.host.attend("ao", report);
		// The lease of a screen lasts 45 s.
		await f.advance(30_000);
		expect(f.requests).toHaveLength(0);
		expect(f.host.status("ao").idle?.blockedBy).toBe("busy");
		f.setBusy(true);
		await f.host.attend("ao", {
			...report,
			revision: 2,
			sentAt: f.now,
			typing: false,
		});
		await f.advance(60_000);
		expect(f.requests).toHaveLength(0);
		f.setBusy(false);
		await f.advance(1000);
		await waitFor(() => f.requests.length >= 1);
		await untilSpoken(f);
		expect(agencyMessages(f).map((m) => m.text)).toEqual([
			"fixture own speech",
		]);
		// Typing again holds the next line.
		await f.host.attend("ao", {
			...report,
			revision: 3,
			sentAt: f.now,
			typing: true,
		});
		const count = f.requests.length;
		await f.advance(30_000);
		expect(f.requests).toHaveLength(count);
	} finally {
		await f.close();
	}
});

test("research the reply asked for starts while the user is typing or answered; the plan and own speech still wait", async () => {
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: (kind: CallKind) => (kind === "plan" ? planNothing() : undefined),
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.host.attend("ao", {
			screenId: crypto.randomUUID(),
			revision: 1,
			sentAt: Date.now(),
			typing: true,
			playing: false,
			visible: true,
		});
		f.setBusy(true);
		await replyWith(f, [
			{
				name: "start_preparation",
				arguments: { request: "fixture asked research", askedByUser: true },
			},
		]);
		await f.advance(1000);
		// The request is saved first; its step follows on the next timer.
		await f.advance(1000);
		await waitFor(
			() => f.h.toolchain.agents.executions.list("ao").length === 1,
		);
		expect(f.host.status("ao").idle?.blockedBy).toBe("busy");
		// Only the check before the research ran: the plan is held, and the step is not run over and over.
		expect(f.calls("plan")).toHaveLength(0);
		const count = f.requests.length;
		await f.advance(20_000);
		expect(f.calls("plan")).toHaveLength(0);
		expect(f.requests).toHaveLength(count);
	} finally {
		await f.close();
	}
});

test("a Live handoff is a proposal the voice session takes: no message is appended by the agency", async () => {
	let planned = false;
	let origin: { id: string } | undefined;
	const f = await agendaFixture({
		routeSpeech: (_db, _conversationId, _text, from) => {
			origin = from;
			return true;
		},
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planTalk("user-a");
			}
			return kind === "compose" ? composeSay("fixture proposal") : undefined;
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		for (let i = 0; i < 20 && f.host.status("ao").idle?.unanswered === 0; i++)
			await f.advance(15_000);
		expect(f.host.status("ao").idle?.unanswered).toBe(1);
		expect(agencyMessages(f)).toHaveLength(0);
		// The session asks for the line's input when it speaks it: a complete one, with the `agency:` id.
		expect(origin?.id).toStartWith("agency:");
		const input = f.h.store.read((db) =>
			f.host.dialoguePort.inputForMessageInTransaction!(db, origin!.id),
		);
		expect(input?.complete).toBe(true);
	} finally {
		await f.close();
	}
});

test("the user's words call off the plan out and speech written for older words is not said", async () => {
	const pending = Promise.withResolvers<unknown>();
	const f = await agendaFixture({
		script: (kind: CallKind, _request, n) =>
			kind === "plan" && n === 1
				? pending.promise
				: kind === "compose"
					? composeSay("stale speech")
					: undefined,
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => f.requests.length === 1);
		await f.user("user-b");
		expect(f.signals[0]!.aborted).toBe(true);
		pending.resolve(planTalk("user-a"));
		await f.advance(300_000);
		expect(agencyMessages(f).some((m) => m.text === "stale speech")).toBe(
			false,
		);
	} finally {
		pending.resolve(planNothing());
		await f.close();
	}
});

test("a corrected line replaces the old words in what the agent plans from", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => f.requests.length === 1 && !f.host.status("ao").busy);
		await f.h.conversation.correct({
			messageId: "user-a",
			text: "fixture corrected words",
		});
		await settle();
		await f.advance(1000);
		await waitFor(() => f.requests.length === 2);
		expect(f.requests[1]!.prompt).toContain("fixture corrected words");
		expect(f.requests[1]!.prompt).not.toContain("fixture user-a");
	} finally {
		await f.close();
	}
});

test("forgetting in one conversation leaves another conversation's plan running", async () => {
	const pending = Promise.withResolvers<unknown>();
	const f = await agendaFixture({
		script: (kind: CallKind) => (kind === "plan" ? pending.promise : undefined),
	});
	try {
		await f.start();
		await f.user("a-source");
		await f.user("b-source", "b");
		await f.host.attend("b");
		await f.advance(1000);
		await waitFor(() => f.requests.length === 1);
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["a-source"],
			itemIds: [],
		});
		expect(f.signals[0]!.aborted).toBe(false);
		pending.resolve(planNothing());
		await waitFor(() => !f.host.status("b").busy && f.host.status("b").tracked);
		await f.restart();
		expect(f.host.inspect("b")).not.toBeNull();
	} finally {
		pending.resolve(planNothing());
		await f.close();
	}
});

test("the reply's system holds the package's rules for the agenda, with the tools the host offers", async () => {
	const f = await agendaFixture();
	try {
		const base = f.host.conversationAgent.system().base;
		expect(base).toContain(agendaReplyRules());
		expect(base).toContain("start_preparation");
		expect(base).toContain("read_note");
		// Eumenes' own persona and emotion rules stay outside the package's span.
		expect(base).not.toContain("【気持ちの絵文字】");
	} finally {
		await f.close();
	}
});

test("a reply sees the agent's state, reads a note, asks for research and shows the note through the agent's tools", async () => {
	let planned = false;
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planResearch("user-a");
			}
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => f.host.inspect("ao")!.snapshot.notes.length === 1);
		const note = f.host.inspect("ao")!.snapshot.notes[0]!;
		await f.user("user-b");
		const { seen } = await replyWith(
			f,
			[
				{ name: "read_note", arguments: { id: note.id } },
				{
					name: "start_preparation",
					arguments: { request: "fixture follow-up", askedByUser: true },
				},
				{ name: "show_note", arguments: { id: note.id } },
			],
			{ runId: "run-2", messageIds: ["user-b"] },
		);
		// The first model call: the system, the agent's state before the user's last message.
		expect(seen[0]!.map((m) => m.role)).toEqual(["system", "user", "user"]);
		expect(seen[0]![1]!.content).toStartWith("<あなたの今の状態");
		expect(seen[0]![1]!.content).toContain(note.id);
		expect(seen[0]![2]!.content).toBe("## User\nfixture user");
		// The second: what the three tools answered.
		const tools = seen[1]!.filter((m) => m.role === "tool");
		expect(tools).toHaveLength(3);
		expect(tools[0]!.content).toContain("<メモ");
		expect(tools[0]!.content).toContain(note.title);
		expect(tools[1]!.content).toMatch(/^(accepted|queued)/u);
		expect(tools[2]!.content).toStartWith("shown");
		expect(
			f.host
				.inspect("ao")!
				.snapshot.agent.items.some(
					(i) => i.text === "fixture follow-up" && i.requested,
				),
		).toBe(true);
		// The note is shown once the reply is adopted (its message appears): it becomes a document of the Markdown
		// domain, carried by one message per reply and note, never an `agency:` line, and kept out of what the model
		// is told and what memory learns from. The note's text is in the document, not in the conversation.
		const shownNotes = () =>
		noteSavingPolls: 2,
			f.h.conversation
				.get("ao")
				.messages.filter((m) => m.id.startsWith("agency-note:"));
		expect(shownNotes()).toHaveLength(0);
		const adopt = async () => {
			await f.h.store.write((db) =>
				f.h.conversation.appendInTransaction(db, {
					id: "answer-2",
					conversationId: "ao",
					role: "assistant",
					text: "fixture answer",
					runId: "run-2",
					createdAt: new Date(f.now).toISOString(),
				}),
			);
			await settle();
		};
		await adopt();
		await waitFor(() => shownNotes().length === 1);
		expect(shownNotes()[0]!.text).toBe(
			[note.title, note.summary].filter(Boolean).join("\n"),
		);
		// Every note is a document (the one shown, and those nobody asked to see); only the shown one is linked.
		expect(f.documents.started.map((d) => d.id).sort()).toEqual(
			f.host
				.inspect("ao")!
				.snapshot.notes.map((n) => `doc-${n.id}`)
				.sort(),
		);
		expect(f.documents.started).toContainEqual({
			id: `doc-${note.id}`,
			title: note.title,
			markdown: note.markdown,
		});
		expect(f.documents.links).toEqual([
			{
				messageId: shownNotes()[0]!.id,
				uri: `eumenes://markdown.document/generated-doc-${note.id}`,
				label: note.title,
			},
		]);
		expect(
			f.h.store.read((db) =>
				f.deps.memory.isBlockedInTransaction!(db, shownNotes()[0]!.id),
			),
		).toBe(true);
		expect(shownNotes()[0]!.id).toEndWith(`:run-2:${note.id}`);
	} finally {
		await f.close();
	}
});

/** A reply whose model calls are scripted: `onCall` may do things (the user typing) before a call answers. */
async function steered(
	f: Awaited<ReturnType<typeof agendaFixture>>,
	onCall: (n: number) => Promise<void>,
	runId = "run-steer",
	host: Pick<typeof f.host, "conversationAgent"> = f.host,
) {
	let call = 0;
	const seen: Array<{ role: string; content: string }[]> = [];
	await host.conversationAgent.respond({
		run: { conversationId: "ao", runId, messageIds: ["user-a"] },
		messages: [
			{ role: "system", content: "fixture system" },
			{ role: "user", content: "## User\nfixture user-a" },
		],
		chat: {
			async complete(request) {
				call++;
				seen.push(request.messages.map((m) => ({ ...m })));
				await onCall(call);
				return call === 1
					? {
							text: "",
							toolCalls: [
								{
									id: "c1",
									name: "set_quiet",
									arguments: JSON.stringify({
										scope: "speech",
										kind: "said",
										minutes: 1,
									}),
								},
							],
						}
					: { text: "fixture answer", toolCalls: [] };
		// The document is still being saved: nothing is shown yet.
		await f.advance(500);
		expect(shownNotes()).toHaveLength(0);
		await f.advance(500);
			},
		},
		tools: { tools: [], call: async () => ({ content: "host" }) },
		signal: new AbortController().signal,
		onDelta: () => {},
		maxToolCalls: 0,
	});
	return seen;
}

test("words sent while a reply is written reach its next model call and are answered by that reply", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		const seen = await steered(f, async (n) => {
			// The user writes during the first model call (the tool call follows) and again during the last.
			if (n === 1) await f.user("user-b", "ao", "fixture steer words");
			if (n === 2) await f.user("user-c", "ao", "fixture too late");
		});
		expect(seen).toHaveLength(2);
		expect(
			seen[0]!.some((m) => m.content.includes("fixture steer words")),
		).toBe(false);
		const second = seen[1]!;
		const given = second.find((m) => m.content.includes("fixture steer words"));
		expect(given?.role).toBe("user");
		expect(given?.content).toStartWith(ADDED_WORDS_MARK);
		// The words sent during the last call were not given: they get a reply of their own.
		expect(second.some((m) => m.content.includes("fixture too late"))).toBe(
			false,
		);
		const taken = f.h.store.read((db) =>
			f.host.dialoguePort.steeredInTransaction!(db, "run-steer"),
		);
		expect(taken).toEqual(["user-b"]);
	} finally {
		await f.close();
	}
});

test("without a steering inbox the words wait for a reply of their own", async () => {
	const f = await agendaFixture({ steering: false });
	try {
		await f.start();
		await f.user("user-a");
		const seen = await steered(f, async (n) => {
			if (n === 1) await f.user("user-b", "ao", "fixture steer words");
		});
		expect(
			seen[1]!.some((m) => m.content.includes("fixture steer words")),
		).toBe(false);
		expect(
			f.h.store.read((db) =>
				f.host.dialoguePort.steeredInTransaction!(db, "run-steer"),
			),
		).toEqual([]);
	} finally {
		await f.close();
		await settle();
	}
});

test("words a forgotten message left are not given to a reply", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		const seen = await steered(f, async (n) => {
			if (n === 1) {
				await f.user("user-b", "ao", "fixture steer words");
				await f.h.memory!.forget({
					conversationId: "ao",
					messageIds: ["user-b"],
					itemIds: [],
				});
			}
		});
		expect(
			seen[1]!.some((m) => m.content.includes("fixture steer words")),
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("the switching host forwards what a steered reply took, so the settle sees it", async () => {
	const f = await agendaFixture();
	const host = createSwitchingAgencyHost(f.deps);
	try {
		await host.recover();
		host.start();
		await host.attend("ao");
		await f.user("user-a");
		await steered(
			f,
			async (n) => {
				if (n === 1) await f.user("user-b", "ao", "fixture steer words");
			},
			"run-switch",
			host,
		);
		expect(
			f.h.store.read((db) =>
				host.dialoguePort.steeredInTransaction!(db, "run-switch"),
			),
		).toEqual(["user-b"]);
	} finally {
		await host.close();
		await f.close();
	}
});

test("words that are not the user's own (a scheduled prompt) are not given to a reply", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		const seen = await steered(f, async (n) => {
			if (n === 1) {
				await f.user("user-sched", "ao", "fixture scheduled prompt");
				await f.h.store.write((db) =>
					f.h.memory!.blockMessagesInTransaction(db, {
						conversationId: "ao",
						messageIds: ["user-sched"],
						reason: "scheduled_prompt",
					}),
				);
			}
		});
		expect(
			seen[1]!.some((m) => m.content.includes("fixture scheduled prompt")),
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("a reply is given the agent's state and tools whatever turn it answers, and its input rests on what it was given", async () => {
	const media = imageFixture("success");
	let planned = false;
	const f = await agendaFixture({
		media,
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planResearch("user-a");
			}
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => f.host.inspect("ao")!.snapshot.notes.length === 1);
		// A turn that answers a notice, not the user's words: no message ids, still the state and the tools.
		const { seen, offered } = await replyWith(f, [], {
			runId: "run-notice",
			messageIds: [],
		});
		expect(seen[0]![1]!.content).toStartWith("<あなたの今の状態");
		expect(offered[0]).toEqual(
			expect.arrayContaining(["start_preparation", "read_note", "set_quiet"]),
		);
		// What it was given rests in its input, complete while the note's sources stand.
		const given = () =>
			f.h.store.read((db) =>
				f.host.dialoguePort.replyInputInTransaction!(db, "run-notice"),
			);
		expect(given()?.complete).toBe(true);
		expect(given()?.sources).toContain("user-a");
		// Forgotten meanwhile: the reply is not adopted over it.
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		expect(given()?.complete).toBe(false);
	} finally {
		await f.close();
	}
});

test("the reply's system holds the agenda's rules only where the agenda serves the reply", async () => {
	const f = await agendaFixture();
	try {
		const settings = f.h.settings.get().agency;
		expect(agencyReplyParts(settings, true).base).toContain(
			"start_preparation",
		);
		expect(agencyReplyParts(settings, false).base).not.toContain(
			"start_preparation",
		);
		const host = createSwitchingAgencyHost(f.deps);
		expect(host.conversationAgent.system().base).toContain("start_preparation");
		await host.close();
	} finally {
		await f.close();
	}
});

test("own speech rests on the user's recent words and the memory the model saw, not only on the line it cites", async () => {
	let planned = false;
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planTalk("user-a");
			}
			return kind === "compose" ? composeSay("fixture own speech") : undefined;
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.user("user-b");
		await untilSpoken(f);
		const spoken = agencyMessages(f);
		expect(spoken).toHaveLength(1);
		const input = f.h.store.read((db) =>
			f.deps.memory.referenceInputs!.readMessageInTransaction(
				db,
				spoken[0]!.id,
			),
		);
		// The plan cited user-a; the model also saw user-b.
		expect(input?.sources).toContain("user-b");
		const current = () =>
			f.h.store.read((db) =>
				f.deps.memory.referenceInputs!.isCurrentInTransaction(db, input!),
			);
		expect(current()).toBe(true);
		// Forgetting a line the model saw reaches the speech written over it.
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-b"],
			itemIds: [],
		});
		expect(current()).toBe(false);
	} finally {
		await f.close();
	}
});

test("research runs on the web note capability only, never an unrelated one (nor the deep web research)", () => {
	const deps = {} as Parameters<typeof researchRevision>[0];
	const free = (revisionId: string, effect = "read") => ({
		revisionId,
		requiresApproval: false,
		effect,
	});
	expect(
		researchRevision(deps, [
			free("toolchain:weather.forecast@1"),
			free("toolchain:image.create@1", "create"),
		]),
	).toBeUndefined();
	expect(
		researchRevision(deps, [
			free("toolchain:weather.forecast@1"),
			free("toolchain:web.research@7"),
			free("toolchain:web.search@11"),
			free("toolchain:web.note@1"),
		]),
	).toBe("toolchain:web.note@1");
	expect(
		researchRevision(deps, [
			free("toolchain:web.research@7"),
			free("toolchain:web.search@11"),
		]),
	).toBeUndefined();
	expect(
		researchRevision(deps, [
			{ revisionId: "toolchain:web.note@1", requiresApproval: true },
		]),
	).toBeUndefined();
});

test("the agenda's research is not counted against the daily and concurrent limits of actions", async () => {
	const media = imageFixture("success");
	const topics = ["天気の調査", "株価の確認", "料理の作り方"];
	let n = 0;
	const f = await agendaFixture({
		media,
		script: (kind: CallKind, request) => {
			if (kind === "plan") {
				// The newest of the user's lines the plan was shown.
				const user = topics.reduce(
					(last, _, i) => (request.prompt.includes(`user-${i}`) ? i : last),
					-1,
				);
				if (user >= 0 && n === user) {
					n++;
					return {
						add: [
							{
								kind: "research",
								text: topics[user]!,
								refs: [`user-${user}`],
								value: 5,
								reason: "fixture",
								topic: topics[user]!,
							},
						],
						drop: [],
						focus: topics[user]!,
					};
				}
				return planNothing();
			}
			return undefined;
		},
	});
	try {
		// The limits of actions: one a day, one at a time. The F host's actions keep them.
		const settings = f.h.settings.get();
		settings.agency.actions = {
			enabled: true,
			maxConcurrent: 1,
			dailyLimit: 1,
		};
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		await f.start();
		for (let i = 0; i < topics.length; i++) {
			// Quiet between researches: no step is out when the next words come.
			await waitFor(async () => {
				await f.advance(1000);
				return !f.host.status("ao").busy;
			});
			await f.user(`user-${i}`);
			await waitFor(async () => {
				await f.advance(1000);
				return f.host.inspect("ao")!.snapshot.notes.length === i + 1;
			}).catch(() => {
				throw new Error(`research_${i}: ${f.kinds.join(",")}`);
			});
		}
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(3);
	} finally {
		await f.close();
	}
}, 30_000);

test("a result without anything to read is a failed research, and the addresses added for the researcher are not in a title", () => {
	const ticket = {
		id: "t1",
		itemId: "a1",
		agentTicketId: "t1",
		revisionId: "toolchain:web.research@7",
		question:
			"鎌倉の紫陽花の見頃を調べる\n相手が示したURL: https://example.com/kamakura",
		at: 0,
		refs: ["user-a"],
		inputs: [],
	};
	const note = (result: unknown) =>
		noteFromResult({
			id: "n1",
			ticket,
			summary: JSON.stringify(result),
			at: 1,
		});
	expect(
		note({
			status: "partial",
			summary: "調査を完了できませんでした。",
			fulfilled: [],
			missing: ["見頃"],
		}),
	).toBeNull();
	const done = note({
		status: "completed",
		summary: "見頃は6月中旬です。",
		answer: "見頃は6月中旬です。",
	});
	expect(done?.title).toBe("鎌倉の紫陽花の見頃を調べる");
	expect(done?.title).not.toContain("URL");
	expect(
		note({
			status: "partial",
			summary: "",
			claims: [{ text: "6月中旬", status: "verified" }],
		}),
	).not.toBeNull();
});

test("the clock is the CLI's: Japan time with the weekday, and the reply is given the same", () => {
	expect(agendaClock(Date.UTC(2026, 10, 11, 5, 2))).toBe(
		"2026/11/11(水) 14:02",
	);
});

test("the agenda's reply facts let it start research; the host's own fact rules stay where the agenda does not serve", async () => {
	const f = await agendaFixture();
	try {
		const settings = f.h.settings.get().agency;
		const served = agencyReplyParts(settings, true);
		expect(served.facts).toContain("start_preparation");
		expect(served.facts).not.toContain("Webで調べること");
		expect(served.base).not.toContain("許可された読取りで確かめます");
		expect(agencyReplyParts(settings, false).facts).toBeUndefined();
	} finally {
		await f.close();
	}
});

test("the profile is written behind the talk, kept in the checkpoint, given to the reply, and forgotten with its words", async () => {
	const f = await agendaFixture({
		script: (kind: CallKind) =>
			kind === "profile"
				? {
						ops: [
							{
								op: "add",
								section: "plans",
								id: null,
								text: "来月、箱根へ一泊の温泉旅行を考えている",
								evidence: ["user-a"],
							},
						],
					}
				: undefined,
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "来月、箱根に温泉旅行に行こうと思ってる");
		await f.assistant("answer-a", "いいですね。", "ao");
		await waitFor(() => !!f.host.inspect("ao")!.snapshot.profile?.markdown);
		const note = () => f.host.inspect("ao")!.snapshot.profile;
		expect(note()!.markdown).toContain("箱根へ一泊");
		expect(f.kinds).toContain("profile");
		// The reply is given it (plans), and its input rests on the words it was written from.
		const { seen } = await replyWith(f, [], {
			runId: "run-p",
			messageIds: ["user-b"],
		});
		expect(seen[0]![1]!.content).toContain("箱根へ一泊");
		await f.restart();
		expect(note()!.markdown).toContain("箱根へ一泊");
		// Forgetting the words takes the note back to before them.
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		expect(note()?.markdown ?? "").not.toContain("箱根へ一泊");
		await f.restart();
		expect(note()?.markdown ?? "").not.toContain("箱根へ一泊");
	} finally {
		await f.close();
	}
});

test("a sentence said before a tool and again after is in the reply once", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		const reply = await f.host.conversationAgent.respond({
			run: { conversationId: "ao", runId: "run-d", messageIds: ["user-a"] },
			messages: [
				{ role: "system", content: "fixture system" },
				{ role: "user", content: "## User\nfixture user" },
			],
			chat: {
				async complete() {
					return {
						text: "いいですね。いいですね。続けましょう。",
						toolCalls: [],
					};
				},
			},
			tools: { tools: [], call: async () => ({ content: "host" }) },
			signal: new AbortController().signal,
			onDelta: () => {},
			maxToolCalls: 0,
		});
		expect(reply.text).toBe("いいですね。続けましょう。");
	} finally {
		await f.close();
	}
});

test("a reply of the router (no agenda reply behind it) is observed as the agent's reply and the plan looks again", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => f.requests.length === 1 && !f.host.status("ao").busy);
		await f.h.store.write((db) =>
			f.h.conversation.appendInTransaction(db, {
				id: "routed-answer",
				conversationId: "ao",
				role: "assistant",
				text: "fixture routed announcement",
				runId: "run-routed",
				createdAt: new Date(f.now).toISOString(),
			}),
		);
		await settle();
		await f.advance(1000);
		await waitFor(() => f.calls("plan").length === 2);
		expect(f.calls("plan")[1]!.prompt).toContain("fixture routed announcement");
	} finally {
		await f.close();
	}
});

test("a reply to a notice keeps four tool calls and offers no question; a failed reply is news to the plan", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => f.requests.length === 1 && !f.host.status("ao").busy);
		const quiet = {
			name: "set_quiet",
			arguments: { scope: "speech", kind: "said", minutes: 1 },
		};
		const { seen } = await replyWith(f, [quiet, quiet, quiet, quiet], {
			runId: "run-n",
			messageIds: [],
		});
		const tools = seen[1]!.filter((m) => m.role === "tool");
		expect(tools).toHaveLength(4);
		expect(tools.some((m) => m.content.includes("tool_call_limit"))).toBe(
			false,
		);
		expect(seen[0]![1]!.content).not.toContain("askIfFits");
		// A reply that failed: the plan sees it.
		const before = f.requests.length;
		await expect(
			f.host.conversationAgent.respond({
				run: { conversationId: "ao", runId: "run-f", messageIds: ["user-a"] },
				messages: [
					{ role: "system", content: "fixture system" },
					{ role: "user", content: "## User\nfixture user" },
				],
				chat: {
					async complete() {
						throw new Error("chat_failed");
					},
				},
				tools: { tools: [], call: async () => ({ content: "host" }) },
				signal: new AbortController().signal,
				onDelta: () => {},
				maxToolCalls: 0,
			}),
		).rejects.toThrow("chat_failed");
		await f.advance(1000);
		await waitFor(() => f.requests.length > before);
	} finally {
		await f.close();
	}
});

test("the switching host forwards what a reply was given and that the agency serves, so forgetting reaches the reply in production", async () => {
	let planned = false;
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planResearch("user-a");
			}
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	const host = createSwitchingAgencyHost(f.deps);
	try {
		await host.recover();
		host.start();
		await host.attend("ao");
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(
			() =>
				(host.inspect("ao")!.snapshot as AgendaHostSnapshot).notes.length === 1,
		);
		await replyWith(f, [], { runId: "run-sw", messageIds: ["user-a"], host });
		const given = () =>
			f.h.store.read((db) =>
				host.dialoguePort.replyInputInTransaction!(db, "run-sw"),
			);
		expect(given()?.complete).toBe(true);
		expect(
			f.h.store.read((db) =>
				host.dialoguePort.servesRepliesInTransaction!(db, "ao"),
			),
		).toBe(true);
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		expect(given()?.complete).toBe(false);
	} finally {
		await host.close();
		await f.close();
	}
});
