import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { imageFixture } from "../media/image.fixture";
import { routedChoice } from "./conversation-script.fixture";
import { handOverTask } from "./task-delegation.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("two image calls from one public source keep distinct generation/artifact IDs; duplicate acceptance reuses the same parent and forgetting erases source copies without uniqueness collisions", async () => {
	const f = imageFixture("success", undefined, (n) => `generated-${n}`);
	let steps = 0;
	const model = {
		...f.model,
		answer: async (...args: Parameters<typeof f.model.answer>) => {
			const [messages, , options] = args;
			if (options?.tools?.some((t) => t.function.name === "report_partial")) {
				const packet = JSON.parse(messages.at(-1)!.content);
				const planning = packet.plan.required;
				if (!planning) steps++;
				const choice = planning
					? taskPlan("Create image 1", "Create image 2")
					: steps === 1
						? {
								name: "find_toolchain",
								arguments: { query: "create an image" },
							}
						: steps <= 3
							? {
									name: "image",
									arguments: {
										stepRef: taskItem(packet, steps - 2),
										contextRefs: [],
									},
								}
							: {
									name: "complete_task",
									arguments: {
										summary: "二つの画像を生成しました。",
										fulfilled: ["two distinct images"],
										missing: [],
										refs: packet.results.flatMap(
											(r: { refs: string[] }) => r.refs,
										),
									},
								};
				options.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: choice.name,
						arguments: JSON.stringify(choice.arguments),
					},
				]);
				return "";
			}
			// The conversation's choice (the local harness's routed turn): the task is handed over.
			const routed = routedChoice(options, messages, (loop) =>
				handOverTask(
					"Create two distinct images",
					"二つの画像を生成します。",
				)(loop),
			);
			if (routed) return routed;
			return f.model.answer(...args);
		},
	};
	const h = await harness({
		everyday: true,
		model,
		imageGateway: f.gateway,
		discoveryTarget: (query) =>
			query === "create an image" ? "image" : "execute_task",
	});
	try {
		const input = {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "二つの異なる画像を生成して",
		};
		const source = await h.dialogue.submit(input);
		expect((await h.dialogue.submit(input)).id).toBe(source.id);
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status === "completed",
			{ timeout: 8000 },
		);
		const records = h.image!.list("main");
		expect(records).toHaveLength(2);
		expect(new Set(records.map((r) => r.id)).size).toBe(2);
		expect(new Set(records.map((r) => r.artifactId)).size).toBe(2);
		expect(
			records.every((r) => r.runId === source.id && r.state === "completed"),
		).toBe(true);
		expect(
			f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		).toHaveLength(2);
		await h.store.write((db) =>
			h.toolchain.agents.executions.purgeSourcesInTransaction(db, {
				messageIds: [source.inputMessageId],
				itemIds: [],
			}),
		);
		const bodies = h.store.read((db) =>
			db.query("SELECT request_json FROM image_generations").all(),
		) as { request_json: string }[];
		expect(
			bodies.every(
				(r) =>
					!r.request_json.includes(input.text) &&
					JSON.parse(r.request_json).execution.erased === 1,
			),
		).toBe(true);
		expect(h.toolchain.agents.executions.list("main")).toEqual([]);
		const erased = h.store.read((db) =>
			db.query("SELECT state_json FROM agent_executions").all(),
		) as { state_json: string }[];
		expect(erased.every((row) => !JSON.parse(row.state_json).plan)).toBe(true);
	} finally {
		await h.close();
	}
}, 15000);

/** The parent's request finds the task toolchain; the child's search `use <name>` finds the media toolchain. */
function discoveryFor(name: string) {
	return (query: string) => (query === `use ${name}` ? name : "execute_task");
}

function repeatMediaModel(
	base: import("../../domains/larm").LarmPort,
	name: string,
) {
	let calls = 0;
	return {
		...base,
		answer: async (...args: Parameters<typeof base.answer>) => {
			const [messages, , options] = args;
			if (options?.tools?.some((t) => t.function.name === "report_partial")) {
				const packet = JSON.parse(messages.at(-1)!.content);
				const planning = packet.plan.required;
				if (!planning) calls++;
				const choice = planning
					? taskPlan("Make item 1", "Make item 2")
					: calls === 1
						? { name: "find_toolchain", arguments: { query: `use ${name}` } }
						: calls <= 3
							? {
									name,
									arguments: {
										stepRef: taskItem(packet, calls - 2),
										contextRefs: [],
									},
								}
							: {
									name: "complete_task",
									arguments: {
										summary: "二つの処理結果を確認しました。",
										fulfilled: ["two independent calls"],
										missing: [],
										refs: packet.results.flatMap(
											(r: { refs: string[] }) => r.refs,
										),
									},
								};
				options.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: choice.name,
						arguments: JSON.stringify(choice.arguments),
					},
				]);
				return "";
			}
			// The conversation's choice (the local harness's routed turn): the task is handed over.
			const routed = routedChoice(options, messages, (loop) =>
				handOverTask("Create two items", "二つの処理を進めます。")(loop),
			);
			if (routed) return routed;
			if (messages.some((m) => m.content.includes("task_result")))
				return "処理結果を確認しました。";
			return base.answer(...args);
		},
	};
}

test("music generation calls use independent records and both reach confirmed completion", async () => {
	const { musicFixture } = await import("../media/music.fixture");
	const f = musicFixture();
	const h = await harness({
		everyday: true,
		model: repeatMediaModel(f.model, "music"),
		musicGateway: f.gateway,
		discoveryTarget: discoveryFor("music"),
	});
	try {
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "異なる二曲を作って",
		});
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status === "completed",
			{ timeout: 8000 },
		);
		const rows = h.music!.list("main");
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.id)).size).toBe(2);
		expect(
			rows.every((r) => r.runId === source.id && r.state === "completed"),
		).toBe(true);
	} finally {
		await h.close();
	}
}, 15000);

test("drawing calls keep two independent draft URLs without claiming they were saved", async () => {
	const { excalidrawFixture } = await import("../media/excalidraw.fixture");
	const f = excalidrawFixture();
	const h = await harness({
		everyday: true,
		model: repeatMediaModel(f.model, "drawing_editor"),
		drawingConnection: f.connection,
		drawingFetch: f.fetcher,
		discoveryTarget: discoveryFor("drawing_editor"),
	});
	try {
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "二つの図の下書きを開いて",
		});
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status === "completed",
			{ timeout: 8000 },
		);
		const rows = h.drawingOperations!.list("main");
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.url)).size).toBe(2);
		expect(
			rows.every((r) => r.runId === source.id && r.state === "completed"),
		).toBe(true);
		expect(h.excalidraw!.list("main")).toEqual([]);
	} finally {
		await h.close();
	}
}, 15000);
