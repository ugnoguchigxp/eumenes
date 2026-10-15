import { afterEach, expect, test } from "bun:test";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { configureLogging } from "../../../infrastructure/logger";
import { defaults } from "../../settings";
import { createCloudAgents } from "../adapters/cloud-agents";
import { routeToResource } from "../service/background-control";

afterEach(() => configureLogging({ level: "silent" }));
function capture() {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	return (event: string) =>
		lines.map((line) => JSON.parse(line)).filter((e) => e.event === event);
}

test("a dedicated resource that is unusable does not move the call to another billing path, and the log says which paths", () => {
	const events = capture();
	const conversation = {
		id: crypto.randomUUID(),
		name: "conversation",
		kind: "openai-compatible" as const,
		baseUrl: "https://gateway.example/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	};
	const dedicated = {
		id: crypto.randomUUID(),
		name: "dedicated",
		kind: "claude-agent-sdk" as const,
		auth: "api-key" as const,
		baseUrl: "https://api.anthropic.com",
		enabled: false,
		epoch: 0,
		envRef: null,
	};
	const resource = (connectionId: string) => ({
		id: crypto.randomUUID(),
		connectionId,
		purpose: "llm" as const,
		model: "m",
		contextWindow: 100_000,
		voice: null,
	});
	const a = resource(conversation.id);
	const b = resource(dedicated.id);
	const snapshot = {
		...defaults({}),
		connections: [conversation, dedicated],
		resources: [a, b],
	};
	snapshot.routes.llm.mode = "cloud-only";
	snapshot.routes.llm.cloudAllowed = true;
	snapshot.routes.llm.fallbackId = a.id;
	routeToResource(snapshot, b.id, "task-1");
	expect(snapshot.routes.llm.mode as string).toBe("larm-only");
	const [mismatch] = events("inference.route_billing_mismatch");
	expect(mismatch).toMatchObject({
		reason: "route_billing_mismatch",
		connectionId: dedicated.id,
		billingPath: "claude-api-key",
		source: "openai-compatible",
		taskId: "task-1",
	});
});

test("a dedicated resource that does not resolve can not be compared, so the call ends on LARM only and the log says so", () => {
	const events = capture();
	const conversation = {
		id: crypto.randomUUID(),
		name: "conversation",
		kind: "openai-compatible" as const,
		baseUrl: "https://gateway.example/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	};
	const a = {
		id: crypto.randomUUID(),
		connectionId: conversation.id,
		purpose: "llm" as const,
		model: "m",
		contextWindow: 100_000,
		voice: null,
	};
	const snapshot = {
		...defaults({}),
		connections: [conversation],
		resources: [a],
	};
	snapshot.routes.llm.mode = "cloud-only";
	snapshot.routes.llm.cloudAllowed = true;
	snapshot.routes.llm.fallbackId = a.id;
	routeToResource(snapshot, crypto.randomUUID(), "task-2");
	expect(snapshot.routes.llm.mode as string).toBe("larm-only");
	expect(snapshot.routes.llm.cloudAllowed).toBe(false);
	expect(events("inference.background_resource_unusable")).toHaveLength(1);
	const [mismatch] = events("inference.route_billing_mismatch");
	expect(mismatch).toMatchObject({
		reason: "dedicated_unresolved",
		source: "openai-compatible",
		taskId: "task-2",
	});
});

test("an observation that does not prove the route is logged with the connection and the observed sources, never a credential", async () => {
	const events = capture();
	const account: AccountInfo = {
		apiKeySource: "ANTHROPIC_API_KEY",
		tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
		apiProvider: "firstParty",
	};
	const claudeQuery = (() => ({
		accountInfo: async () => account,
		close: () => {},
		async *[Symbol.asyncIterator]() {},
	})) as unknown as typeof query;
	await expect(
		createCloudAgents({}, { claudeQuery }).run({
			kind: "claude-agent-sdk",
			connectionId: "connection-1",
			model: "m",
			baseUrl: "https://api.anthropic.com",
			credential: "secret-value",
			auth: "api-key",
			messages: [{ role: "user", content: "hi" }],
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("cloud_agent_auth_mismatch");
	const [event] = events("inference.cloud_agent_auth_mismatch");
	expect(event).toMatchObject({
		reason: "cloud_agent_auth_mismatch",
		connectionId: "connection-1",
		auth: "api-key",
		apiProvider: "firstParty",
		apiKeySource: "ANTHROPIC_API_KEY",
		tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
	});
	expect(JSON.stringify(event)).not.toContain("secret-value");
});
