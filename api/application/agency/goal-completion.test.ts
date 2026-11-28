import { expect, test } from "bun:test";
import { llmOutputJsonSchema } from "eumenes-agency";
import { createGoalStore, goalMigrations } from "eumenes-agency/agenda/runtime";
import {
	createGoalsService,
	migrations as goalsMigrations,
} from "../../domains/goals";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import { setupMemory } from "../../domains/memory/test/memory.fixture";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { collectAgendaResults } from "./always-on-cycle";
import type { AgencyHostDeps } from "./host-types";
import { captureGoalSources } from "./goal-input-sources";
import { createGoalNoteAdopter } from "./goal-note-adoption";
import { createGoalProgress } from "./goal-progress";
import { createGoalSemanticVerification } from "./goal-semantic-verification";
import { createGoalWork } from "./goal-work";
import { referencedInput } from "./input";

const access = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };
const time = Date.parse("2026-10-13T12:00:00.000Z");
async function fixture() {
	const h = await setupMemory({
		extraMigrations: [
			...goalsMigrations,
			...goalMigrations,
			...queueMigrations,
		],
	});
	const ledger = createGoalsService(() => h.time.now);
	const goals = createGoalStore(h.store, ledger);
	const records = {
		conversation: h.conversation,
		memory: h.memory,
		continuity: h.continuity,
		agendaGoals: {
			store: goals,
			sourceMessageIds: (
				db: Parameters<typeof ledger.originInTransaction>[0],
				id: string,
			) => ledger.originInTransaction(db, access, id)?.messageIds ?? [],
		},
	};
	const original = await h.say("user", "Save the result of our work.");
	const source = { namespace: "conversation", kind: "message", id: original };
	const register = (slot: number, conversation: string) =>
		h.store.write((db) => {
			const goal = goals.registerInTransaction(
				db,
				access,
				slot,
				{
					scopeKey: PROFILE_SCOPE,
					desiredState: "保存された成果を確認する",
					priority: 50,
					source,
					sourceMessageIds: [original],
					operationKey: String(slot),
				},
				{
					mode: "goal",
					sourceRef: original,
					startedAt: time,
					deliveryConversationId: conversation,
				},
			);
			return {
				principal: PRINCIPAL,
				goalId: goal.id,
				goalRevision: goal.revision,
			};
		});
	return { ...h, ledger, goals, records, register, source };
}

