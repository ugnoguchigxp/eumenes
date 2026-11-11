import { expect, test } from "bun:test";
import { createCodexWebNote } from "./codex-web-note";

const environment = {
	PATH: "/bin:/usr/bin",
	HOME: "/home/fixture",
	EUMENES_API_TOKEN: "must-not-reach-codex",
	OPENAI_API_KEY: "must-not-reach-codex",
};
const call = {
	model: "research-model",
	reasoning: "low" as const,
	webSearch: "live" as const,
	prompt: "指示\n\n依頼:\n調べる",
	signal: new AbortController().signal,
};

test("the turn runs the codex executable with only the allowed environment, locked features and no MCP", async () => {
	const seen: unknown[] = [];
	const note = createCodexWebNote(environment, "sh", {}, async (input) => {
		seen.push(input);
		return { text: "題: 題\n要約: 要\n---\n本文", searches: 1, usage: null };
	});
	const result = await note.turn!(call);
	expect(result.text).toContain("本文");
	const input = seen[0] as Record<string, any>;
	expect(input.command).toEndWith("/sh");
	expect(input.env).toEqual({ PATH: "/bin:/usr/bin", HOME: "/home/fixture" });
	expect(input).toMatchObject({
		model: "research-model",
		reasoning: "low",
		webSearch: "live",
		prompt: call.prompt,
		signal: call.signal,
		configOverrides: ["mcp_servers={}"],
	});
	expect(input.config.features).toMatchObject({
		shell_tool: false,
		plugins: false,
		js_repl: false,
		skip_host_skill_discovery: true,
	});
	// The web search runs through the code mode host: turned off, the turn cannot search (live check 2026-11-11).
	expect(input.config.features).not.toHaveProperty("code_mode_host");
	expect(input.config.project_doc_max_bytes).toBe(0);
	expect(input.config.history).toEqual({ persistence: "none" });
});

test("without a codex executable there is no turn, so the task is not offered", () => {
	const note = createCodexWebNote(environment, "no-such-codex-executable", {});
	expect(note.turn).toBeUndefined();
});

test("a finished turn is recorded as a Codex SDK attempt of the inference ledger", async () => {
	const recorded: unknown[] = [];
	const note = createCodexWebNote(environment, "sh", {
		recordExternalCodexAttempt: async (attempt) => {
			recorded.push(attempt);
		},
	});
	const attempt = {
		subject: "web-note:1",
		model: "research-model",
		started: 1,
		ended: 2,
		status: "succeeded" as const,
		reason: null,
		usage: { input: 10, cachedInput: 4, output: 3, reasoning: 1 },
	};
	await note.record!(attempt);
	expect(recorded).toEqual([attempt]);
});
