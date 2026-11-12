import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import timersBundle from "../../domains/capabilities/bundles/timers.bundle.json";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { bundleHostOf } from "../toolchain/toolchain-adapters";
import { harness } from "../toolchain/toolchain.fixture";

type Host = Awaited<ReturnType<typeof harness>>;
type Messages = { content: string }[];

function packet(messages: Messages, key: string) {
	const line = messages
		.flatMap(({ content }) => content.split("\n"))
		.findLast((line) => line.startsWith(key + "="));
	return line ? JSON.parse(line.slice(key.length + 1)) : null;
}
function invoke(tool: string, args: object, text?: string) {
	return { action: "invoke", tool, arguments: args, ...(text ? { text } : {}) };
}
const reply = (text: string) => ({ action: "reply", text });
const delegate = (id: string, request: string, messages: Messages) =>
	searchThenDelegate((candidate) => candidate.id === id, request, {
		announcement: "担当を切り替えます。",
		impact: "create",
	})(messages as Parameters<ReturnType<typeof searchThenDelegate>>[0]);

async function configure(h: Host) {
	const saved = h.settings.get();
	saved.routes.llm.mode = "larm-preferred";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: saved,
		keys: [],
	});
}
async function say(h: Host, text: string) {
	const res = await h.request("/api/runs", {
		conversationId: "main",
		requestId: crypto.randomUUID(),
		text,
	});
	expect(res.status).toBe(202);
	const run = await res.json();
	const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 7000 });
	expect(done?.status, JSON.stringify(done)).toBe("completed");
	return { id: run.id, answer: h.dialogue.answerText(run.id) };
}
const toolResult = (messages: Messages) =>
	packet(messages, "TOOL_RESULT")?.result;
const main = "main";
const task = "collaboration.task";

test("a conversation switches in place, then Collaboration searches a published capability and receives its result", async () => {
	const original = "タイマーは作る前に20秒で十分か相談したい";
	const switching = "ここからCollaborationに切り替えて";
	const create = "20秒のタイマーを作ってください";
	const capability = "fixture.focus-timer";
	const title = "集中時間タイマー";
	let notice: { id: string; status: string } | undefined;
	const h = await harness({
		pipelines: true,
		timers: true,
		firstRound: (_tools, question, messages) =>
			question.includes(switching)
				? delegate(task, switching, messages)
				: { text: "20秒で足りるか相談しましょう。" },
		specialist(messages) {
			const reference = packet(messages, "REFERENCE");
			if (reference.currentWork?.hostEvent) {
				notice = reference.currentWork.hostEvent;
				return reply("タイマーの実行結果を受け取りました。");
			}
			const utterance = messages.at(-1)!.content;
			if (utterance === switching) {
				expect(packet(messages, "CONVERSATION_HANDOFF").recent).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ role: "user", text: original }),
					]),
				);
				return reply("20秒で足りるか、ここから相談を続けます。");
			}
			if (utterance === "通常会話に戻って")
				return {
					action: "return",
					forward: false,
					text: "通常会話に戻ります。",
				};
			const previous = toolResult(messages);
			if (!previous) return invoke("collaboration.task.find", { query: title });
			const card = previous.candidates.find(
				(entry: { id: string }) => entry.id === capability,
			);
			expect(card).toMatchObject({ execution: "command" });
			return invoke(
				"collaboration.task.start",
				{
					expectedRevision: reference.currentWork.revision,
					revisionId: card.revisionId,
					request: create,
				},
				"タイマーの作成を依頼しました。",
			);
		},
	});
	try {
		await configure(h);
		await say(h, original);
		expect(h.dialogue.specialistSession(main)).toBeNull();
		expect((await say(h, switching)).answer).toBe(
			"20秒で足りるか、ここから相談を続けます。",
		);
		const owner = h.dialogue.specialistSession(main)!;
		expect(owner.toolchainId).toBe(task);
		expect(h.timers!.list().items).toHaveLength(0);
		const installed = await h.store.write((db) =>
			h.toolchain.capabilities.importBundleInTransaction(
				db,
				{
					formatVersion: 1,
					bundleId: capability,
					pins: timersBundle.pins,
					definitions: [
						{
							...timersBundle.definitions.at(-1),
							id: capability,
							title,
							revision: 1,
							functionName: "fixture_focus_timer",
						},
					],
				},
				bundleHostOf(h.toolchain.registry),
			),
		);
		expect(installed.issues).toEqual([]);
		expect((await say(h, create)).answer).toBe(
			"タイマーの作成を依頼しました。",
		);
		await waitFor(
			() =>
				h.conversation
					.get(main)
					.messages.some(
						(message) =>
							message.text === "タイマーの実行結果を受け取りました。",
					),
			{ timeout: 7000 },
		);
		expect(h.toolchain.agents.executions.list(main)).toMatchObject([
			{ id: notice!.id, status: "completed" },
		]);
		expect(
			h.timers!.list().items.map((timer) => timer.durationSeconds),
		).toEqual([20]);
		expect(h.dialogue.specialistSession(main)?.id).toBe(owner.id);
		expect((await say(h, "通常会話に戻って")).answer).toBe(
			"通常会話に戻ります。",
		);
		expect(h.dialogue.specialistSession(main)).toBeNull();
	} finally {
		await h.close();
	}
}, 20_000);

