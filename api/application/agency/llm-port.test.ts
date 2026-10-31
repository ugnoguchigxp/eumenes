import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
	LlmCallError,
	LlmOutputError,
	SystemContextConfigurationError,
	type LlmRequest,
} from "eumenes-agency";
import { z } from "zod";
import type { InferencePort, Receipt } from "../../domains/inference";
import {
	BACKGROUND_OUTPUT_LIMIT,
	createAgencyLlmPort,
	type AgencyLlmPortDeps,
} from "./llm-port";

type BackgroundControl = Parameters<
	NonNullable<InferencePort["captureBackgroundControlInTransaction"]>
>[1];
const schema = z.object({ pick: z.string(), score: z.number() });

function harness(
	options: {
		value?: string;
		execute?: (signal: AbortSignal) => Promise<Receipt>;
		accept?: boolean;
	} = {},
) {
	const calls = {
		captured: [] as BackgroundControl[],
		executed: [] as {
			requestId: string;
			messages: unknown;
			control: unknown;
			session: unknown;
			signal: AbortSignal;
		}[],
		rejected: [] as string[],
		accepted: 0,
	};
	let clock = 1_000;
	const receipt: Receipt = {
		requestId: "req-1",
		attemptId: "att-1",
		value: options.value ?? '{"pick":"a","score":1}',
	};
	const deps: AgencyLlmPortDeps = {
		store: { write: async (fn) => fn({} as Database) },
		inference: {
			captureBackgroundControlInTransaction: (_db, input) => {
				calls.captured.push(input);
				return "req-1";
			},
			executeControl: async (requestId, messages, signal, control, session) => {
				calls.executed.push({ requestId, messages, control, session, signal });
				clock += 250;
				return options.execute ? options.execute(signal) : receipt;
			},
			acceptInTransaction: () => {
				calls.accepted += 1;
				return options.accept ?? true;
			},
			rejectControlInTransaction: (_db, _receipt, code) => {
				calls.rejected.push(code);
			},
		},
		next: () => ({ decisionId: "conv-1.opp.3", generation: 7 }),
		attemptUsage: () => ({
			model: "served-model",
			inputTokens: 120,
			outputTokens: 40,
			cacheReadTokens: 16,
		}),
		nowMs: () => clock,
	};
	return { calls, port: createAgencyLlmPort(deps) };
}

const request = (over: Partial<LlmRequest<unknown>> = {}) =>
	({
		purpose: "select",
		system: "SYSTEM",
		prompt: "PROMPT",
		schema,
		maxOutputTokens: 800,
		...over,
	}) as LlmRequest<z.infer<typeof schema>>;

