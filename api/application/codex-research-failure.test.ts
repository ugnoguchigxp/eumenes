import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexResearch } from "../domains/inference";
import type { LarmPort } from "../domains/larm";
import { configureLogging } from "../infrastructure/logger";
import { harness } from "./toolchain.fixture";

test("SDK process failure reaches correlated logs and current answer context with zero Web operations", async () => {
	const dir = await mkdtemp(join(tmpdir(), "eumenes-sdk-failure-"));
	const command = join(dir, "codex");
	await writeFile(
		command,
		`#!${process.execPath}\nimport { readFileSync } from "node:fs";\nimport assert from "node:assert/strict";\nconst argv = process.argv.slice(2);\nconst instructionArg = argv.find(v => v.startsWith("model_instructions_file="));\nconst text = readFileSync(JSON.parse(instructionArg.slice("model_instructions_file=".length)), "utf8");\nassert.ok(!argv.includes("--output-schema"));\nassert.equal(text.split("\\nOUTPUT_FORMAT=").length, 2);\nconst forms = JSON.parse(text.split("\\nOUTPUT_FORMAT=")[1]);\nassert.equal(forms[0].action, "invoke");\nassert.deepEqual(Object.keys(forms[0]), ["action", "tool", "arguments"]);\nassert.equal(forms[1].action, "finish");\nassert.deepEqual(Object.keys(forms[1]), ["action", "report"]);\nconsole.error("HTTP 401 invalid_api_key PRIVATE_PROVIDER_CREDENTIAL"); process.exit(7);\n`,
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
	let currentContext = false;
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			const question = messages
				.filter((m) => m.role === "user")
				.at(-1)!.content;
			if (question === "以前の記録") return "制御JSONが不正でした。";
			if (options?.tools?.length) {
				options.onToolCalls!([
					{
						id: "research",
						name: "web_research",
						arguments: JSON.stringify({ request: question }),
					},
				]);
				return "";
			}
			const notice = messages.find(
				(m) =>
					m.role === "system" &&
					m.content.includes("CURRENT_RESEARCH_FAILURE="),
			)!;
			expect(
				JSON.parse(notice.content.split("CURRENT_RESEARCH_FAILURE=")[1]!),
			).toMatchObject({ code: "codex_research_http_401" });
			expect(
				messages.some(
					(m) => m.role === "assistant" && m.content.includes("制御JSON"),
				),
			).toBe(true);
			const result = JSON.parse(messages.at(-2)!.content);
			expect(result.report.researchProgress).toMatchObject({
				searchAttempts: 0,
				readAttempts: 0,
				verifiedReport: false,
			});
			currentContext = true;
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
		await h.dialogue.waitForTerminal(previous.id, { timeoutMs: 5000 });
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "今日のAIニュースを教えて。",
		});
		const run = await response.json();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		expect(currentContext).toBe(true);
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
		await rm(dir, { recursive: true, force: true });
	}
});