test.each(["answer", "cancel"] as const)(
	"a pending execution keeps its identity and accepts %s after the switch",
	async (action) => {
		const original = "時間を決めてからタイマーを設定したい";
		const switching = "この実行をCollaborationに引き継いで";
		const answer = "20秒でお願いします";
		const cancel = "元の実行を取り消して";
		const expectedStatus = action === "answer" ? "completed" : "cancelled";
		const final =
			action === "answer"
				? "引き継いだ実行が完了しました。"
				: "引き継いだ実行を取り消しました。";
		let commands = 0;
		let workId: string;
		const h = await harness({
			pipelines: true,
			timers: true,
			memory: true,
			firstRound: (_tools, question, messages) =>
				question.includes(switching)
					? delegate(task, switching, messages)
					: { text: "時間を決めましょう。" },
			command() {
				commands++;
				return JSON.stringify(
					commands === 1
						? { action: "clarify", question: "何秒のタイマーにしますか？" }
						: {
								action: "invoke",
								tool: "timer.start",
								arguments: { durationSeconds: 20 },
							},
				);
			},
			specialist(messages) {
				const { currentWork } = packet(messages, "REFERENCE");
				if (currentWork.hostEvent)
					return reply(
						currentWork.hostEvent.question
							? "何秒のタイマーにしますか？"
							: final,
					);
				if (messages.at(-1)!.content === switching) {
					expect(currentWork.available.runs).toMatchObject([
						{ id: workId, status: "waiting_user", request: original },
					]);
					return invoke(
						"collaboration.task.attach",
						{
							childId: workId,
							expectedRevision: currentWork.revision,
						},
						"受付済みの実行を引き継ぎました。",
					);
				}
				if (messages.at(-1)!.content === cancel)
					return invoke(
						"collaboration.task.cancel",
						{},
						"取消を元の実行に渡しました。",
					);
				expect(messages.at(-1)!.content).toBe(answer);
				return invoke(
					"collaboration.task.answer",
					{
						questionId: currentWork.child.question.id,
						childRevision: currentWork.child.revision,
						input: answer,
					},
					"時間の指定を元の実行に渡しました。",
				);
			},
		});
		try {
			await configure(h);
			const before = await say(h, original);
			const executions = h.toolchain.agents.executions;
			const started = await h.store.write((db) =>
				executions.startSelectedInTransaction(db, {
					source: h.dialogue.executionSourceInTransaction(db, before.id)!,
					chainRevisionId: h.routing
						.catalogInTransaction(db)
						.find((card) => card.id === "timers.manage")!.revisionId,
					request: original,
					references: [],
					deadline: Date.now() + 180_000,
				}),
			);
			workId = started.id;
			await waitFor(() => executions.get(workId)?.status === "waiting_user");
			expect(commands).toBe(1);
			await say(h, switching);
			const owner = h.dialogue.specialistSession(main)!;
			expect(owner.toolchainId).toBe(task);
			await waitFor(
				() => h.dialogue.specialistSession(main)?.activeRunId === null,
			);
			await say(h, action === "answer" ? answer : cancel);
			await waitFor(
				() =>
					h.conversation
						.get(main)
						.messages.some((message) => message.text === final),
				{ timeout: 7000 },
			);
			expect(executions.list(main)).toMatchObject([
				{ id: workId, status: expectedStatus },
			]);
			expect(commands).toBe(action === "answer" ? 2 : 1);
			expect(
				h.timers!.list().items.map((timer) => timer.durationSeconds),
			).toEqual(action === "answer" ? [20] : []);
			expect(h.dialogue.specialistSession(main)?.id).toBe(owner.id);
		} finally {
			await h.close();
		}
	},
	20_000,
);

