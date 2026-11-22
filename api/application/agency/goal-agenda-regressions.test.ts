import { expect, test } from "bun:test";
import {
	READ_NOTE,
	SHOW_NOTE,
	SET_QUIET,
	type AgendaGoalContext,
} from "eumenes-agency/agenda";
import {
	CLAUDE_CODE,
	createGoalStore,
	type GoalDesignRef,
	type GoalHostEvent,
} from "eumenes-agency/agenda/runtime";
import { readProfile, request } from "eumenes-memory-host";
import { createGoalsService } from "../../domains/goals";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import { waitFor } from "../../infrastructure/wait-for";
import { agendaClock } from "./always-on-scope";
import { agendaFixture, planNothing } from "./always-on.fixture";
import {
	agendaText,
	goalConversation,
	saveAgendaItem,
} from "./goal-agenda.fixture";

const scope = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };
const conversationId = "ao";
const desiredState = "README のプレビュー節に実行例を追記する。";
const analysisMs = 30_000;
const researchSource = "research-source";
const researchBody = "実行例の見出しはプレビュー手順にする。";

test("existing slot registrations stay addressable and replay in their original Goals scope", async () => {
	const f = await agendaFixture({ goals: {} });
	const legacy = createGoalStore(f.h.store, createGoalsService());
	const store = f.goalStore!;
	const input = {
		scopeKey: PROFILE_SCOPE,
		desiredState,
		priority: 50,
		source: { namespace: "conversation", kind: "message", id: "existing" },
		operationKey: "existing:first",
	};
	try {
		const existing = await legacy.register(scope, null, input);
		const freshInput = {
			...input,
			source: { ...input.source, id: "fresh" },
			operationKey: "fresh:first",
		};
		const fresh = await store.register(scope, null, freshInput);
		expect((await store.register(scope, null, input)).id).toBe(existing.id);
		expect((await store.register(scope, null, freshInput)).id).toBe(fresh.id);
		for (const [slot, goalId] of [
			[1, existing.id],
			[2, fresh.id],
		] as const) {
			await store.revise(
				scope,
				{ slot, goalId, revision: 1 },
				{
					source: input.source,
					priority: 80,
				},
			);
			expect(store.list(scope)[slot - 1]?.goal).toMatchObject({
				goalId,
				scopeKey: PROFILE_SCOPE,
				revision: 2,
				priority: 80,
			});
		}
		expect(legacy.list(scope)[0]?.goal?.goalId).toBe(existing.id);
		expect(legacy.list(scope)[1]?.goal).toBeNull();
	} finally {
		await f.close();
	}
});