describe("agency LLM port", () => {
	test("captures a structured background control on the conversation route and returns usage and latency", async () => {
		const h = harness();
		const signal = new AbortController().signal;
		const result = await h.port.complete(request(), signal);
		expect(h.calls.captured).toHaveLength(1);
		const captured = h.calls.captured[0]!;
		expect(captured).toMatchObject({
			taskId: "agency",
			decisionId: "conv-1.opp.3",
			authorityEpoch: 1,
			executionGeneration: 7,
			maxOutputTokens: 800,
			structuredOutput: true,
		});
		// Every call uses the LLM the conversation is set to; no other is chosen here.
		expect(captured.route).toBe("conversation");
		expect(captured.deadline).toBe(captured.taskDeadline);
		// The structured cap: LARM may think at length, the call yielding to the user's calls.
		expect(captured.deadline).toBe(1_000 + 300_000);
		const executed = h.calls.executed[0]!;
		expect(executed.requestId).toBe("req-1");
		// Without the conversation's prefix the call is its own system and prompt.
		expect(executed.messages).toEqual([
			{ role: "system", content: "SYSTEM" },
			{ role: "user", content: "PROMPT" },
		]);
		expect(executed.control).toBeUndefined();
		expect(executed.session).toEqual({
			sessionRole: "auxiliary",
			yields: true,
			outputSchema: z.toJSONSchema(schema),
		});
		expect(result).toEqual({
			value: { pick: "a", score: 1 },
			model: "served-model",
			inputTokens: 120,
			outputTokens: 40,
			cacheReadTokens: 16,
			latencyMs: 250,
		});
		expect(h.calls.accepted).toBe(1);
	});

	test("never asks for more than the background output limit", async () => {
		for (const [asked, sent] of [
			[99_999, BACKGROUND_OUTPUT_LIMIT],
			[1500, 1500],
			[1501, 1500],
			[0.4, 1],
			[-5, 1],
		] as const) {
			const h = harness();
			await h.port.complete(
				request({ maxOutputTokens: asked }),
				new AbortController().signal,
			);
			expect(h.calls.captured[0]!.maxOutputTokens).toBe(sent);
		}
	});

	test("a schema violation is an output error and rejects the control receipt", async () => {
		const h = harness({ value: '{"pick":"a","score":"high"}' });
		const error = await h.port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		expect(error).toBeInstanceOf(LlmOutputError);
		expect((error as LlmOutputError).reasonCode).toBe("schema_mismatch");
		expect((error as LlmOutputError).usage).toEqual({
			inputTokens: 120,
			outputTokens: 40,
		});
		expect(h.calls.rejected).toEqual(["schema_mismatch"]);
		expect(h.calls.accepted).toBe(0);
	});

	test("unparseable output is an output error", async () => {
		const h = harness({ value: "I cannot help with that." });
		const error = await h.port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		expect(error).toBeInstanceOf(LlmOutputError);
		expect((error as LlmOutputError).reasonCode).toBe("malformed_json");
	});

	test("an already aborted signal calls nothing", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(
			h.port.complete(request(), controller.signal),
		).rejects.toThrow();
		expect(h.calls.captured).toHaveLength(0);
		expect(h.calls.executed).toHaveLength(0);
	});

	test("an abort during the call propagates and reaches inference through the signal", async () => {
		const controller = new AbortController();
		const h = harness({
			execute: (signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason));
					controller.abort(new DOMException("stop", "AbortError"));
				}),
		});
		const error = await h.port
			.complete(request(), controller.signal)
			.catch((e) => e);
		expect(error).not.toBeInstanceOf(LlmCallError);
		expect(error).not.toBeInstanceOf(LlmOutputError);
		expect((error as DOMException).name).toBe("AbortError");
		expect(h.calls.executed[0]!.signal.aborted).toBe(true);
		expect(h.calls.accepted).toBe(0);
	});

	test("a result that arrives after cancellation is not adopted", async () => {
		const controller = new AbortController();
		const h = harness({
			execute: async () => {
				controller.abort();
				return { requestId: "req-1", attemptId: "att-1", value: "{}" };
			},
		});
		await expect(
			h.port.complete(request(), controller.signal),
		).rejects.toThrow();
		expect(h.calls.accepted).toBe(0);
	});

	test("inference failures become call errors; connection-class codes are retryable", async () => {
		const transient = harness({
			execute: async () => {
				throw new Error("network_unavailable");
			},
		});
		const a = await transient.port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		expect(a).toBeInstanceOf(LlmCallError);
		expect(a).toMatchObject({ reasonCode: "connection", retryable: true });

		const hard = harness({
			execute: async () => {
				throw new Error("larm_inference_401");
			},
		});
		const b = await hard.port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		expect(b).toMatchObject({
			reasonCode: "larm_inference_401",
			retryable: false,
		});

		const opaque = harness({
			execute: async () => {
				throw new Error("Provider said: sk-secret leaked text");
			},
		});
		const c = await opaque.port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		expect(c).toMatchObject({ reasonCode: "inference_failed" });
	});

	test("a call that yielded to the foreground is not tried again at once", async () => {
		const yielded = harness({
			execute: async () => {
				throw new Error("larm_preempted");
			},
		});
		const error = await yielded.port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		// An abort from below: the core neither retries it nor counts it toward quarantine.
		expect(error).not.toBeInstanceOf(LlmCallError);
		expect(error).toMatchObject({
			name: "AbortError",
			message: "larm_preempted",
		});
	});

	test("a capture refusal of inference is a non-retryable call error", async () => {
		const h = harness();
		const port = createAgencyLlmPort({
			store: { write: async (fn) => fn({} as Database) },
			inference: {
				captureBackgroundControlInTransaction: () => {
					throw new Error("background_control_conflict");
				},
				executeControl: async () => {
					throw new Error("unreachable");
				},
				acceptInTransaction: () => true,
			},
			next: () => ({ decisionId: "conv-1.opp.3", generation: 7 }),
		});
		const error = await port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		expect(error).toMatchObject({
			reasonCode: "background_control_conflict",
			retryable: false,
		});
		expect(h.calls.executed).toHaveLength(0);
	});

	test("a receipt inference no longer accepts is not adopted", async () => {
		const h = harness({ accept: false });
		const error = await h.port
			.complete(request(), new AbortController().signal)
			.catch((e) => e);
		expect(error).toMatchObject({ reasonCode: "receipt_rejected" });
	});

	test("an invalid decision id is refused before capture", async () => {
		const h = harness();
		const port = createAgencyLlmPort({
			store: { write: async (fn) => fn({} as Database) },
			inference: {
				captureBackgroundControlInTransaction: () => "x",
				executeControl: async () => {
					throw new Error("unreachable");
				},
				acceptInTransaction: () => true,
			},
			next: () => ({ decisionId: "has space", generation: 1 }),
		});
		await expect(
			port.complete(request(), new AbortController().signal),
		).rejects.toMatchObject({ reasonCode: "invalid_background_control" });
		expect(h.calls.captured).toHaveLength(0);
	});
});