test("switching from a specialist parks its unsaved draft and keeps its confirmed condition", async () => {
	const original = "30秒のタイマーの手順を下書きして";
	const switching = "下書きを残してCollaborationに切り替えて";
	const reopen = "保留した手順の共同編集を再開して";
	const pipeline = "collaboration.pipeline";
	const h = await harness({
		pipelines: true,
		timers: true,
		firstRound: (_tools, question, messages) =>
			question.includes(switching)
				? delegate(task, switching, messages)
				: delegate(pipeline, original, messages),
		specialist(messages) {
			const utterance = messages.at(-1)!.content;
			if (messages[0]!.content.includes("collaboration.task.find")) {
				if (utterance === switching) {
					expect(
						packet(messages, "CONVERSATION_HANDOFF").conditions,
					).toMatchObject({
						state: "available",
						entries: [{ id: "duration", text: "30秒" }],
					});
					expect(packet(messages, "COLLABORATION_STATE").facts).toMatchObject([
						{ id: "duration", status: "confirmed", value: "30秒" },
					]);
					return reply("30秒の条件と下書きを引き継ぎました。");
				}
				const found = toolResult(messages)?.candidates;
				if (!found)
					return invoke("collaboration.task.find", { query: "手順の共同編集" });
				const card = found.find(
					(entry: { id: string }) => entry.id === pipeline,
				);
				expect(card).toBeDefined();
				return invoke(
					"collaboration.task.handoff",
					{
						revisionId: card.revisionId,
						request: reopen,
					},
					"手順の共同編集を再開します。",
				);
			}
			if (utterance === switching) return { action: "return", forward: true };
			if (utterance === reopen) {
				expect(messages[1]!.content).toContain("30秒のタイマー");
				return reply("保留した下書きを開きました。");
			}
			const state = packet(messages, "COLLABORATION_STATE");
			const registry = packet(messages, "SOURCE_REGISTRY").host;
			return {
				...invoke(
					"doc.write",
					{
						baseRevision: 0,
						title: "手順",
						content: {
							request: original,
							steps: [
								{
									id: "timer",
									bundle: "timers.manage",
									task: "30秒のタイマー",
									from: ["request"],
									result: "作成済み",
								},
							],
							output: { from: ["timer"], deliver: "作成済みを伝える" },
						},
					},
					"30秒のタイマーの下書きを作りました。",
				),
				stateUpdate: {
					coreContractVersion: 1,
					sessionId: state.sessionId,
					epoch: registry.epoch,
					expectedRevision: state.revision,
					sourceRevision: registry.sourceRevision,
					work: registry.work,
					upserts: [
						{
							id: "duration",
							kind: "condition",
							status: "confirmed",
							value: "30秒",
							sourceRefs: [registry.sources.at(-1).ref],
							supersedes: [],
						},
					],
					removals: [],
				},
			};
		},
	});
	try {
		await configure(h);
		await say(h, original);
		const prior = h.dialogue.specialistSession(main)!;
		expect(prior.toolchainId).toBe(pipeline);
		expect((await say(h, switching)).answer).toBe(
			"30秒の条件と下書きを引き継ぎました。",
		);
		expect(h.dialogue.specialistSession(main)?.toolchainId).toBe(task);
		expect((await say(h, reopen)).answer).toBe("保留した下書きを開きました。");
		expect(h.dialogue.specialistSession(main)?.id).toBe(prior.id);
		expect(h.timers!.list().items).toHaveLength(0);
	} finally {
		await h.close();
	}
}, 20_000);

test("the common entry hands a scheduling request to its registered specialist without starting it during consultation", async () => {
	const schedule = "一時間後に資料を見直すように声をかけて";
	const switching = "この予約の相談をCollaborationと続けたい";
	const at = new Date(Date.now() + 3_600_000)
		.toISOString()
		.replace("Z", "+00:00");
	const text = "資料を見直すように声をかけて";
	const h = await harness({
		pipelines: true,
		schedules: true,
		discoveryTarget: (query) =>
			query === "実行予約" ? "schedule_conversation" : "collaborate_task",
		firstRound: (_tools, question, messages) =>
			question.includes(switching)
				? delegate(task, switching, messages)
				: { text: "この会話でお知らせできます。" },
		specialist(messages) {
			const last = messages.at(-1)!.content;
			if (messages[0]!.content.includes("collaboration.task.find")) {
				if (last === switching) {
					expect(packet(messages, "CONVERSATION_HANDOFF").recent).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ text: schedule }),
						]),
					);
					return reply("資料の見直しの予約を一緒に確認します。");
				}
				const found = toolResult(messages)?.candidates;
				if (!found)
					return invoke("collaboration.task.find", { query: "実行予約" });
				const target = found.find(
					(card: { id: string }) => card.id === "scheduler.manage",
				);
				expect(target).toBeDefined();
				return invoke(
					"collaboration.task.handoff",
					{
						revisionId: target.revisionId,
						request: schedule,
					},
					"実行予約の担当に渡します。",
				);
			}
			if (!toolResult(messages))
				return invoke("scheduler.register", { at, text });
			return {
				action: "return",
				forward: false,
				text: "資料の見直しを予約しました。",
			};
		},
	});
	try {
		await configure(h);
		await say(h, schedule);
		expect((await say(h, switching)).answer).toBe(
			"資料の見直しの予約を一緒に確認します。",
		);
		const items = async () =>
			(
				await (
					await h.request(
						"/api/toolchain-artifacts/artifact:scheduler.pending@2/sources/agenda",
					)
				).json()
			).data.items;
		expect(await items()).toHaveLength(0);
		expect((await say(h, "その内容で予約してください")).answer).toBe(
			"資料の見直しを予約しました。",
		);
		expect(await items()).toHaveLength(1);
	} finally {
		await h.close();
	}
}, 20_000);
