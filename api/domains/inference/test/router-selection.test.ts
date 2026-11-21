import { expect, test } from "bun:test";
import {
	configureLogging,
	withLogContext,
} from "../../../infrastructure/logger";
import { defaults } from "../../settings";
import { createRouterSelection } from "../service/router-selection";

const fixture = () => {
	const saved = defaults({});
	const conn = {
		id: crypto.randomUUID(),
		name: "test",
		baseUrl: "https://api.openai.com/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	};
	const resource = {
		id: crypto.randomUUID(),
		connectionId: conn.id,
		purpose: "llm" as const,
		model: "fixture",
		contextWindow: 1000,
		voice: null,
	};
	saved.connections.push(conn);
	saved.resources.push(resource);
	saved.routes.llm = {
		...saved.routes.llm,
		cloudAllowed: true,
		mode: "cloud-only",
		fallbackId: resource.id,
	};
	return { saved, conn };
};

const prompt = {
	version: "selection-test",
	system: "rules",
	user: "request",
	outputSchema: { type: "object" },
};

test("selection sends the saved model, schema and reasoning none to OpenAI Responses", async () => {
	const { saved } = fixture();
	const signal = new AbortController().signal;
	const port = createRouterSelection(
		{ get: () => saved, credential: () => "connection-test" },
		async (url, init) => {
			expect(url).toBe("https://api.openai.com/v1/responses");
			expect(init?.redirect).toBe("error");
			expect(init?.signal).toBe(signal);
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer configured-test",
			);
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: saved.resources[0]!.model,
				store: false,
				reasoning: { effort: "none" },
				text: {
					format: {
						type: "json_schema",
						strict: true,
						schema: prompt.outputSchema,
					},
				},
			});
			return Response.json({
				status: "completed",
				output: [
					{
						type: "message",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text: "{}" }],
					},
				],
			});
		},
		{ OPEN_AI_API_KEY: "configured-test" },
	);
	expect(await port.selectRouter(prompt, signal)).toBe("{}");
});

test("selection respects cloud settings and confines the API key to the official origin", async () => {
	const { saved, conn } = fixture();
	const port = createRouterSelection(
		{ get: () => saved, credential: () => null },
		async () => {
			throw new Error("unexpected_fetch");
		},
		{ OPEN_AI_API_KEY: "configured-test" },
	);
	expect(port.routerSelectionAvailable()).toBe(true);
	saved.routes.llm.cloudAllowed = false;
	expect(port.routerSelectionAvailable()).toBe(false);
	saved.routes.llm.cloudAllowed = true;
	conn.baseUrl = "https://example.test/?openai";
	expect(port.routerSelectionAvailable()).toBe(false);
	await expect(
		port.selectRouter(prompt, new AbortController().signal),
	).rejects.toThrow("router_selection_unavailable");
});

test("selection logs numeric usage with the run and omits invalid or absent counts", async () => {
	const { saved } = fixture();
	const lines: string[] = [];
	let valid = true;
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	try {
		const port = createRouterSelection(
			{ get: () => saved, credential: () => "connection-test" },
			async () =>
				Response.json({
					status: valid ? "completed" : "incomplete",
					usage: {
						input_tokens: 100,
						input_tokens_details: { cached_tokens: valid ? 80 : 120 },
						output_tokens: valid ? 12 : undefined,
					},
					output: [
						{
							type: "message",
							status: "completed",
							role: "assistant",
							content: [
								{ type: "output_text", text: "fixture-private-response" },
							],
						},
					],
				}),
			{},
		);
		const select = () =>
			withLogContext({ runId: "selection-run" }, () =>
				port.selectRouter(prompt, new AbortController().signal),
			);
		expect(await select()).toBe("fixture-private-response");
		valid = false;
		await expect(select()).rejects.toThrow("router_selection_incomplete");
		const measured = lines
			.map((line) => JSON.parse(line))
			.filter((e) => e.event === "inference.router_usage");
		expect(measured).toHaveLength(2);
		expect(measured[0]).toMatchObject({
			runId: "selection-run",
			outcome: "ok",
			promptTokens: 100,
			cachedTokens: 80,
			completionTokens: 12,
		});
		expect(measured[1]).toMatchObject({
			runId: "selection-run",
			outcome: "error",
			promptTokens: 100,
		});
		expect(measured[1]).not.toHaveProperty("cachedTokens");
		expect(measured[1]).not.toHaveProperty("completionTokens");
		expect(lines.join("")).not.toContain("fixture-private-response");
		expect(lines.join("")).not.toContain("connection-test");
	} finally {
		configureLogging({ level: "silent" });
	}
});