describe("agency LLM port on the conversation's prompt", () => {
	test("the purpose system replaces the conversation system; only data goes into Task", async () => {
		const prefix = {
			messages: [
				{ role: "system" as const, content: "会話の指示" },
				{ role: "user" as const, content: "<memory>\nなし\n</memory>" },
			],
		};
		const executed: Array<{ messages: unknown; session: unknown }> = [];
		const asked: string[] = [];
		const port = createAgencyLlmPort({
			store: { write: async (fn) => fn({} as Database) },
			inference: {
				captureBackgroundControlInTransaction: () => "req-1",
				executeControl: async (_id, messages, _signal, _control, session) => {
					executed.push({ messages, session });
					return {
						requestId: "req-1",
						attemptId: "att-1",
						value: '{"pick":"a","score":1}',
					};
				},
				acceptInTransaction: () => true,
				rejectControlInTransaction: () => {},
			},
			next: () => ({
				decisionId: "conv-1.opp.3",
				generation: 7,
				conversationId: "conv-1",
			}),
			task: (conversationId, task) => {
				asked.push(conversationId);
				return {
					messages: [
						...prefix.messages,
						{ role: "user", content: `## Task\n${task}` },
					],
				};
			},
		});
		await port.complete(
			request({ purpose: "update" }),
			AbortSignal.timeout(1000),
		);
		expect(asked).toEqual(["conv-1"]);
		expect(executed[0]!.messages).toEqual([
			{ role: "system", content: "SYSTEM" },
			prefix.messages[1],
			{ role: "user", content: "## Task\nPROMPT" },
		]);
		expect(executed[0]!.session).toEqual({
			sessionRole: "auxiliary",
			onConversation: true,
			outputSchema: z.toJSONSchema(schema),
		});
	});
});

test("missing host system never captures or calls inference", async () => {
	for (const system of ["", " \n", undefined]) {
		const h = harness();
		await expect(
			h.port.complete(request({ system }), new AbortController().signal),
		).rejects.toBeInstanceOf(SystemContextConfigurationError);
		expect(h.calls.captured).toHaveLength(0);
		expect(h.calls.executed).toHaveLength(0);
	}
});
