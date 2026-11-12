import { expect, test } from "bun:test";
import { createLiveLarm } from "../../../scripts/live-larm";
import { z } from "zod";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";
import { jstDay } from "../../infrastructure/jst-time";
import {
	afterUtterance,
	delegate,
	findToolchain,
	searchThenDelegate,
	toolResults,
} from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

test.skipIf(process.env.EUMENES_VERIFY_SCHEDULER_LLM !== "1")(
	"live model reads a reservation without being given its ID or scheduled time",
	async () => {
		const h = await harness({
			schedules: true,
			liveRouting: true,
			model: createLiveLarm(),
			conversationAgent: { ...testConversationAgent, handsWork: () => true },
		});
		try {
			const conversationId = `schedule-live-${crypto.randomUUID()}`;
			const reservation = await h.scheduler.create({
				requestId: crypto.randomUUID(),
				target: {
					kind: "dialogue.prompt",
					payload: { conversationId, text: "合成の検証用リマインドです。" },
				},
				schedule: {
					type: "once",
					at: new Date(Date.now() + 600_000).toISOString(),
				},
				misfirePolicy: "coalesce",
				graceMs: 300_000,
			});
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId,
				text: "Eumenes 自身の実行予約がこの会話に登録されているか、実行した記録があるか、内部記録を確認してください。",
			});
			expect(response.status).toBe(202);
			const { id } = await response.json();
			expect(
				(await h.dialogue.waitForTerminal(id, { timeoutMs: 55_000 }))?.status,
			).toBe("completed");
			const evidence = h.store.read((db) =>
				h.dialogue.backgroundDiagnosticInTransaction(db, conversationId),
			);
			expect(evidence, h.dialogue.answerText(id) ?? "").not.toBeNull();
			expect(JSON.parse(evidence!.text).items).toEqual([
				expect.objectContaining({
					id: reservation.id,
					state: "active",
					occurrences: [],
				}),
			]);
			expect(h.dialogue.answerText(id)).toMatch(/予約/);
		} finally {
			await h.close();
		}
	},
	65_000,
);

