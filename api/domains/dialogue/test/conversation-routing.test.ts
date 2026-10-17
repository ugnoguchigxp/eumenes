import { expect, test } from "bun:test";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import type { ToolchainCard } from "../../capabilities";
import type { InferencePort, Receipt } from "../../inference";
import { routeConversation } from "../service/conversation-routing";

const card: ToolchainCard = {
	id: "music.create",
	revisionId: "toolchain:music.create@1",
	functionName: "music",
	title: "楽曲生成",
	summary: "楽曲を生成する",
	useWhen: ["楽曲を作る依頼"],
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};
const tool: NativeTool = {
	type: "function",
	function: {
		name: "music",
		description: card.summary,
		parameters: {
			type: "object",
			properties: { request: { type: "string" } },
			required: ["request"],
		},
	},
};

async function decide(value: unknown, user: string) {
	const inference = {
		executeControl: async (requestId: string) =>
			({
				requestId,
				attemptId: "route",
				value: JSON.stringify(value),
			}) as Receipt,
	} as unknown as InferencePort;
	return routeConversation({
		inference,
		requestId: "request",
		messages: [{ role: "user", content: user }],
		tools: [tool],
		cards: [card],
		openQuestions: [],
		signal: new AbortController().signal,
	});
}

test("a structured choice hands the original request to the offered agent", async () => {
	const request = "休日の昼に聞く楽曲を作ってください";
	const result = await decide(
		{
			decision: "toolchain",
			functionName: "music",
			request,
			questionRef: "",
		},
		request,
	);
	expect(result.operation).toMatchObject({
		toolchainId: card.id,
		functionName: "music",
		request,
	});
});

test("an explanation remains a normal answer", async () => {
	const result = await decide(
		{
			decision: "answer",
			functionName: "",
			request: "",
			questionRef: "",
		},
		"楽曲生成の仕組みを説明して",
	);
	expect(result.decision).toBe("answer");
	expect(result.operation).toBeUndefined();
});

test("an unoffered function cannot start an operation", async () => {
	await expect(
		decide(
			{
				decision: "toolchain",
				functionName: "another_function",
				request: "休日の昼に聞く楽曲を作ってください",
				questionRef: "",
			},
			"休日の昼に聞く楽曲を作ってください",
		),
	).rejects.toThrow("invalid_conversation_route");
});

test("empty session options are read as not given, for any toolchain", async () => {
	const request = "休日の昼に聞く楽曲を作ってください";
	for (const empty of [null, ""]) {
		const result = await decide(
			{
				decision: "toolchain",
				functionName: "music",
				request,
				questionRef: "",
				target: empty,
				resolveUnsaved: empty,
			},
			request,
		);
		expect(result.operation).toMatchObject({ functionName: "music", request });
		expect(result.operation).not.toHaveProperty("target");
		expect(result.operation).not.toHaveProperty("resolveUnsaved");
	}
	const answer = await decide(
		{
			decision: "answer",
			functionName: "",
			request: "",
			questionRef: "",
			target: null,
			resolveUnsaved: null,
		},
		"楽曲生成の仕組みを説明して",
	);
	expect(answer.decision).toBe("answer");
});

test("the session start options are offered only with a session toolchain", async () => {
	let policy = "";
	const inference = {
		executeControl: async (
			requestId: string,
			messages: Array<{ content: string }>,
		) => {
			policy = messages[0]!.content;
			return {
				requestId,
				attemptId: "route",
				value: JSON.stringify({
					decision: "answer",
					functionName: "",
					request: "",
					questionRef: "",
				}),
			} as Receipt;
		},
	} as unknown as InferencePort;
	await routeConversation({
		inference,
		requestId: "request",
		messages: [{ role: "user", content: "こんにちは" }],
		tools: [tool],
		cards: [card],
		openQuestions: [],
		signal: new AbortController().signal,
	});
	expect(policy).not.toContain("resolveUnsaved");
	await routeConversation({
		inference,
		requestId: "request",
		messages: [{ role: "user", content: "こんにちは" }],
		tools: [tool],
		cards: [card],
		openQuestions: [],
		sessions: new Map([["music", []]]),
		signal: new AbortController().signal,
	});
	expect(policy).toContain("resolveUnsaved");
});
