import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexResearch } from "../../domains/inference";
import type { LarmPort } from "../../domains/larm";
import { configureLogging } from "../../infrastructure/logger";
import { RESEARCH_FAILURE_REPLY } from "../../domains/dialogue/service/research-failure-reply";
import { answerAnalysis } from "./analysis-round.fixture";
import { harness } from "./toolchain.fixture";

test("SDK process failure reaches correlated logs and is answered by the fixed reply with zero Web operations", async () => {
	const dir = await mkdtemp(join(tmpdir(), "eumenes-sdk-failure-"));
	const command = join(dir, "codex");
	await writeFile(
		command,
		`#!${process.execPath}\nimport { readFileSync } from "node:fs";\nimport assert from "node:assert/strict";\nconst argv = process.argv.slice(2);\nconst instructionArg = argv.find(v => v.startsWith("model_instructions_file="));\nconst text = readFileSync(JSON.parse(instructionArg.slice("model_instructions_file=".length)), "utf8");\nassert.ok(!argv.includes("--output-schema"));\nassert.equal(text.split("\\nOUTPUT_SCHEMA=").length, 2);\nconst schema = JSON.parse(text.split("\\nOUTPUT_SCHEMA=")[1]);\nassert.deepEqual(schema.oneOf.map(f => f.properties.action.const), ["invoke", "wait", "finish"]);\nconsole.error("HTTP 401 invalid_api_key PRIVATE_PROVIDER_CREDENTIAL"); process.exit(7);\n`,
		{ mode: 0o700 },
	);
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	let failureAskedOfModel = false;
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			if (messages[0]?.content.includes("FUNCTIONS="))
				return JSON.stringify({
					decision: "answer",
					functionName: "",
					request: "",
					questionRef: "",
				});
			const question = messages
				.filter((m) => m.role === "user")
				.at(-1)!.content;
			if (
				answerAnalysis(
					messages,
					options,
					question === "以前の記録"
						? { kind: "chat", next: "answer" }
						: { kind: "live_info", freshness: "live" },
				)
			)
				return "";
			if (question === "以前の記録") return "制御JSONが不正でした。";
			if (options?.tools?.length) {
				options.onToolCalls!([
					{
						id: "research",
						name: "web_research",
						arguments: JSON.stringify({
							request: question,
							announcement: "調べます。",
						}),
					},
				]);
				return "";
			}
			// The failure is answered by the host: the model is not asked to phrase it.
			failureAskedOfModel = true;
			return "調査担当の認証で失敗し、情報を取得できませんでした。";
		},
	};
	const h = await harness({
		model,
		codexResearch: createCodexResearch({ HOME: dir, PATH: "" }, command),
	});
	try {
		const previous = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "以前の記録",
		});
		expect(
			(await h.dialogue.waitForTerminal(previous.id, { timeoutMs: 5000 }))
				?.status,
		).toBe("completed");
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "今日のAIニュースを教えて。",
		});
		const run = await response.json();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(failureAskedOfModel).toBe(false);
		expect(h.dialogue.answerText(run.id)).toBe(RESEARCH_FAILURE_REPLY);
		expect(h.acquisitions).toBe(0);
		const failed = lines
			.map((l) => JSON.parse(l))
			.find(
				(e) => e.event === "inference.attempt_failed" && e.source === "codex",
			);
		expect(failed).toMatchObject({
			reason: "codex_research_http_401",
			status: 401,
			exitCode: 7,
			phase: "sdk_turn",
		});
		expect(failed.inferenceId).toBeTruthy();
		expect(failed.jobId).toBeTruthy();
		expect(lines.some((l) => l.includes("PRIVATE_PROVIDER_CREDENTIAL"))).toBe(
			false,
		);
	} finally {
		await h.close();
		configureLogging({ level: "silent" });
		await rm(dir, { recursive: true, force: true });
	}
});
