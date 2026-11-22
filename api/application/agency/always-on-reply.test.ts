import { expect, test } from "bun:test";
import type { AgendaHostSnapshot } from "../../domains/dialogue";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";
import { researchRevision } from "./always-on-flow";
import { noteFromResult } from "./always-on-memory";
import { agendaClock } from "./always-on-scope";
import {
	type CallKind,
	agendaFixture,
	composeSay,
	planNothing,
	replyWith,
} from "./always-on.fixture";
import { createRebuildingAgencyHost } from "./rebuilding-host";
import { agencyReplyParts } from "./system-context";

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

const agencyMessages = (f: Awaited<ReturnType<typeof agendaFixture>>) =>
	f.h.conversation
		.get("ao")
		.messages.filter(
			(m) => m.role === "assistant" && m.id.startsWith("agency:"),
		);

/** The pace of the agent's own speech, in the fixture's clock: advance until it has spoken. */
async function untilSpoken(f: Awaited<ReturnType<typeof agendaFixture>>) {
	for (let i = 0; i < 20 && agencyMessages(f).length === 0; i++)
		await f.advance(15_000);
}

test("the reply's system holds the agenda's rules only where the agenda serves the reply", async () => {
	const f = await agendaFixture();
	try {
		const settings = f.h.settings.get().agency;
		expect(agencyReplyParts(settings, true).facts).toContain(
			"start_preparation",
		);
		expect(agencyReplyParts(settings, false).facts).toBeUndefined();
		const host = createRebuildingAgencyHost(f.deps);
		expect(host.conversationAgent.system().facts).toContain(
			"start_preparation",
		);
		expect(host.conversationAgent.handsWork()).toBe(true);
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
			free("toolchain:history.research@3"),
			free("toolchain:web.service-search@5"),
			free("toolchain:web.note@2"),
		]),
	).toBe("toolchain:web.note@2");
	expect(
		researchRevision(deps, [
			free("toolchain:history.research@3"),
			free("toolchain:web.service-search@5"),
		]),
	).toBeUndefined();
	expect(
		researchRevision(deps, [
			{ revisionId: "toolchain:web.note@2", requiresApproval: true },
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
		// The count limits of actions (one a day, one at a time) do not pace an agenda's own research.
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
		revisionId: "toolchain:history.research@3",
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
		// The writer runs behind the reply at once (see `scheduleProfile`).
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

test("the rebuilding host forwards what a reply was given and that the agency serves, so forgetting reaches the reply in production", async () => {
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
	const host = createRebuildingAgencyHost(f.deps);
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
