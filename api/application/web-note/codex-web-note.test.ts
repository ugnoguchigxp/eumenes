import { expect, test } from "bun:test";
import { createCodexWebNote, searchModel } from "./codex-web-note";

const environment = {
	PATH: "/bin:/usr/bin",
	HOME: "/home/fixture",
	EUMENES_API_TOKEN: "must-not-reach-codex",
	OPENAI_API_KEY: "must-not-reach-codex",
};
const settings = {
	get: () => ({ agency: {}, resources: [], connections: [] }) as never,
};
const call = {
	model: "model-from-settings" as string | null,
	reasoning: "low" as const,
	webSearch: "live" as const,
	prompt: "指示\n\n依頼:\n調べる",
	signal: new AbortController().signal,
};

test("the turn runs the codex executable with only the allowed environment, locked features and no MCP", async () => {
	const seen: unknown[] = [];
	const note = createCodexWebNote(
		environment,
		"sh",
		{},
		settings,
		async (input) => {
			seen.push(input);
			return { text: "題: 題\n要約: 要\n---\n本文", searches: 1, usage: null };
		},
	);
	const result = await note.turn!(call);
	expect(result.text).toContain("本文");
	const input = seen[0] as Record<string, any>;
	expect(input.command).toEndWith("/sh");
	expect(input.env).toEqual({ PATH: "/bin:/usr/bin", HOME: "/home/fixture" });
	expect(input).toMatchObject({
		model: "model-from-settings",
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
	const note = createCodexWebNote(
		environment,
		"no-such-codex-executable",
		{},
		settings,
	);
	expect(note.turn).toBeUndefined();
});

test("a finished turn is recorded as a Codex SDK attempt of the inference ledger", async () => {
	const recorded: unknown[] = [];
	const note = createCodexWebNote(
		environment,
		"sh",
		{
			recordExternalCodexAttempt: async (attempt) => {
				recorded.push(attempt);
			},
		},
		settings,
	);
	const attempt = {
		subject: "web-note:1",
		model: "model-from-settings",
		started: 1,
		ended: 2,
		status: "succeeded" as const,
		reason: null,
		usage: { input: 10, cachedInput: 4, output: 3, reasoning: 1 },
	};
	await note.record!(attempt);
	expect(recorded).toEqual([attempt]);
});

const saved = (
	agency: { searchResourceId?: string | null },
	kind: string | undefined,
	enabled = true,
	purpose = "llm",
) => ({
	get: () =>
		({
			agency,
			resources: [
				{ id: "r1", connectionId: "c1", purpose, model: "saved-model" },
			],
			connections: [{ id: "c1", kind, enabled }],
		}) as never,
});

test("the model is the saved Codex resource's; unset is Codex's own default; an unusable resource is an error, never another model", () => {
	expect(searchModel(saved({}, "codex-sdk"))).toBeNull();
	expect(
		searchModel(saved({ searchResourceId: null }, "codex-sdk")),
	).toBeNull();
	expect(searchModel(saved({ searchResourceId: "r1" }, "codex-sdk"))).toBe(
		"saved-model",
	);
	for (const unusable of [
		saved({ searchResourceId: "r1" }, "openai-compatible"),
		saved({ searchResourceId: "r1" }, undefined),
		saved({ searchResourceId: "r1" }, "codex-sdk", false),
		saved({ searchResourceId: "r1" }, "codex-sdk", true, "tts"),
		saved({ searchResourceId: "gone" }, "codex-sdk"),
	])
		expect(() => searchModel(unusable)).toThrow(
			"web_note_search_resource_invalid",
		);
});

test("a turn without a saved model leaves the model to Codex", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const note = createCodexWebNote(
		environment,
		"sh",
		{},
		saved({}, "codex-sdk"),
		async (input) => {
			seen.push(input as never);
			return { text: "x", searches: 0, usage: null };
		},
	);
	await note.turn!({ ...call, model: null });
	expect("model" in seen[0]!).toBe(false);
	expect(note.model!()).toBeNull();
});