test("a met goal shows its report to the agency once, after its own completion revision, and goes with what it rests on", async () => {
	const f = await fixture();
	const input = f.memory.referenceInputs;
	const work = createGoalWork({
		store: f.store,
		goals: f.goals,
		conversation: f.conversation,
		blocked: (db, id) => f.memory.isBlockedInTransaction(db, id),
		reply: () => {
			throw new Error("fixture_goal_reply_unused");
		},
		now: () => time,
	});
	try {
		const key = await f.register(1, "c1");
		const item = await f.seed("緑茶が好き", "drink");
		const sources = f.store.read((db) => [
			...input.captureInTransaction(db, { itemIds: [item.id] }).sources,
			...referencedInput(
				f.records as unknown as AgencyHostDeps,
				db,
				[],
				["goal:" + key.goalId],
			).sources,
		]);
		await f.store.write((db) => {
			const selected = f.goals.applyDecisionInTransaction(
				db,
				access,
				key,
				{
					kind: "verify",
					contextId: "context",
					progressVersion: 1,
					criterionIds: ["root"],
					reason: "The actual result is present",
					review: null,
					checks: [
						{ criterionId: "root", checkRef: "check", evidenceRefs: [] },
					],
				},
				{ nowMs: time, contextId: "context", current: () => true },
			);
			if (selected.status !== "applied")
				throw new Error("fixture_goal_decision");
			const checked = f.goals.recordGoalChecksInTransaction(db, access, key, {
				expectedVersion: selected.progress.progressVersion,
				current: () => true,
				checks: [
					{
						criterionId: "root",
						checkRef: "check",
						passed: true,
						evidence: {
							ref: "proof",
							version: "v1",
							digest: "proof",
							summary: "Observed",
							sources,
						},
					},
				],
			})!;
			const done = f.goals.completeInTransaction(db, access, key, {
				expectedVersion: checked.progressVersion,
				current: () => true,
				text: "Completed with evidence.",
			});
			if (done.status !== "applied") throw new Error("fixture_goal_complete");
		});
		const views = () => f.store.read((db) => work.viewsInTransaction(db));
		expect(views()).toMatchObject([
			{
				goalId: key.goalId,
				revision: key.goalRevision,
				conversationId: "c1",
				question: null,
				report: {
					text: "Completed with evidence.",
					checked: ["Observed"],
					sources: expect.arrayContaining([expect.stringContaining("memory")]),
				},
			},
		]);
		// Nothing is written to the conversation: the agent tells the report as its assignment's.
		expect(f.conversation.get("c1").messages.map(({ role }) => role)).toEqual([
			"user",
		]);
		f.memory.registerForgetPurge((db, purge) => {
			f.goals.forgetGoalInputsInTransaction(db, access, {
				goalIds: [],
				sourceCurrent: (id) =>
					!purge.messageIds.includes(id) &&
					captureGoalSources(db, input, [id], f.records).complete,
			});
		});
		await f.memory.forget({
			conversationId: "c1",
			itemIds: [item.id],
			messageIds: [],
		});
		await work.recover();
		expect(views()).toEqual([]);
		expect(
			f.store.read((db) => f.goals.pendingGoalReportsInTransaction(db)),
		).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a report the agency adopted is not shown again", async () => {
	const f = await fixture();
	const work = createGoalWork({
		store: f.store,
		goals: f.goals,
		conversation: f.conversation,
		blocked: () => false,
		reply: () => {
			throw new Error("fixture_goal_reply_unused");
		},
	});
	try {
		const key = await f.register(1, "c1");
		await f.store.write((db) => {
			const selected = f.goals.applyDecisionInTransaction(
				db,
				access,
				key,
				{
					kind: "verify",
					contextId: "context",
					progressVersion: 1,
					criterionIds: ["root"],
					reason: "present",
					review: null,
					checks: [
						{ criterionId: "root", checkRef: "check", evidenceRefs: [] },
					],
				},
				{ nowMs: time, contextId: "context", current: () => true },
			);
			if (selected.status !== "applied") throw new Error("fixture");
			const checked = f.goals.recordGoalChecksInTransaction(db, access, key, {
				expectedVersion: selected.progress.progressVersion,
				current: () => true,
				checks: [
					{
						criterionId: "root",
						checkRef: "check",
						passed: true,
						evidence: {
							ref: "proof",
							version: "v1",
							digest: "proof",
							summary: "Observed",
							sources: [],
						},
					},
				],
			})!;
			f.goals.completeInTransaction(db, access, key, {
				expectedVersion: checked.progressVersion,
				current: () => true,
				text: "Done.",
			});
		});
		const [view] = f.store.read((db) => work.viewsInTransaction(db));
		await f.store.write((db) => work.reportedInTransaction(db, view!));
		expect(f.store.read((db) => work.viewsInTransaction(db))).toEqual([]);
		expect(
			f.store.read(
				(db) => f.goals.goalReportsInTransaction(db, access)[0]?.state,
			),
		).toBe("delivered");
	} finally {
		await f.close();
	}
});

test("conversation note adoption sends current goal and plan evidence to the matching subscription once", async () => {
	const f = await fixture();
	const queue = createQueue(f.store);
	const progress = createGoalProgress({
		store: f.store,
		goals: f.goals,
		queue,
		enabled: () => true,
		owners: {},
		llm() {
			throw new Error("unneeded_inference");
		},
		sourcesCurrent: (db, _row, sources) =>
			captureGoalSources(db, f.memory.referenceInputs, sources, f.records)
				.complete,
		surface: () => ({ capabilities: [], watches: [], checks: [] }),
	});
	const observed = createGoalNoteAdopter(
		f.goals,
		progress,
		(db, _row, sources) =>
			captureGoalSources(db, f.memory.referenceInputs, sources, f.records)
				.complete,
	);
	try {
		const plan = await f.plan("c1", {
			kind: "plan",
			text: "Traceable plan",
			messageIds: [f.source.id],
		});
		const first = await f.register(1, "c1");
		const second = await f.register(2, "c1");
		const differentConversation = await f.register(3, "c2");
		const subscribed = async () =>
			f.store.write((db) => {
				for (const key of [first, second, differentConversation]) {
					const row = f.goals.activeProgressInTransaction(db, access, key)!;
					f.goals.transitionProgressInTransaction(
						db,
						access,
						row,
						row.progressVersion,
						(current) => ({
							phase: "waiting",
							state: {
								...current.state,
								watch: {
									ref: "docs",
									condition: "新しい資料",
									dueAtMs: null,
									producer: "markdown",
								},
							},
						}),
					);
				}
			});
		type Host = Parameters<typeof collectAgendaResults>[0];
		const rec = f.records as unknown as Host["deps"];
		const refs = ["goal:" + first.goalId, "plan:" + plan.id];
		const inputs = f.store.read((db) => referencedInput(rec, db, [], refs));
		expect(inputs.complete).toBe(true);
		expect(
			inputs.sources.filter((ref) => ref.startsWith("agency-record:")),
		).toHaveLength(2);
		let documentWrites = 0;
		const discardedItems: string[] = [];
		async function publish(sources: readonly string[], documentId: string) {
			const scope = {
				id: "c1",
				epoch: 1,
				notes: [],
				retired: [],
				tickets: [
					{
						id: "ticket",
						itemId: "item",
						agentTicketId: "agent",
						inputs: sources,
						refs,
						question: "Find source.",
					},
				],
				agent: {
					researchReturned() {},
					forget(refs: string[]) {
						discardedItems.push(...refs);
					},
					infoChanged() {},
					view: () => ({ items: [] }),
				},
				finished: new Map(),
				assignments: new Map(),
				observed: new Map(),
				revision: 0,
				thoughts: [],
				thoughtSeq: 0,
				thoughtsChanged() {},
				kick() {},
			} as unknown as ReturnType<Host["conv"]>;
			const deps = {
				...rec,
				store: f.store,
				goalResearchNoteInTransaction: observed,
				state: {
					resultsInTransaction: () => [
						{
							conversationId: "c1",
							epoch: 1,
							ticketId: "ticket",
							rootId: "work",
							workStatus: "succeeded",
							summary: "Actual note",
							cancel: false,
						},
					],
					returnedInTransaction: () => true,
					cancelInTransaction() {},
					staleSourcesInTransaction: () => [],
				},
				noteDocuments: {
					startInTransaction() {
						documentWrites++;
						return documentId;
					},
				},
			} as unknown as Host["deps"];
			await collectAgendaResults({
				deps,
				now: () => time,
				conv: () => scope,
				convs: new Map(),
				saveInTransaction() {},
				collected() {},
			});
		}
		await publish(inputs.sources, "document");
		expect(
			f.store.read(
				(db) =>
					f.goals.progressInTransaction(db, access, first)?.state.evidence,
			),
		).toHaveLength(1);
		expect(
			f.store.read(
				(db) =>
					f.goals.progressInTransaction(db, access, second)?.state.evidence,
			),
		).toEqual([]);
		expect(
			f.store.read(
				(db) =>
					f.goals.progressInTransaction(db, access, differentConversation)
						?.state.evidence,
			),
		).toEqual([]);
		await subscribed();
		await publish(inputs.sources, "document");
		expect(
			f.store.read(
				(db) =>
					f.goals.progressInTransaction(db, access, first)?.state.evidence,
			),
		).toHaveLength(1);
		const held = await f.store.write((db) => {
			const row = f.goals.activeProgressInTransaction(db, access, first)!;
			return f.goals.transitionProgressInTransaction(
				db,
				access,
				first,
				row.progressVersion,
				(current) => ({
					phase: "waiting",
					dueAtMs: time + 300_000,
					state: {
						...current.state,
						watch: {
							ref: "initial-analysis",
							condition: "期限待ち",
							dueAtMs: time + 300_000,
						},
					},
				}),
			);
		});
		await publish(inputs.sources, "early-second-document");
		expect(
			f.store.read((db) => f.goals.progressInTransaction(db, access, first)),
		).toMatchObject({
			phase: "waiting",
			dueAtMs: held?.dueAtMs,
			state: {
				watch: { ref: "initial-analysis" },
				evidence: [expect.anything(), expect.anything()],
			},
		});
		await subscribed();
		await publish(inputs.sources, "new-awaited-document");
		expect(
			f.store.read(
				(db) => f.goals.progressInTransaction(db, access, first)?.phase,
			),
		).toBe("ready");
		await f.closePlan(plan.id, plan.revision);
		await publish(inputs.sources, "stale-document");
		expect(documentWrites).toBe(4);
		expect(discardedItems).toEqual(["item"]);
		expect(
			f.store.read(
				(db) =>
					f.goals.progressInTransaction(db, access, first)?.state.evidence,
			),
		).toHaveLength(3);
	} finally {
		progress.close();
		await queue.close(1_000);
		await f.close();
	}
});

test("independent document verification reads owner content and requires exact supporting evidence", async () => {
	const f = await fixture();
	try {
		const key = await f.register(1, "c1");
		let markdown = "The field guide identifies an adult bird by its red bill.";
		let quote = "identifies an adult bird by its red bill";
		const verifier = createGoalSemanticVerification({
			llm: () => ({
				async complete(request) {
					expect(llmOutputJsonSchema(request.schema)).toMatchObject({
						type: "object",
					});
					const presented = JSON.parse(request.prompt);
					expect(presented[0].documents[0]).toEqual({
						ref: "research",
						title: "Field guide",
						markdown,
						sources: ["https://example.com/guide"],
					});
					return {
						value: request.schema.parse({
							assessment: [
								{
									criterionId: "root",
									passed: true,
									reason: "The guide confirms the requested fact.",
									quotes: [{ ref: "research", quote }],
								},
							],
						}),
						model: "verifier",
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						latencyMs: 0,
					};
				},
			}),
			sourcesCurrent: () => true,
			read: () => ({
				id: "research",
				title: "Field guide",
				markdown,
				sources: ["https://example.com/guide"],
			}),
		});
		const ready = f.store.read((db) =>
			f.goals.progressInTransaction(db, access, key)!,
		);
		const row = {
			...ready,
			phase: "verifying" as const,
			state: {
				...ready.state,
				evidence: [
					{
						ref: "research",
						version: "1",
						digest: "body",
						summary: "Worker says completed",
					},
				],
				next: {
					kind: "verify" as const,
					contextId: "context",
					progressVersion: 1,
					reason: "Read the guide",
					review: null,
					criterionIds: ["root"],
					checks: [
						{
							criterionId: "root",
							checkRef: verifier.checks(
								f.store.read((db) => db),
								{
									...ready,
									state: {
										...ready.state,
										evidence: [
											{
												ref: "research",
												version: "1",
												digest: "body",
												summary: "worker",
											},
										],
									},
								},
							)[0]!.ref,
							evidenceRefs: ["research"],
						},
					],
				},
			},
		};
		const verify = () =>
			f.store.read((db) => verifier.verify(db, row))!(
				new AbortController().signal,
			);
		const accepted = await verify();
		expect(accepted[0]?.passed).toBe(true);
		expect(
			f.store.read((db) => verifier.verificationCurrent(db, row, accepted)),
		).toBe(true);
		markdown = "This document discusses lunch.";
		expect(
			f.store.read((db) => verifier.verificationCurrent(db, row, accepted)),
		).toBe(false);
		quote = "identifies an adult bird by its red bill";
		const unsupported = await verify();
		expect(unsupported[0]?.passed).toBe(false);
	} finally {
		await f.close();
	}
});