test.each([false, true])(
	"conversation finds a reservation without embeddings and delivers the scheduled reply (approval: %s)",
	async (approval) => {
		const conversationId = "packing";
		const request = approval
			? "明日から毎朝8時に、この会話で持ち物を知らせてください"
			: "明日の朝8時に持ち物を知らせて";
		const proposal =
			"明日から毎朝8時に、この会話で持ち物を知らせるよう予約しますか？";
		const userInput = approval ? "はい、お願いします" : request;
		const intervalMs = approval ? 86_400_000 : undefined;
		const scheduledText =
			"出かける前に持ち物を確認するよう声をかけてください。";
		const scheduledAnswer = "出かける前に持ち物を確認してください。";
		const usualAnswer = "今日はどんな話をしましょうか。";
		const registered = "朝8時に持ち物を知らせるよう予約しました。";
		let now = Date.now();
		const nextDay = jstDay(now + 86_400_000);
		const at = `${nextDay}T08:00:00+09:00`;
		const dueAt = Date.parse(at);
		let invoked = false;
		const h = await harness({
			schedules: true,
			timers: true,
			timerNow: () => now,
			liveRouting: true,
			conversationAgent: {
				...testConversationAgent,
				handsWork: () => true,
			},
			parent: (messages) => {
				const latest = messages.at(-1)?.content ?? "";
				if (latest.includes("朝の持ち物を忘れてしまう")) return proposal;
				if (latest.includes(scheduledText)) return scheduledAnswer;
				return usualAnswer;
			},
			firstRound: (_tools, question, messages) => {
				if (question !== userInput) return;
				if (approval)
					expect(
						messages.some((message) => message.content.includes(proposal)),
					).toBe(true);
				const result = toolResults(
					afterUtterance(messages),
					"find_toolchain",
				)[0];
				if (!result) return { calls: [findToolchain(request)] };
				const { candidates } = JSON.parse(result) as {
					candidates: Array<{ id: string }>;
				};
				const candidate = candidates.find(
					({ id }) => id === "scheduler.manage",
				);
				expect(candidate).toBeDefined();
				return { calls: [delegate(candidate!.id, request)] };
			},
			specialist: (messages) => {
				if (!invoked) {
					invoked = true;
					expect(messages.at(-1)?.content).toBe(userInput);
					if (approval)
						expect(messages[1]?.content).toContain(
							JSON.stringify({ handedOverRequest: request }).slice(1, -1),
						);
					return {
						action: "invoke",
						tool: "scheduler.register",
						arguments: { text: scheduledText, at, intervalMs },
					};
				}
				expect(messages[0]?.content).toContain("forward: false");
				expect(messages.at(-1)?.content).toContain('"ok":true');
				return { action: "return", forward: false, text: registered };
			},
		});
		const say = async (text: string) => {
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId,
				text,
			});
			expect(response.status).toBe(202);
			const { id } = await response.json();
			expect(
				(await h.dialogue.waitForTerminal(id, { timeoutMs: 6000 }))?.status,
			).toBe("completed");
			return h.dialogue.answerText(id);
		};
		try {
			if (approval) {
				expect(await say("朝の持ち物を忘れてしまう")).toBe(proposal);
				expect(h.scheduler.list().items).toEqual([]);
			}
			expect(await say(userInput)).toBe(registered);
			expect(
				await (
					await h.request(`/api/conversations/${conversationId}/specialist`)
				).json(),
			).toMatchObject({ session: null });
			expect(await say("ところで、話題を変えてもいい？")).toBe(usualAnswer);
			const [schedule] = h.scheduler.list().items;
			expect(h.scheduler.list().items).toEqual([
				expect.objectContaining({
					targetPayload: { conversationId, text: scheduledText },
					nextDueAt: new Date(dueAt).toISOString(),
					intervalMs: intervalMs ?? null,
				}),
			]);
			now = dueAt - 1;
			expect(await h.scheduler.tick()).toBe(0);
			now = dueAt;
			expect(await h.scheduler.tick()).toBe(1);
			const [occurrence] = h.scheduler.listOccurrences(schedule!.id).items;
			const run = await h.dialogue.waitForTerminal(occurrence!.subjectRef!, {
				timeoutMs: 6000,
			});
			expect(run).toMatchObject({
				conversationId,
				status: "completed",
				sourceKind: "schedule",
			});
			const history = await (
				await h.request(`/api/conversations/${conversationId}`)
			).json();
			expect(history.messages.at(-1)).toMatchObject({
				role: "assistant",
				text: scheduledAnswer,
				runId: run!.id,
			});
			expect(await h.scheduler.tick()).toBe(0);
		} finally {
			await h.close();
		}
	},
	15_000,
);

