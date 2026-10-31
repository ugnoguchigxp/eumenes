import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { objectRecognitionFixture } from "../media/object-recognition.fixture";
import { handOverTask } from "./task-delegation.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("a public parent hands camera interaction to the existing screen without taking a capture or declaring the request complete", async () => {
	const f = objectRecognitionFixture();
	let steps = 0;
	const h = await harness({
		everyday: true,
		recognitionFetcher: f.fetcher,
		discoveryTarget: (query) =>
			query === "object observation screen"
				? "object_recognition"
				: "execute_task",
		firstRound: (_tools, _question, messages) =>
			handOverTask(
				"Open the object observation workspace, then use an observation",
				"観測の画面を準備します。",
			)(messages),
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "object-recognition.manage",
				arguments: {
					action: "open",
					id: "",
					frameIndex: -1,
					source: "camera",
					question: "",
				},
			}),
		taskStep: (_tools, messages) => {
			const packet = JSON.parse(messages.at(-1)!.content);
			if (packet.plan.required)
				return taskPlan("Open the observation workspace");
			return ++steps === 1
				? {
						name: "find_toolchain",
						arguments: { query: "object observation screen" },
					}
				: {
						name: "object_recognition",
						arguments: {
							stepRef: taskItem(packet),
							contextRefs: [],
						},
					};
		},
	});
	try {
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-only-recognition-credential",
		});
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "観測の画面を準備し、結果を使ってください",
		});
		await waitFor(
			() => h.toolchain.agents.executions.list("main")[0]?.status === "partial",
			{ timeout: 5000 },
		);
		expect(h.toolchain.agents.executions.list("main")[0]?.result?.code).toBe(
			"interactive_handoff",
		);
		const calls = h.store.read((db) =>
			db
				.query(
					"SELECT call_id,run_id,result_json FROM object_recognition_execution_commands",
				)
				.all(),
		) as Array<{ call_id: string; run_id: string; result_json: string }>;
		expect(calls).toHaveLength(1);
		expect(calls[0]!.run_id).toBe(source.id);
		expect(calls[0]!.call_id).not.toBe(source.id);
		expect(JSON.parse(calls[0]!.result_json)).toMatchObject({
			action: "open",
			state: "ready_for_input",
		});
		expect(f.calls).toEqual([]);
	} finally {
		await h.close();
	}
}, 10000);
