import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { LlmCallError, LlmOutputError, type LlmRequest } from "eumenes-agency";
import { z } from "zod";
import type { InferencePort, Receipt } from "../../domains/inference";
import type { Settings } from "../../domains/settings";
import {
	AgencyRouteRefusedError,
	BACKGROUND_OUTPUT_LIMIT,
	createAgencyLlmPort,
	type AgencyLlmPortDeps,
} from "./llm-port";

type BackgroundControl = Parameters<
	NonNullable<InferencePort["captureBackgroundControlInTransaction"]>
>[1];
const RESOURCE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const schema = z.object({ pick: z.string(), score: z.number() });

function settingsWith(
	over: {
		resourceId?: string | null;
		resource?: boolean;
		enabled?: boolean;
		cloudAllowed?: boolean;
	} = {},
) {
	return {
		agency: { resourceId: over.resourceId ?? null },
		resources:
			over.resource === false
				? []
				: [
						{
							id: RESOURCE,
							purpose: "llm",
							connectionId: CONNECTION,
							model: "saved-model",
						},
					],
		connections: [{ id: CONNECTION, enabled: over.enabled ?? true }],
		routes: { llm: { cloudAllowed: over.cloudAllowed ?? true } },
	} as unknown as Settings;
}

function harness(
	options: {
		settings?: Settings;
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
			snapshotInTransaction: () => options.settings ?? settingsWith(),
			captureBackgroundControlInTransaction: (_db, input) => {
				calls.captured.push(input);
				return "req-1";
			},
			executeControl: async (requestId, messages, signal, control) => {
				calls.executed.push({ requestId, messages, control, signal });
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
	test("captures a structured background control on LARM when no resource is set and returns usage and latency", async () => {
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
		expect(captured.route).toBeUndefined();
		expect(captured.deadline).toBe(captured.taskDeadline);
		expect(captured.deadline).toBe(1_000 + 30_000);
		const executed = h.calls.executed[0]!;
		expect(executed.requestId).toBe("req-1");
		expect(executed.messages).toEqual([{ role: "user", content: "PROMPT" }]);
		expect(executed.control).toEqual({
			instructions: "SYSTEM",
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

	test("routes to the saved resource when agency.resourceId is set", async () => {
		const h = harness({ settings: settingsWith({ resourceId: RESOURCE }) });
		await h.port.complete(request(), new AbortController().signal);
		expect(h.calls.captured[0]!.route).toEqual({ resourceId: RESOURCE });
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

	test("a capture refusal of inference is a non-retryable call error", async () => {
		const h = harness();
		const port = createAgencyLlmPort({
			store: { write: async (fn) => fn({} as Database) },
			inference: {
				snapshotInTransaction: () => settingsWith(),
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
				snapshotInTransaction: () => settingsWith(),
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

	describe("a specified resource is never downgraded", () => {
		for (const [name, over, refusal] of [
			[
				"the resource is not registered",
				{ resource: false },
				"resource_missing",
			],
			["its connection is disabled", { enabled: false }, "connection_disabled"],
			[
				"the conversation route does not allow the cloud",
				{ cloudAllowed: false },
				"cloud_not_allowed",
			],
		] as const)
			test(`refuses when ${name}`, async () => {
				const h = harness({
					settings: settingsWith({ resourceId: RESOURCE, ...over }),
				});
				const error = await h.port
					.complete(request(), new AbortController().signal)
					.catch((e) => e);
				expect(error).toBeInstanceOf(AgencyRouteRefusedError);
				expect(error).toBeInstanceOf(LlmCallError);
				expect(error).toMatchObject({
					reasonCode: "agency_resource_unusable",
					retryable: false,
					refusal,
				});
				expect(h.calls.captured).toHaveLength(0);
				expect(h.calls.executed).toHaveLength(0);
			});

		test("LARM (no resource) is unaffected by the cloud route settings", async () => {
			const h = harness({
				settings: settingsWith({ cloudAllowed: false, enabled: false }),
			});
			await h.port.complete(request(), new AbortController().signal);
			expect(h.calls.captured).toHaveLength(1);
		});
	});
});
