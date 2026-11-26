import { randomUUID } from "node:crypto";
import type { InferenceChannel } from "eumenes-canvas/src/core/inference";
import {
	agentSystemMessage,
	type InferencePort,
} from "../../domains/inference";
import type { SqliteStore } from "../../infrastructure/sqlite";

export function makerChannel(
	store: SqliteStore,
	inference: Pick<
		InferencePort,
		"captureUserControlInTransaction" | "executeControl"
	>,
): InferenceChannel {
	return {
		async complete(request, validate, signal) {
			const capture = inference.captureUserControlInTransaction;
			const execute = inference.executeControl;
			if (!capture || !execute) throw new Error("canvas_inference_unavailable");
			signal.throwIfAborted();
			const id = await store.write((db) => {
				signal.throwIfAborted();
				return capture(db, {
					subject: `canvas-${request.purpose}:${randomUUID()}`,
					route: "subagent",
					deadline: Date.now() + 90_000,
					maxOutputTokens: 8192,
				});
			});
			const control = {
				instructions: request.system,
				outputSchema: request.outputSchema,
			};
			const reply = await execute(
				id,
				[
					agentSystemMessage(control),
					{ role: "user", content: request.prompt },
				],
				signal,
				control,
			).catch(() => {
				signal.throwIfAborted();
				throw new Error("canvas_inference_failed");
			});
			signal.throwIfAborted();
			try {
				if (typeof reply.value === "string") {
					if (
						request.maxOutputChars &&
						reply.value.length > request.maxOutputChars
					)
						throw new Error("canvas_invalid_model_output");
					const checked = validate(JSON.parse(reply.value));
					if (checked.ok) return checked.value;
				}
			} catch {
				// Model output can contain source text. Report only the invalid-output code.
			}
			throw new Error("canvas_invalid_model_output");
		},
	};
}