test.each([[undefined], [86_400_000]])(
	"a collaborator clarifies and registers once per turn (interval %s)",
	async (intervalMs) => {
		let now = Date.now();
		const at = new Date(now + 86_400_000).toISOString();
		const original = "明日、この会話で作業メモを見直すよう声をかけて";
		const args = {
			text: "作業メモを見直すように声をかけてください。",
			at,
			...(intervalMs ? { intervalMs } : {}),
		};
		const interval = intervalMs ? "1日ごと" : "一回";
		let stage = 0;
		const h = await harness({
			schedules: true,
			timers: true,
			timerNow: () => now,
			discoveryTarget: () => "schedule_conversation",
			firstRound: (_tools, _question, messages) =>
				searchThenDelegate(
					(candidate) => candidate.id === "scheduler.manage",
					original,
					{
						announcement: "実行予約の担当に引き継ぎます。",
						impact: "create",
					},
				)(messages),
			specialist: (messages) => {
				const prompt = messages[0]!.content;
				expect(prompt).toContain("参考資料や過去の結果");
				expect(prompt).toContain("オフセット付きISO 8601");
				expect(prompt).toContain("scheduler.register");
				switch (stage++) {
					case 0:
						return { action: "reply", text: "何時に声をかけますか。" };
					case 1:
					case 2:
						return {
							action: "invoke",
							tool: "scheduler.register",
							arguments: args,
						};
					case 3:
						return {
							action: "invoke",
							tool: "scheduler.register",
							arguments: { ...args, text: "別の仕事" },
						};
					default:
						expect(messages.at(-1)?.content).toContain("request_conflict");
						return {
							action: "reply",
							text: "作業メモの見直しを予約しました。",
						};
				}
			},
		});
		const artifact = "/api/toolchain-artifacts/artifact:scheduler.pending@2";
		const source = artifact + "/sources/agenda";
		const list = async () => {
			const response = await h.request(source);
			expect(response.status).toBe(200);
			return (await response.json()).data.items;
		};
		const say = async (text: string) => {
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			expect(response.status).toBe(202);
			const { id } = await response.json();
			expect(
				(await h.dialogue.waitForTerminal(id, { timeoutMs: 6000 }))?.status,
			).toBe("completed");
			return h.dialogue.answerText(id);
		};
		try {
			const settings = h.settings.get();
			settings.routes.llm.mode = "larm-preferred";
			await h.settings.apply({
				requestId: crypto.randomUUID(),
				expectedRevision: settings.revision,
				settings,
				keys: [],
			});
			const catalog = await (
				await h.request("/api/toolchain-artifacts")
			).json();
			expect(catalog.artifacts).toContainEqual(
				expect.objectContaining({
					artifactId: "scheduler.pending",
					artifactRevisionId: "artifact:scheduler.pending@2",
					launcher: expect.objectContaining({ label: "実行予約" }),
				}),
			);
			expect((await h.app.request(source)).status).toBe(401);
			expect(
				(await (await h.request(artifact)).json()).artifact.variants[0]
					.definition,
			).toMatchObject({
				view: "schedule-agenda",
				source: "agenda",
			});
			expect(await list()).toEqual([]);
			expect(await say(original)).toBe("何時に声をかけますか。");
			expect(await list()).toEqual([]);
			expect(await say("この時刻で予約して " + at)).toBe(
				"作業メモの見直しを予約しました。",
			);
			expect(h.scheduler.list().items).toHaveLength(1);
			const schedule = h.scheduler.list().items[0]!;
			expect(schedule.targetPayload).toEqual({
				conversationId: "main",
				text: args.text,
			});
			expect(await list()).toEqual([
				expect.objectContaining({
					id: schedule.id,
					title: args.text,
					nextDueAt: at,
					interval,
					intervalMs: intervalMs ?? null,
				}),
			]);
			now = Date.parse(at);
			expect(await h.scheduler.tick()).toBe(1);
			expect(h.scheduler.listOccurrences(schedule.id).items).toEqual([
				expect.objectContaining({ state: "dispatched", scheduledAt: at }),
			]);
			expect(await list()).toEqual(
				intervalMs
					? [
							expect.objectContaining({
								id: schedule.id,
								nextDueAt: new Date(now + intervalMs).toISOString(),
								interval,
							}),
						]
					: [],
			);
		} finally {
			await h.close();
		}
	},
	15_000,
);

test("the reservation list includes paused workflows and excludes internal timer schedules", async () => {
	const h = await harness({ schedules: true, timers: true });
	try {
		const at = new Date(Date.now() + 86_400_000).toISOString();
		h.scheduler.registerTarget({
			kind: "workflow.run",
			version: 1,
			publicCreate: false,
			schema: z.strictObject({ definitionId: z.string() }),
			materializeInTransaction: () => {
				throw new Error("test_schedule_fired_early");
			},
		});
		const workflow = await h.store.write((db) =>
			h.scheduler.createInTransaction(db, {
				requestId: crypto.randomUUID(),
				target: { kind: "workflow.run", payload: { definitionId: "journal" } },
				schedule: { type: "interval", anchor: at, intervalMs: 86_400_000 },
				misfirePolicy: "coalesce",
				graceMs: 0,
			}),
		);
		await h.scheduler.pause(workflow.id, workflow.revision);
		expect(
			(
				await h.request("/api/timers", {
					requestId: crypto.randomUUID(),
					issuedAt: new Date().toISOString(),
					durationSeconds: 3600,
				})
			).ok,
		).toBe(true);
		expect(
			h.scheduler.list().items.map(({ targetKind }) => targetKind),
		).toContain("timer.expire");
		const response = await h.request(
			"/api/toolchain-artifacts/artifact:scheduler.pending@2/sources/agenda",
		);
		expect(response.status).toBe(200);
		expect((await response.json()).data.items).toEqual([
			expect.objectContaining({
				id: workflow.id,
				kind: "ワークフロー",
				state: "paused",
				nextDueAt: null,
				intervalMs: 86_400_000,
			}),
		]);
	} finally {
		await h.close();
	}
}, 15_000);