async function goalCase(
	options: { research?: boolean; deadline?: string } = {},
) {
	const conversation = goalConversation();
	const trace: GoalHostEvent[] = [];
	const contexts: AgendaGoalContext[] = [];
	const plannedAt: number[] = [];
	let researched = false;
	const f: Awaited<ReturnType<typeof agendaFixture>> = await agendaFixture({
		dialogue: conversation.dialogue,
		goals: {
			analysisMs,
			trace: (event) => trace.push(event),
			async designer({ memory, notes }) {
				const item = memory.find((entry) => entry.id.startsWith("agenda:"))!;
				const { text } = JSON.parse(item.text) as { text: string };
				return {
					status: "ready",
					title: "README の設計",
					summary: "実行例の設計",
					markdown: [
						"# README",
						text,
						...notes.map((note) => note.markdown),
					].join("\n\n"),
					sources: [`memory:${item.id}`],
					missing: null,
				};
			},
		},
		...(options.research
			? {
					webNote: {
						turn: async () => ({
							text: `題: 調査メモ\n要約: 手順の見出し\n---\n${researchBody}`,
							searches: 1,
							usage: null,
						}),
					},
				}
			: {}),
		async script(kind, request, _i, signal) {
			if (kind === "goal_mock") {
				await new Promise<never>((_resolve, reject) => {
					signal.throwIfAborted();
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			}
			if (kind !== "plan") return;
			const raw = /<goal_context>([^]*?)<\/goal_context>/u.exec(
				request.prompt,
			)?.[1];
			if (!raw) {
				if (
					!options.research ||
					researched ||
					!request.prompt.includes(researchSource)
				)
					return planNothing();
				researched = true;
				return {
					...planNothing(),
					add: [
						{
							kind: "research",
							text: "手順の見出しを調べる",
							refs: [researchSource],
							value: 5,
							reason: "fixture",
							topic: "research",
						},
					],
				};
			}
			const context = JSON.parse(raw) as AgendaGoalContext;
			contexts.push(context);
			plannedAt.push(f.now);
			const goal = context.goals[0];
			const item = context.memory.find((entry) =>
				entry.id.startsWith("agenda:"),
			);
			return {
				...planNothing(),
				goalWork: {
					analysis: "期限、資料、実行許可を確かめる。",
					delegation:
						goal &&
						item &&
						(goal.phase === "prepare" ||
							(goal.phase === "execute" && goal.authorization))
							? {
									goalId: goal.id,
									goalRevision: goal.revision,
									toolchainRevisionId: CLAUDE_CODE.revisionId,
									memoryIds: [item.id],
									request: { task: "README の実行例", prompt: item.text },
								}
							: null,
				},
			};
		},
	});
	const store = f.goalStore!;
	const slot = () => store.list(scope)[2]!.goal!;
	const preparation = () => store.preparation(slot().goalId, slot().revision);
	const work = () => store.work(PRINCIPAL);
	const say = conversation.say.bind(null, f);
	const profile = () => readProfile(f.memoryHost!.profilePath);
	const until = (done: () => boolean) =>
		waitFor(async () => {
			await f.advance(1000);
			return done();
		});
	const update = async (
		action: "authorize_mock" | "revoke_mock",
		design: GoalDesignRef | null,
	) => {
		const quote =
			action === "authorize_mock"
				? "3番の Claude Code モックを許可します。"
				: "3番の Claude Code モックの許可を取り消します。";
		const [response] = await say(quote, [
			{
				name: "update_goal",
				args: {
					action,
					slot: 3,
					goalId: slot().goalId,
					revision: slot().revision,
					design,
					desiredState: null,
					priority: null,
					quote,
				},
			},
		]);
		return JSON.parse(response!);
	};
	return {
		f,
		trace,
		contexts,
		plannedAt,
		work,
		preparation,
		profile,
		say,
		until,
		update,
		async start() {
			await f.start();
			if (options.research) {
				await f.user(
					researchSource,
					conversationId,
					"実行例の資料を調べてください。",
				);
				await until(
					() =>
						!!f.host
							.inspect(conversationId)
							?.snapshot.notes.some((note) =>
								note.markdown.includes(researchBody),
							),
				);
			}
			const itemId = await saveAgendaItem(profile(), options);
			f.setBusy(true);
			const quote = "3番に README の目標を登録してください。";
			const [response] = await say(quote, [
				{
					name: "register_goal",
					args: { slot: 3, desiredState, priority: null, quote },
				},
			]);
			expect(JSON.parse(response!)).toMatchObject({
				status: "registered",
				slot: 3,
			});
			return itemId;
		},
		async design() {
			f.setBusy(false);
			await until(() => !!preparation()?.note);
			f.setBusy(true);
			return preparation()!.note!;
		},
		async allowIdleAfterAnalysis() {
			const due = preparation()!.startedAt + analysisMs;
			f.setBusy(false);
			await f.advance(Math.max(0, due - f.now) + 1000);
		},
	};
}

async function cancelAgendaItem(
	profile: ReturnType<typeof readProfile>,
	itemId: string,
) {
	expect(
		await request(profile, "apply", {
			agenda: {
				type: "set_agenda_status",
				scopeKey: PROFILE_SCOPE,
				itemId,
				status: "cancelled",
			},
		}),
	).toMatchObject({ status: "completed" });
}

test("forgetting a research input revokes a design even when the designer did not cite it", async () => {
	const g = await goalCase({ research: true });
	try {
		await g.start();
		const design = await g.design();
		const [read] = await g.say("設計書を読んでください。", [
			{ name: READ_NOTE, args: { id: design.id } },
		]);
		expect(read).toContain(researchBody);
		await g.f.h.memory!.forget({
			conversationId,
			messageIds: [researchSource],
			itemIds: [],
		});
		expect(g.f.documents.forgotten).toContain(design.id);
		const replies = await g.say("同じ設計書を表示してください。", [
			{ name: READ_NOTE, args: { id: design.id } },
			{ name: SHOW_NOTE, args: { id: design.id } },
		]);
		expect(replies).toEqual(["refused: no_such_note", "refused: no_such_note"]);
		expect(g.f.documents.links).toHaveLength(0);
	} finally {
		await g.f.close();
	}
}, 30_000);

test("reopening an accepted job after revocation looks up the same ID without invoking the mock again", async () => {
	const g = await goalCase();
	try {
		await g.start();
		const design = await g.design();
		expect(await g.update("authorize_mock", design)).toMatchObject({
			mockAuthorized: true,
		});
		await g.allowIdleAfterAnalysis();
		await g.until(
			() =>
				g.work()[0]?.state === "accepted" &&
				g.f.calls("goal_mock").length === 1,
		);
		const workId = g.work()[0]!.work.request.workId;
		g.f.setBusy(true);
		expect(await g.update("revoke_mock", null)).toMatchObject({
			mockAuthorized: false,
		});
		const sinceRestart = g.trace.length;
		await g.f.restart();
		await g.f.host.attend(conversationId);
		g.f.setBusy(false);
		await g.until(() => g.work()[0]?.state === "invalidated");
		expect(g.trace.slice(sinceRestart)).toContainEqual(
			expect.objectContaining({
				type: "work_lookup",
				data: expect.objectContaining({ workId }),
			}),
		);
		expect(g.work()[0]?.reason).toBe("goal_or_permission_changed");
		expect(g.f.calls("goal_mock")).toHaveLength(1);
		expect(g.f.calls("goal_verify")).toHaveLength(0);
	} finally {
		await g.f.close();
	}
}, 30_000);

test("permission given before design authorizes the first design only", async () => {
	const g = await goalCase();
	try {
		const itemId = await g.start();
		expect(await g.update("authorize_mock", null)).toMatchObject({
			mockAuthorized: true,
			designNoteId: null,
		});
		const first = await g.design();
		const [visible] = await g.say("3番の設計書を読んでください。", [
			{ name: READ_NOTE, args: { id: first.id } },
		]);
		expect(visible).toContain(agendaText);
		await cancelAgendaItem(g.profile(), itemId);
		await saveAgendaItem(g.profile(), {
			text: `${agendaText} 見出しも更新してください。`,
		});
		await g.allowIdleAfterAnalysis();
		await g.until(() =>
			g.contexts.some((context) =>
				context.goals.some(
					(goal) =>
						goal.phase === "execute" &&
						!!goal.designNoteId &&
						goal.designNoteId !== first.id,
				),
			),
		);
		const revised = g.preparation()!.note!;
		expect(revised.id).not.toBe(first.id);
		expect(g.work()).toHaveLength(0);
		expect(g.f.calls("goal_mock")).toHaveLength(0);
		g.f.setBusy(true);
		expect(await g.update("authorize_mock", revised)).toMatchObject({
			mockAuthorized: true,
		});
		g.f.setBusy(false);
		await g.until(() => g.work()[0]?.state === "accepted");
		expect(g.work()[0]!.work.request.design).toEqual(revised);
	} finally {
		await g.f.close();
	}
}, 30_000);

test.each(["reservation", "dispatch"] as const)(
	"cancelling an agenda item before %s prevents mock execution",
	async (boundary) => {
		const g = await goalCase();
		try {
			const itemId = await g.start();
			const design = await g.design();
			expect(await g.update("authorize_mock", design)).toMatchObject({
				mockAuthorized: true,
			});
			let cancelled = false;
			if (boundary === "reservation") {
				const deps = g.f.deps.agendaGoals!;
				const read = deps.readMemory;
				deps.readMemory = async (method, params) => {
					const result = await read(method, params);
					if (
						!cancelled &&
						method === "read" &&
						result.status === "found" &&
						!("itemId" in (params as object)) &&
						g.contexts
							.at(-1)
							?.goals.some(
								(goal) => goal.phase === "execute" && !!goal.authorization,
							)
					) {
						expect(g.work()).toHaveLength(0);
						await cancelAgendaItem(g.profile(), itemId);
						cancelled = true;
					}
					return result;
				};
				await g.f.restart();
				await g.f.host.attend(conversationId);
			} else {
				const store = g.f.goalStore!;
				const reserve = store.reserve;
				store.reserve = async (...args) => {
					const reason = await reserve(...args);
					if (!reason && !cancelled) {
						await cancelAgendaItem(g.profile(), itemId);
						cancelled = true;
					}
					return reason;
				};
			}
			await g.allowIdleAfterAnalysis();
			await g.until(
				() =>
					cancelled &&
					(boundary === "reservation"
						? g.trace.some(
								(event) =>
									event.type === "work_blocked" &&
									(event.data as { reason: string }).reason ===
										"memory_snapshot_stale",
							)
						: g.work()[0]?.state === "invalidated"),
			);
			expect(g.work().map((entry) => entry.state)).toEqual(
				boundary === "reservation" ? [] : ["invalidated"],
			);
			expect(
				g.trace.filter((event) => event.type === "submission"),
			).toHaveLength(0);
			expect(g.f.calls("goal_mock")).toHaveLength(0);
		} finally {
			await g.f.close();
		}
	},
	30_000,
);

test("planning receives the current Agenda clock and the agenda item's deadline", async () => {
	const deadline = "2026-11-21T18:00:00+09:00";
	const g = await goalCase({ deadline });
	try {
		await g.start();
		await g.design();
		const call = g.f
			.calls("plan")
			.find((request) => request.prompt.includes("<goal_context>"))!;
		const [plan] = call.prompt.split("\n<goal_context>");
		expect(JSON.parse(plan!).now).toBe(agendaClock(g.plannedAt[0]!));
		expect(g.contexts[0]?.memory).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining(deadline) }),
		);
	} finally {
		await g.f.close();
	}
}, 30_000);

