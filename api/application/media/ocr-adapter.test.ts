import { expect, test } from "bun:test";
import type { LarmPort } from "../../domains/larm";
import { answerUtterance } from "./conversation-turn.fixture";
import {
	ask,
	assignmentAgenda,
	ended,
	executions,
	until,
} from "./assignment.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";
test("OCR bundle exposes one artifact and the command agent opens it for the assignment", async () => {
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			const turn = answerUtterance(
				options,
				messages,
				options?.onToolCalls,
				() => ({ text: "承知しました。" }),
			);
			if (turn !== undefined) return turn;
			if (
				messages[0]?.content.includes(
					"あなたはこのツールチェーンの操作担当です",
				)
			)
				return JSON.stringify({
					action: "invoke",
					tool: "ocr.open",
					arguments: {},
				});
			return "文字を読み取る画面を開きました。";
		},
	};
	const a = await assignmentAgenda({
		harness: {
			model,
			settingsEnv: { LARM_API_TOKEN: "fixture-shared-token" },
			ocrFetcher: (async () =>
				Response.json({
					kind: "image",
					model: "fixture",
					width: 100,
					height: 100,
					text: "",
					lines: [],
				})) as unknown as typeof fetch,
		},
	});
	const h = a.h;
	try {
		await a.start();
		const artifacts = await (
			await h.request("/api/toolchain-artifacts")
		).json();
		expect(JSON.stringify(artifacts)).toContain("ocr.workspace");
		await ask(a, "ocr.manage", "文字を読み取る画面を開いて");
		await until(a, () => ended(a));
		expect(executions(a)).toHaveLength(1);
		const command = h.store.read(
			(db) =>
				db.query("SELECT result_json FROM ocr_commands LIMIT 1").get() as {
					result_json: string;
				} | null,
		);
		expect(command && JSON.parse(command.result_json)).toEqual({
			action: "open",
			state: "ready_for_input",
		});
	} finally {
		await a.close();
	}
}, 30_000);
test("OCR command read is scoped to the conversation and exposes bounded raw result", async () => {
	const h = await harness({
		settingsEnv: { LARM_API_TOKEN: "fixture-shared-token" },
		ocrFetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 100,
				height: 100,
				text: "原文",
				lines: [
					{
						text: "原文",
						confidence: 0.8,
						polygon: [
							[1, 1],
							[20, 1],
							[20, 15],
							[1, 15],
						],
					},
				],
			})) as unknown as typeof fetch,
	});
	try {
		await h.settings.configureOcr({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:18794/",
		});
		const id = crypto.randomUUID();
		await h.ocr!.upload(
			"local:owner",
			"main",
			new File(["png"], "note.png", { type: "image/png" }),
			id,
		);
		await waitFor(() => h.ocr!.get("local:owner", id).state === "completed");
		const { createOcrAdapter } = await import("./ocr-adapter");
		const adapter = createOcrAdapter(h.ocr!);
		const invoke = (conversationId: string) =>
			h.store.write((db) =>
				adapter.invokeInTransaction(db, {
					operationName: "ocr.read",
					input: { id },
					requestId: crypto.randomUUID(),
					issuedAt: new Date().toISOString(),
					origin: {
						kind: "conversation",
						owner: {
							rootRunId: crypto.randomUUID(),
							taskId: crypto.randomUUID(),
							cancelEpoch: 0,
						},
						runId: crypto.randomUUID(),
						conversationId,
						messageId: crypto.randomUUID(),
					},
				}),
			);
		const read = await invoke("main");
		expect(JSON.stringify(read.answerContext)).toContain("原文");
		expect(JSON.stringify(read.answerContext)).not.toContain(
			"fixture-shared-token",
		);
		await expect(invoke("other")).rejects.toThrow("ocr_not_found");
	} finally {
		await h.close();
	}
});
