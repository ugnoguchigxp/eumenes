import { expect, test } from "bun:test";
import { z } from "zod";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

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
		const artifact = "/api/toolchain-artifacts/artifact:scheduler.pending@1";
		const source = artifact + "/sources/pending-schedules";
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
					launcher: expect.objectContaining({ label: "実行予約" }),
				}),
			);
			expect((await h.app.request(source)).status).toBe(401);
			expect(
				(await (await h.request(artifact)).json()).artifact.variants[0]
					.definition,
			).toMatchObject({
				view: "collection-workspace",
				source: "pending-schedules",
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
			"/api/toolchain-artifacts/artifact:scheduler.pending@1/sources/pending-schedules",
		);
		expect(response.status).toBe(200);
		expect((await response.json()).data.items).toEqual([
			expect.objectContaining({
				id: workflow.id,
				kind: "ワークフロー",
				state: "paused",
				nextDueAt: null,
			}),
		]);
	} finally {
		await h.close();
	}
}, 15_000);
