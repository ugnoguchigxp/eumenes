import { expect, test } from "bun:test";
import { createLarm } from "..";
import { waitFor } from "../../../infrastructure/wait-for";

const provider = {
	name: "llm",
	model: "fixture-llm",
	protocol: "openai.chat-completions.v1",
	endpoint: "/v1/chat/completions",
	contextWindow: {
		maxTokens: 262144,
		outputReserveTokens: 4096,
		safetyMarginTokens: 1976,
	},
};

/** A LARM whose chat calls hang until their signal ends, except those whose first message says "quick". */
function fixture() {
	const connections: string[] = [];
	const inputs: Array<{ content: string; connection: string }> = [];
	const p = createLarm({
		baseUrl: "http://127.0.0.1:9810",
		profile: "test-profile",
		token: "control",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const path = url.pathname;
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (path === "/v3/agent-profiles")
				return Response.json({
					contractVersion: "agent-connection.v3",
					catalogRevision: "revision",
					requestedProfile: "test-profile",
					profiles: [{ id: "test-profile", providers: [provider] }],
				});
			const connection = (id: string) => ({
				id,
				profile: "test-profile",
				agentProfile: "test-profile",
				status: "ready",
				expiresAt: new Date(Date.now() + 900000).toISOString(),
				providers: [{ ...provider, readiness: "ready", claimable: true }],
			});
			if (path === "/v1/agent-connections") {
				const client = JSON.parse(String(init?.body)).client as string;
				connections.push(client);
				return Response.json(connection(client), { status: 201 });
			}
			if (path.endsWith("/claim")) {
				const id = path.split("/").at(-2)!;
				return Response.json({
					...connection(id),
					providers: [
						{
							...provider,
							endpoint: `http://127.0.0.1/${id}/v1/chat/completions`,
							baseUrl: `http://127.0.0.1/${id}/v1`,
							credential: { token: id },
							configuration: {
								fields: {
									baseURL: `http://127.0.0.1/${id}/v1`,
									model: provider.model,
								},
							},
						},
					],
				});
			}
			const body = JSON.parse(String(init?.body)) as {
				messages: Array<{ content: string }>;
				tool_choice?: string;
			};
			const content = body.messages.at(-1)!.content;
			inputs.push({ content, connection: path.split("/")[1]! });
			// A read-ahead's answer: its one token, stopped at its output bound.
			if (content.startsWith("bounded"))
				return Response.json({
					choices: [{ message: { content: "{" }, finish_reason: "length" }],
				});
			if (!content.startsWith("quick"))
				await new Promise<void>((_, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal!.reason),
					);
				});
			return Response.json({
				choices: [
					{ message: { content: `${content}:${body.tool_choice ?? "-"}` } },
				],
			});
		},
		client: "main-client",
	});
	return { p, connections, inputs };
}

const tool = {
	type: "function" as const,
	function: { name: "noop", description: "", parameters: { type: "object" } },
};

test("background work on the conversation's prompt runs on its connection and yields to a conversation call", async () => {
	const { p, inputs } = fixture();
	const signal = AbortSignal.timeout(5000);
	try {
		const background = p.answer(
			[{ role: "user", content: "background task" }],
			signal,
			{
				sessionRole: "auxiliary",
				onConversation: true,
				tools: [tool],
				toolChoice: "none",
				jsonOutput: true,
			},
		);
		const outcome = Promise.allSettled([background]);
		await waitFor(() => inputs.length === 1);
		// The conversation takes its connection at once: the background call is aborted, not waited for.
		const answer = await p.answer(
			[{ role: "user", content: "quick answer" }],
			signal,
		);
		expect(answer).toBe("quick answer:-");
		const [settled] = await outcome;
		expect(settled!.status).toBe("rejected");
		expect(((settled as PromiseRejectedResult).reason as Error).message).toBe(
			"larm_preempted",
		);
		// Both went to the conversation's own connection, the background one with its tools not to be called.
		expect(inputs.map((i) => i.connection)).toEqual([
			"main-client",
			"main-client",
		]);
		const quick = await p.answer(
			[{ role: "user", content: "quick background" }],
			signal,
			{
				sessionRole: "auxiliary",
				onConversation: true,
				tools: [tool],
				toolChoice: "none",
			},
		);
		expect(quick).toBe("quick background:none");
	} finally {
		await p.close();
	}
});

test("the host's own background work on a connection of its own yields to every call made for the user; other one-shot calls do not", async () => {
	const { p, inputs } = fixture();
	const signal = AbortSignal.timeout(5000);
	const housekeeping = (content: string) =>
		Promise.allSettled([
			p.answer([{ role: "user", content }], signal, {
				sessionRole: "auxiliary",
				yields: true,
				jsonOutput: true,
			}),
		]);
	try {
		// A conversation call aborts it at once: LARM infers one call at a time.
		const memory = housekeeping("memory curation");
		await waitFor(() => inputs.length === 1);
		expect(
			await p.answer([{ role: "user", content: "quick answer" }], signal),
		).toBe("quick answer:-");
		const [first] = await memory;
		expect(((first as PromiseRejectedResult).reason as Error).message).toBe(
			"larm_preempted",
		);
		// A specialist's call (a task sub-agent) is made for the user too.
		const world = housekeeping("world curation");
		await waitFor(() => inputs.length === 3);
		expect(
			await p.answer([{ role: "user", content: "quick specialist" }], signal, {
				sessionRole: "subagent",
				taskId: "studio",
			}),
		).toBe("quick specialist:-");
		const [second] = await world;
		expect(((second as PromiseRejectedResult).reason as Error).message).toBe(
			"larm_preempted",
		);
		// A one-shot call that does not yield is not aborted by another, and a finished one leaves nothing to abort.
		const other = Promise.allSettled([
			p.answer([{ role: "user", content: "one-shot" }], signal, {
				sessionRole: "auxiliary",
			}),
		]);
		await waitFor(() => inputs.length === 5);
		expect(
			await p.answer([{ role: "user", content: "quick again" }], signal),
		).toBe("quick again:-");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(inputs.length).toBe(6);
		await p.close();
		const [unrelated] = await other;
		expect(
			((unrelated as PromiseRejectedResult).reason as Error).message,
		).not.toBe("larm_preempted");
	} finally {
		await p.close();
	}
});

test("a read-ahead on the conversation's prompt ends normally at its output bound; another call does not", async () => {
	const { p } = fixture();
	const signal = AbortSignal.timeout(5000);
	const call = {
		sessionRole: "auxiliary" as const,
		onConversation: true as const,
		tools: [tool],
		toolChoice: "none" as const,
		jsonOutput: true as const,
		maxOutputTokens: 1,
	};
	try {
		const read = [{ role: "user" as const, content: "bounded read" }];
		expect(await p.answer(read, signal, { ...call, readAhead: true })).toBe(
			"{",
		);
		await expect(p.answer(read, signal, call)).rejects.toThrow(
			"chat_stream_incomplete",
		);
	} finally {
		await p.close();
	}
});
