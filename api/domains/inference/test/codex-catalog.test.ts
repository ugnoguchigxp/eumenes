import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { leanCatalog } from "../adapters/codex-catalog";
import { codexCall, fakeCodex, user } from "./codex.fixture";

const entry = (slug: string) => ({
	slug,
	context_window: 1000,
	shell_type: "unified_exec",
	tool_mode: "code_mode_only",
	multi_agent_version: "v2",
	experimental_supported_tools: ["clock"],
	apply_patch_tool_type: "freeform",
	web_search_tool_type: "text",
});

test("the catalog a process reads has Codex's own tools and agent team off for every model and keeps the rest", () => {
	const lean = leanCatalog({ models: [entry("a"), entry("b")] });
	expect(lean?.models).toEqual(
		["a", "b"].map((slug) => ({
			...entry(slug),
			tool_mode: null,
			multi_agent_version: null,
			experimental_supported_tools: [],
			apply_patch_tool_type: null,
		})),
	);
	for (const bad of [
		null,
		{},
		{ models: [] },
		{ models: [{}] },
		{ models: "x" },
	])
		expect(leanCatalog(bad)).toBeNull();
});

test("a process starts with the catalog the CLI lists under the same home and login; a Web search process keeps Codex's own", async () => {
	const codex = await fakeCodex();
	try {
		await codex.behave({ catalog: { models: [entry("listed")] } });
		const agents = codex.agents(codex.host());
		await agents.run(
			codexCall([user("hello")], {
				credential: "key",
				baseUrl: "https://api.example.test/v1",
			}),
		);
		await codex.behave({
			catalog: { models: [entry("listed")] },
			search: "this",
		});
		await agents.run(codexCall([user("lookup")], { nativeWebSearch: true }));
		const [listed] = await codex.of("catalog");
		expect(await codex.of("catalog")).toHaveLength(1);
		expect(listed!.params).toEqual({
			argv: [
				"debug",
				"models",
				"-c",
				'openai_base_url="https://api.example.test/v1"',
			],
			home: codex.home,
			key: "key",
		});
		const [plain, search] = (await codex.of("spawn")).map(
			(r) => r.params.argv as string[],
		);
		const override = plain!.find((arg) =>
			arg.startsWith("model_catalog_json="),
		);
		expect(override).toBeDefined();
		expect(search!.some((arg) => arg.startsWith("model_catalog_json="))).toBe(
			false,
		);
		const file = JSON.parse(override!.slice("model_catalog_json=".length));
		expect(file.startsWith(codex.home)).toBe(true);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
			leanCatalog({ models: [entry("listed")] }),
		);
	} finally {
		await codex.cleanup();
	}
});

test("a CLI that lists no catalog starts the process with Codex's own", async () => {
	const codex = await fakeCodex();
	try {
		await codex.agents(codex.host()).run(codexCall([user("hello")]));
		expect(await codex.of("catalog")).toHaveLength(1);
		const [spawn] = await codex.of("spawn");
		expect(
			(spawn!.params.argv as string[]).some((arg) =>
				arg.startsWith("model_catalog_json="),
			),
		).toBe(false);
	} finally {
		await codex.cleanup();
	}
});

test("a function is offered as one line: its name, the type of its arguments and what it does", async () => {
	const { argumentType, codexFunctionLines } =
		await import("../adapters/cloud-agent-codex");
	const parameters = {
		type: "object",
		additionalProperties: false,
		required: ["kind", "what"],
		properties: {
			kind: { type: "string", enum: ["remember", "forget"] },
			what: { type: "string", description: "left out", maxLength: 10 },
			count: { type: "integer", minimum: 1 },
			names: { type: "array", items: { type: "string" } },
			slot: { anyOf: [{ type: "integer" }, { type: "null" }] },
			target: {
				type: "object",
				required: ["kind"],
				properties: { kind: { const: "schedule" }, at: { type: "string" } },
			},
		},
	};
	expect(argumentType(parameters)).toBe(
		'{kind: "remember"|"forget", what: string, count?: number, names?: string[], slot?: number|null, target?: {kind: "schedule", at?: string}}',
	);
	expect(
		codexFunctionLines([
			{
				type: "function",
				function: { name: "read", description: "記録を\n確かめる", parameters },
			},
			{
				type: "function",
				function: {
					name: "list",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			},
		]),
	).toBe(`read(${argumentType(parameters)}) 記録を 確かめる\nlist({})`);
});