test("a goal requested in a delivered steering message is registered in that reply", async () => {
	const f = await agendaFixture({ goals: {} });
	try {
		await f.start();
		const initial = "しばらく静かにしてください。";
		const quote = "3番に README の目標を登録してください。";
		await f.user("original-user", conversationId, initial);
		let round = 0;
		let response: unknown;
		await f.host.conversationAgent.respond({
			run: {
				conversationId,
				runId: "steered-goal",
				messageIds: ["original-user"],
			},
			messages: [
				{ role: "system", content: "fixture" },
				{ role: "user", content: initial },
			],
			chat: {
				async complete(request) {
					round++;
					if (round === 1) {
						await f.user("added-goal", conversationId, quote);
						return {
							text: "",
							toolCalls: [
								{
									id: "quiet",
									name: SET_QUIET,
									arguments: JSON.stringify({
										scope: "speech",
										kind: "said",
										minutes: 1,
									}),
								},
							],
						};
					}
					if (round === 2) {
						expect(request.messages).toContainEqual(
							expect.objectContaining({
								role: "user",
								content: expect.stringContaining(quote),
							}),
						);
						return {
							text: "",
							toolCalls: [
								{
									id: "register",
									name: "register_goal",
									arguments: JSON.stringify({
										slot: 3,
										quote,
										desiredState,
										priority: null,
									}),
								},
							],
						};
					}
					response = JSON.parse(
						request.messages
							.filter((message) => message.role === "tool")
							.at(-1)!.content,
					);
					return { text: "登録しました。", toolCalls: [] };
				},
			},
			tools: { tools: [], call: async () => ({ content: "host" }) },
			signal: new AbortController().signal,
			onDelta: () => {},
			maxToolCalls: 0,
		});
		expect(response).toMatchObject({ status: "registered", slot: 3 });
		expect(f.goalStore!.list(scope)[2]?.goal?.desiredState).toBe(desiredState);
		expect(
			f.h.store.read((db) =>
				f.host.dialoguePort.steeredInTransaction!(db, "steered-goal"),
			),
		).toEqual(["added-goal"]);
	} finally {
		await f.close();
	}
}, 30_000);
