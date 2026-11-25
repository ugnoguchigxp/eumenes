import { expect, test } from "bun:test";
import { createAgendaAgent } from "eumenes-agency/agenda";
import { createAgencyStatePort } from "../../domains/dialogue";
import type { ExecutionView } from "../../domains/tool-runtime";
import { noteFromResult } from "./always-on-memory";
import { controlAssignment } from "./always-on-assignments";
import { agendaFixture } from "./always-on.fixture";
import type { AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import { imageFixture, imageQuestion } from "../media/image.fixture";
import { musicFixture, musicQuestion } from "../media/music.fixture";
import {
	ask,
	assignmentAgenda,
	cancelAssignment,
	executions,
	items,
	notes,
	plannedBy,
	until,
	works,
} from "../media/assignment.fixture";

test("cancelling an assignment flushes the queue cancellation, so LARM gets the DELETE", async () => {
	const f = musicFixture("cancel");
	const a = await assignmentAgenda({
		harness: { model: plannedBy({ music: f }), musicGateway: f.gateway },
	});
	try {
		await a.start();
		const { id } = await ask(a, "music.create", musicQuestion);
		await until(a, () => !!a.h.music!.list("ao")[0]?.jobId);
		await cancelAssignment(a, id);
		await until(a, () => f.requests.some((r) => r.method === "DELETE"));
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
		expect(executions(a)[0]).toMatchObject({ status: "cancelled" });
		expect(items(a)).toHaveLength(0);
	} finally {
		await a.close();
	}
}, 30_000);

test("a revoked capability ends the assignment as failed (capability_revoked), never as a discarded cancel", async () => {
	const gate = Promise.withResolvers<void>();
	const f = imageFixture("success", gate.promise);
	const a = await assignmentAgenda({
		media: f,
		harness: { model: plannedBy({ image: f }) },
	});
	try {
		await a.start();
		await ask(a, "image.create", imageQuestion);
		await until(a, () =>
			f.requests.some(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		);
		await a.h.store.write((db) =>
			a.h.toolchain.capabilities.setEnabledInTransaction(
				db,
				"tool",
				"image.generate",
				false,
			),
		);
		// What the agent is handed when it adopts the work: failed, for the revocation, not an interruption.
		const state = a.deps.state;
		const seen: Array<{ status: string; workStatus: string; summary: string }> =
			[];
		const taken: boolean[] = [];
		const original = state.returnedInTransaction;
		state.returnedInTransaction = (db, rootId) => {
			for (const r of state.resultsInTransaction(db))
				if (r.rootId === rootId) seen.push(r);
			const result = original(db, rootId);
			taken.push(result);
			return result;
		};
		gate.resolve();
		await until(a, () => seen.length > 0 && items(a).length === 0);
		expect(seen[0]).toMatchObject({
			status: "failed",
			workStatus: "failed",
			summary: "capability_revoked",
		});
		// Adopted as the assignment's own end (not discarded as work whose authority is gone); the agent holds no note.
		expect(taken).toEqual([true]);
		expect(works(a)[0]).toMatchObject({ returned: 1 });
		expect(notes(a)).toHaveLength(0);
	} finally {
		gate.resolve();
		await a.close();
	}
}, 30_000);

/** A waiting assignment whose owner asks the question `schema` describes, and what the owner's control received. */
async function waitingOn(schema: Record<string, unknown>) {
	const f = await agendaFixture();
	const received: unknown[] = [];
	const view = {
		id: "exec-1",
		conversationId: "ao",
		request: "ブラウザーで送信する",
		revision: 3,
		status: "waiting_user",
		deadline: Number.MAX_SAFE_INTEGER,
		question: {
			id: "q1",
			prompt: "送信してよいですか",
			expiresAt: Number.MAX_SAFE_INTEGER,
			inputSchema: schema,
		},
		result: null,
	} as ExecutionView;
	const state = createAgencyStatePort({
		toolchains: {
			taskInTransaction: () => ({
				viewInTransaction: () => view,
				controlInTransaction: (_db: unknown, _id: string, control: unknown) => {
					received.push(control);
					return view;
				},
			}),
		} as never,
		now: () => 0,
	});
	await f.h.store.write((db) =>
		db
			.query(
				"INSERT INTO dialogue_agency_work(root_id,conversation_id,epoch,ticket_id,intent_id,candidate_id,question,toolchain_revision_id,deadline,source_refs_json,execution_id) VALUES('root-1','ao',1,'t1','','','q','toolchain:fake@1',9007199254740991,'[]','exec-1')",
			)
			.run(),
	);
	const answer = (text: string) =>
		f.h.store.write((db) =>
			state.controlAssignmentInTransaction(
				db,
				"root-1",
				{ action: "answer", text, question: "送信してよいですか" },
				"m1",
			),
		);
	return { f, answer, received, state };
}

test("a structured question takes the answer's text as JSON; text that is not JSON is refused with the shape", async () => {
	const schema = {
		type: "object",
		required: ["approved"],
		properties: { approved: { type: "boolean" } },
	};
	const { f, answer, received } = await waitingOn(schema);
	try {
		await answer('{"approved":true}');
		expect(received).toEqual([
			{
				workRef: "exec-1",
				expectedRevision: 3,
				action: "answer",
				input: { approved: true },
				questionRef: "q1",
			},
		]);
		const refused = await answer("はい、続けてください").catch((e) => e);
		expect(refused).toBeInstanceOf(Error);
		expect(refused.message).toBe("invalid_answer");
		expect(refused.inputSchema).toEqual(schema);
		// Nothing reached the owner for the refused answer.
		expect(received).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("a plain-text question keeps the answer as the words they are", async () => {
	const { f, answer, received } = await waitingOn({ type: "string" });
	try {
		await answer('{"approved":true}');
		expect(received[0]).toMatchObject({ input: '{"approved":true}' });
	} finally {
		await f.close();
	}
});

test("the assignment tool tells the agent the shape a refused answer needs, so it can answer again", async () => {
	const schema = { type: "object", required: ["approved"] };
	const agent = createAgendaAgent({
		persona: { name: "test" },
		llm: { call: async () => ({ text: "" }) },
		now: () => 0,
	} as unknown as Parameters<typeof createAgendaAgent>[0]);
	agent.observe({ id: "m1", who: "user", text: "送信して", at: 0 });
	const asked = agent.requestResearch({
		text: "送信する",
		at: 0,
		delegatedTo: "ブラウザー",
	});
	if (!("item" in asked)) throw new Error("not_taken");
	const c = {
		agent,
		tickets: [
			{
				id: "t1",
				itemId: asked.item.id,
				agentTicketId: "t1",
				revisionId: "toolchain:browser@1",
				question: "送信する",
				at: 0,
				refs: ["m1"],
				inputs: ["m1"],
				assignment: true as const,
				references: [],
			},
		],
		assignments: new Map([[asked.item.id, {}]]),
		observed: new Map(),
		scope: "s",
		revision: 0,
		kick: () => {},
	} as unknown as AgendaScope;
	const deps = {
		store: { write: async (fn: (db: unknown) => unknown) => fn({}) },
		state: {
			controlAssignmentInTransaction: () => {
				throw Object.assign(new Error("invalid_answer"), {
					inputSchema: schema,
				});
			},
		},
	} as unknown as AgencyHostDeps;
	const out = await controlAssignment({
		deps,
		c,
		arguments: JSON.stringify({
			id: asked.item.id,
			action: "answer",
			text: "はい",
		}),
		messageId: "m2",
		at: 1,
	});
	expect(out.content).toBe(
		`refused: invalid_answer（回答の形: ${JSON.stringify(schema)}）`,
	);
});

const research = {
	id: "t1",
	itemId: "i1",
	agentTicketId: "t1",
	revisionId: "toolchain:web.note@4",
	question: "このリポジトリの足し算の実装を調べて",
	at: 0,
	refs: ["m1"],
	inputs: ["m1"],
	references: [],
};

test("a source inspection's cited excerpts and the sources of its nested report reach the note", () => {
	const displayAnswer =
		"**ソース調査（表示深度：標準）**\n\n足し算は sum.ts にある。\n\n> **ソース：** `sum.ts`\n\nコードの抜粋（3行目から）";
	const note = noteFromResult({
		id: "n1",
		ticket: research,
		summary: JSON.stringify({
			status: "completed",
			title: "ソース調査",
			summary: "足し算は sum.ts にある。",
			fulfilled: ["足し算は sum.ts にある。"],
			missing: [],
			refs: [],
			answer: "足し算は sum.ts にある。",
			displayAnswer,
			report: {
				summary: "足し算は sum.ts にある。",
				coverage: "complete",
				verification: "evidence_linked",
				claims: [{ text: "足し算は sum.ts にある。", sourceIds: ["source-1"] }],
				limitations: ["テストは読んでいない"],
				sources: [
					{
						sourceId: "source-1",
						kind: "source",
						location: {
							path: "sum.ts",
							symbol: "sum",
							commit: "0123456789abcdef0123",
							startLine: 3,
							endLine: 9,
							digest: "d",
						},
					},
				],
			},
		}),
		at: 5,
	});
	expect(note).toMatchObject({
		title: "ソース調査",
		summary: "足し算は sum.ts にある。",
	});
	// The excerpts are shown, once (the claims they carry are not listed again); the place and the limits follow.
	expect(note!.markdown).toBe(
		`# ソース調査\n\n${displayAnswer}\n- 限界: テストは読んでいない\n- 出典: コード sum.ts 3–9行目（sum） 0123456789ab`,
	);
});

test("an archived document's source keeps its version and its position in the original text", () => {
	const note = noteFromResult({
		id: "n1",
		ticket: research,
		summary: JSON.stringify({
			status: "completed",
			summary: "決定は11月だった。",
			fulfilled: [],
			missing: [],
			refs: [],
			answer: "決定は11月だった。",
			claims: [
				{ text: "決定は11月だった。", status: "verified", sourceIds: ["s1"] },
			],
			report: {
				summary: "決定は11月だった。",
				coverage: "complete",
				verification: "evidence_linked",
				claims: [{ text: "決定は11月だった。", sourceIds: ["s1"] }],
				limitations: [],
				sources: [
					{
						sourceId: "s1",
						kind: "archive_document",
						title: "議事録",
						revision: "r3",
						start: 120,
						end: 180,
					},
					{ sourceId: "s2", url: "https://example.com/a", title: "記事" },
				],
			},
		}),
		at: 5,
	});
	expect(note!.markdown).toContain(
		"- 出典: 保存文書「議事録」版 r3、原文位置 120–180",
	);
	expect(note!.markdown).toContain("- 出典: 記事 https://example.com/a");
});
