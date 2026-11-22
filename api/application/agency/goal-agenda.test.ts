import { expect, test } from "bun:test";
import {
	CLAUDE_CODE,
	openClaudeCodeMock,
	type GoalHostEvent,
} from "eumenes-agency/agenda/runtime";
import {
	READ_NOTE,
	SHOW_NOTE,
	type AgendaGoalContext,
} from "eumenes-agency/agenda";
import { readProfile } from "eumenes-memory-host";
import { createGoalsService } from "../../domains/goals";
import { MAX_ADOPTED_GOALS } from "../../domains/goals/contracts";
import { PRINCIPAL, PROFILE_SCOPE } from "../../domains/memory/contracts";
import { waitFor } from "../../infrastructure/wait-for";
import { agendaFixture, planNothing } from "./always-on.fixture";
import {
	agendaText,
	goalConversation,
	saveAgendaItem,
} from "./goal-agenda.fixture";

const desiredState =
	"サンプル CLI の README のプレビュー節に実行例を追記する。";
const body = `# README の設計\n\n${desiredState}\n\n${agendaText}`;
const scope = { principal: PRINCIPAL, scopeKeys: [PROFILE_SCOPE] };

test("a full steward ledger leaves all ten conversation slots available through design, mock work and report", async () => {
	const conversation = goalConversation();
	let afterRestart = false;
	let designCalls = 0;
	const trace: GoalHostEvent[] = [];
	const f = await agendaFixture({
		goals: {
			analysisMs: 30_000,
			trace: (event) => trace.push(event),
			async designer(input) {
				const constraint = input.memory.find((item) =>
					item.text.includes(agendaText),
				);
				expect(constraint?.id).toStartWith("agenda:");
				expect(input.brief.prompt).toContain(agendaText);
				designCalls++;
				return {
					status: "ready",
					title: "README の設計",
					summary: "プレビュー節の実行例",
					markdown: body,
					sources: [`memory:${constraint!.id}`],
					missing: null,
				};
			},
		},
		dialogue: conversation.dialogue,
		async script(kind, request, _n, signal) {
			if (kind === "goal_mock") {
				expect(JSON.parse(request.prompt).request).toBe(body);
				if (!afterRestart)
					await new Promise<never>((_resolve, reject) =>
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						}),
					);
				return { files: [{ path: "README.md", content: agendaText }] };
			}
			if (kind === "goal_verify") {
				expect(JSON.parse(request.prompt).files).toEqual([
					{ path: "README.md", content: agendaText },
				]);
				return {
					checks: [{ condition: "README の実行例", passed: true }],
					summary: "README に実行例を追加しました。",
				};
			}
			if (kind !== "plan") return;
			const raw = /<goal_context>([^]*?)<\/goal_context>/u.exec(
				request.prompt,
			)?.[1];
			if (!raw) return planNothing();
			const context = JSON.parse(raw) as AgendaGoalContext;
			const goal = context.goals.find(
				(entry) => entry.desiredState === desiredState,
			);
			const item = context.memory.find((entry) =>
				entry.text.includes(agendaText),
			);
			return {
				...planNothing(),
				goalWork: {
					analysis: "Memory の期限付き指示を README の設計に使う。",
					delegation:
						goal && item && goal.phase !== "wait"
							? {
									goalId: goal.id,
									goalRevision: goal.revision,
									toolchainRevisionId: CLAUDE_CODE.revisionId,
									memoryIds: [item.id],
									request: { task: "README の更新", prompt: item.text },
								}
							: null,
				},
			};
		},
	});
	const store = f.goalStore!;
	const say = conversation.say.bind(null, f);
	const slot = () => store.list(scope)[2]?.goal;
	const work = () => store.work(PRINCIPAL);
	const goals = createGoalsService();
	try {
		const existing = await f.h.store.write((db) => {
			for (let i = 0; i < MAX_ADOPTED_GOALS; i++) {
				goals.adoptInTransaction(db, scope, {
					scopeKey: PROFILE_SCOPE,
					desiredState: `記憶担当が採用済みの目標 ${i + 1}`,
					source: { namespace: "steward", kind: "event", id: `existing-${i}` },
				});
			}
			return goals.adoptedForContextInTransaction(db, scope);
		});
		expect(existing).toHaveLength(MAX_ADOPTED_GOALS);
		expect(store.list(scope).every(({ goal }) => goal === null)).toBe(true);
		await f.start();
		await saveAgendaItem(readProfile(f.memoryHost!.profilePath));
		f.setBusy(true);
		for (let i = 1; i <= 10; i++) {
			const target =
				i === 3 ? desiredState : `資料を確認したら目標 ${i} を進める。`;
			const requestedSlot = i === 1 ? null : i;
			const quote = `${requestedSlot === null ? "" : `${i}番に`}目標を登録してください。${target}`;
			const [registration] = await say(quote, [
				{
					name: "register_goal",
					args: {
						slot: requestedSlot,
						desiredState: target,
						priority: null,
						quote,
					},
				},
			]);
			expect(JSON.parse(registration!)).toMatchObject({
				status: "registered",
				slot: i,
			});
		}
		const full = store.list(scope);
		expect(full.filter((entry) => entry.goal)).toHaveLength(10);
		expect(
			f.h.store.read((db) => goals.adoptedForContextInTransaction(db, scope)),
		).toEqual(existing);
		const overflow = "さらに目標を登録してください。";
		const [refused] = await say(overflow, [
			{
				name: "register_goal",
				args: {
					slot: null,
					desiredState: "11番目の目標です。",
					priority: null,
					quote: overflow,
				},
			},
		]);
		expect(JSON.parse(refused!)).toEqual({
			status: "refused",
			reason: "goal_slots_full",
		});
		expect(store.list(scope)).toEqual(full);
		expect(work()).toHaveLength(0);
		f.setBusy(false);
		await waitFor(async () => {
			await f.advance(1000);
			return Boolean(store.preparation(slot()!.goalId, 1)?.note);
		});
		const prep = store.preparation(slot()!.goalId, 1)!;
		const design = prep.note!;
		expect(
			f.documents.started.find((document) => document.id === `doc-${design.id}`)
				?.markdown,
		).toBe(body);
		f.setBusy(true);
		const [listed] = await say("3番に設計書はありますか？", [
			{ name: "list_goals", args: {} },
		]);
		expect(JSON.parse(listed!).slots[2]).toMatchObject({
			designNoteId: design.id,
			designDigest: design.digest,
			mockAuthorized: false,
		});
		const [read] = await say("3番の設計書をメモとして見せてください。", [
			{ name: READ_NOTE, args: { id: design.id } },
			{ name: SHOW_NOTE, args: { id: design.id } },
		]);
		expect(read).toContain(JSON.stringify(body));
		await waitFor(() => f.documents.links.length > 0);
		expect(f.documents.links).toContainEqual(
			expect.objectContaining({ label: "README の設計" }),
		);
		const permit =
			"3番の表示された設計書で Claude Code モックの実行を許可します。";
		await say(permit, [
			{
				name: "update_goal",
				args: {
					action: "authorize_mock",
					slot: 3,
					goalId: slot()!.goalId,
					revision: 1,
					design,
					desiredState: null,
					priority: null,
					quote: permit,
				},
			},
		]);
		expect(work()).toHaveLength(0);
		f.setBusy(false);
		await f.advance(prep.startedAt + 30_000 - f.now - 1);
		expect(work()).toHaveLength(0);
		await waitFor(async () => {
			await f.advance(1000);
			return work()[0]?.state === "accepted";
		});
		const id = work()[0]!.work.request.workId;
		expect(work()[0]?.work.request.args.prompt).toBe(body);
		expect(slot()?.status).toBe("adopted");
		afterRestart = true;
		await f.restart();
		await f.host.attend("ao");
		const reports = () =>
			f.h.conversation
				.get("ao")
				.messages.filter((message) =>
					message.id.startsWith("agency-goal-report:"),
				);
		await waitFor(async () => {
			await f.advance(1000);
			return reports().length > 0;
		}).catch((error: unknown) => {
			throw new Error(
				JSON.stringify({
					work: work().map(({ state, reason }) => ({ state, reason })),
					events: trace.slice(-10).map(({ type, data }) => ({
						type,
						reason: (data as { reason?: string } | undefined)?.reason,
					})),
					calls: f.kinds.slice(-10),
				}),
				{ cause: error },
			);
		});
		expect(
			trace.some(
				(event) =>
					event.type === "work_lookup" &&
					(event.data as { workId: string }).workId === id,
			),
		).toBe(true);
		expect(slot()?.status).toBe("completed");
		expect(designCalls).toBe(1);
		await f.advance(1000);
		expect(reports().map((message) => message.text)).toEqual([
			"できました。Claude Code モックの成果物を確認しました。README に実行例を追加しました。",
		]);
		const [status, savedDesign] = await say(
			"3番の進み具合と設計書の本文を確認したいです。",
			[
				{ name: "list_goals", args: {} },
				{ name: READ_NOTE, args: { id: design.id } },
			],
		);
		expect(JSON.parse(status!).slots[2]).toMatchObject({
			goal: { goalId: slot()!.goalId, status: "completed" },
			designNoteId: design.id,
		});
		expect(savedDesign).toContain(JSON.stringify(body));
		const worker = openClaudeCodeMock(f.deps.agendaGoals!.mockDir);
		try {
			expect(worker.requests().map((request) => request.workId)).toEqual([id]);
			expect(worker.readArtifact(`artifact:${id}`)?.files).toEqual([
				{ path: "README.md", content: agendaText },
			]);
		} finally {
			worker.close();
		}
	} finally {
		await f.close();
	}
}, 30_000);
