import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { assignmentFixture } from "./assignment.fixture";
import { objectRecognitionFixture } from "../media/object-recognition.fixture";
import { TASK_TOOLCHAIN } from "./task-delegation.fixture";

test("a public parent hands camera interaction to the existing screen without taking a capture or declaring the request complete", async () => {
	const fixture = objectRecognitionFixture();
	let steps = 0;
	const f = await assignmentFixture({
		everyday: true,
		recognitionFetcher: fixture.fetcher,
		discoveryTarget: (query) =>
			query === "object observation screen"
				? "object_recognition"
				: "execute_task",
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
				: steps === 2
					? {
							name: "object_recognition",
							arguments: {
								stepRef: taskItem(packet),
								contextRefs: [],
							},
						}
					: {
							name: "report_partial",
							arguments: {
								summary: "画面を開きました。",
								fulfilled: ["画面を開く"],
								missing: ["利用者による観測"],
								refs: packet.results.flatMap((r: { refs: string[] }) => r.refs),
							},
						};
		},
	});
	const { h } = f;
	try {
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18786",
			credential: "fixture-only-recognition-credential",
		});
		const { source } = await f.assign(
			"観測の画面を準備し、結果を使ってください",
			TASK_TOOLCHAIN,
			undefined,
			"Open the object observation workspace, then use an observation",
		);
		await f.until(() => f.executions()[0]?.status === "partial");
		// The screen was opened (a success of the command); the observation itself is the user's to take.
		expect(f.executions()[0]?.result?.summary).toBe("画面を開きました。");
		const opened = h.store
			.read((db) =>
				db
					.query("SELECT result_json FROM agent_execution_steps ORDER BY rowid")
					.all(),
			)
			.map((row) => (row as { result_json: string }).result_json)
			.join("\n");
		expect(opened).toContain('"state":"completed"');
		expect(opened).toContain("物体認識の画面を開き");
		expect(opened).not.toContain("interactive_handoff");
		const calls = h.store.read((db) =>
			db
				.query(
					"SELECT call_id,run_id,result_json FROM object_recognition_execution_commands",
				)
				.all(),
		) as Array<{ call_id: string; run_id: string; result_json: string }>;
		expect(calls).toHaveLength(1);
		expect(calls[0]!.run_id).toBe(source.runId);
		expect(calls[0]!.call_id).not.toBe(source.runId);
		expect(JSON.parse(calls[0]!.result_json)).toMatchObject({
			action: "open",
			state: "ready_for_input",
		});
		expect(fixture.calls).toEqual([]);
	} finally {
		await f.close();
	}
}, 10000);
