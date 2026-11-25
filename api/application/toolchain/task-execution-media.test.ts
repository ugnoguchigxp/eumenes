import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { assignmentFixture } from "./assignment.fixture";
import { imageFixture } from "../media/image.fixture";
import { TASK_TOOLCHAIN } from "./task-delegation.fixture";

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
			return f.model.answer(...args);
		},
	};
	const fx = await assignmentFixture({
		everyday: true,
		model,
		imageGateway: f.gateway,
		discoveryTarget: (query) =>
			query === "create an image" ? "image" : "execute_task",
	});
	const { h } = fx;
	try {
		const text = "二つの異なる画像を生成して";
		const { source } = await fx.assign(
			text,
			TASK_TOOLCHAIN,
			undefined,
			"Create two distinct images",
		);
		// The same source asked again is the same execution: duplicate acceptance reuses the same parent.
		await fx.assignRun(
			source.runId,
			TASK_TOOLCHAIN,
			undefined,
			"Create two distinct images",
		);
		await fx.until(() => fx.executions()[0]?.status === "completed");
		expect(fx.executions()).toHaveLength(1);
		const records = h.image!.list(fx.conversationId);
		expect(records).toHaveLength(2);
		expect(new Set(records.map((r) => r.id)).size).toBe(2);
		expect(new Set(records.map((r) => r.artifactId)).size).toBe(2);
		expect(
			records.every((r) => r.runId === source.runId && r.state === "completed"),
		).toBe(true);
		expect(
			f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		).toHaveLength(2);
		await h.store.write((db) =>
			h.toolchain.agents.executions.purgeSourcesInTransaction(db, {
				messageIds: [source.messageId],
				itemIds: [],
			}),
		);
		const bodies = h.store.read((db) =>
			db.query("SELECT request_json FROM image_generations").all(),
		) as { request_json: string }[];
		expect(
			bodies.every(
				(r) =>
					!r.request_json.includes(text) &&
					JSON.parse(r.request_json).execution.erased === 1,
			),
		).toBe(true);
		expect(fx.executions()).toEqual([]);
		const erased = h.store.read((db) =>
			db.query("SELECT state_json FROM agent_executions").all(),
		) as { state_json: string }[];
		expect(erased.every((row) => !JSON.parse(row.state_json).plan)).toBe(true);
	} finally {
		await fx.close();
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
			return base.answer(...args);
		},
	};
}

test("music generation calls use independent records and both reach confirmed completion", async () => {
	const { musicFixture } = await import("../media/music.fixture");
	const f = musicFixture();
	const fx = await assignmentFixture({
		everyday: true,
		model: repeatMediaModel(f.model, "music"),
		musicGateway: f.gateway,
		discoveryTarget: discoveryFor("music"),
	});
	const { h } = fx;
	try {
		const { source } = await fx.assign(
			"異なる二曲を作って",
			TASK_TOOLCHAIN,
			undefined,
			"Create two items",
		);
		await fx.until(() => fx.executions()[0]?.status === "completed");
		const rows = h.music!.list(fx.conversationId);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.id)).size).toBe(2);
		expect(
			rows.every((r) => r.runId === source.runId && r.state === "completed"),
		).toBe(true);
	} finally {
		await fx.close();
	}
}, 15000);

test("drawing calls keep two independent draft URLs without claiming they were saved", async () => {
	const { excalidrawFixture } = await import("../media/excalidraw.fixture");
	const f = excalidrawFixture();
	const fx = await assignmentFixture({
		everyday: true,
		model: repeatMediaModel(f.model, "drawing_editor"),
		drawingConnection: f.connection,
		drawingFetch: f.fetcher,
		discoveryTarget: discoveryFor("drawing_editor"),
	});
	const { h } = fx;
	try {
		const { source } = await fx.assign(
			"二つの図の下書きを開いて",
			TASK_TOOLCHAIN,
			undefined,
			"Create two items",
		);
		await fx.until(() => fx.executions()[0]?.status === "completed");
		const rows = h.drawingOperations!.list(fx.conversationId);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.url)).size).toBe(2);
		expect(
			rows.every((r) => r.runId === source.runId && r.state === "completed"),
		).toBe(true);
		expect(h.excalidraw!.list(fx.conversationId)).toEqual([]);
	} finally {
		await fx.close();
	}
}, 15000);
