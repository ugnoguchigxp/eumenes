import type { DesignInference } from "eumenes-agency/agenda/runtime";
import {
	agentControl,
	agentSystemMessage,
	type InferencePort,
} from "../../domains/inference";
import type { SqliteStore } from "../../infrastructure/sqlite";

export function supervisionDesignInference(
	store: Pick<SqliteStore, "read" | "write">,
	inference: InferencePort,
): DesignInference {
	return async ({ instructions, data, schema, signal }) => {
		if (
			!inference.captureUserControlInTransaction ||
			!inference.executeControl ||
			!inference.validateReceiptInTransaction
		)
			throw new Error("supervision_inference_unavailable");
		const control = agentControl({
			profile: instructions,
			skills: [],
			rules: "",
			tools: [],
			outputSchema: schema.toJSONSchema(),
		});
		const messages = [
			agentSystemMessage(control),
			{ role: "user" as const, content: data },
		];
		const requestId = await store.write((db) => {
			signal.throwIfAborted();
			return inference.captureUserControlInTransaction!(db, {
				subject: `development-supervision:design-${crypto.randomUUID()}`,
				deadline: Date.now() + 120_000,
				maxOutputTokens: 4_000,
				structuredOutput: true,
				route: "subagent",
			});
		});
		const receipt = await inference.executeControl(
			requestId,
			messages,
			signal,
			control,
		);
		if (
			!store.read((db) => inference.validateReceiptInTransaction!(db, receipt))
		)
			throw new Error("supervision_design_receipt_invalid");
		return typeof receipt.value === "string"
			? JSON.parse(receipt.value)
			: receipt.value;
	};
}
