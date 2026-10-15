import type { Connection } from "../../settings/contracts";
import type { ConnectionModels } from "../contracts";
import {
	object,
	speechContract,
	workersJson,
	workersSchema,
	workersUrl,
} from "../adapters/workers-ai";

/** Runtime catalog; task names are the provider's API contract, not model families. */
export async function workersModels(
	connection: Connection,
	token: string,
	send: typeof fetch,
	signal: AbortSignal,
): Promise<ConnectionModels> {
	const rows: Array<{
		model: Record<string, unknown>;
		purpose: "asr" | "tts";
	}> = [];
	for (const [purpose, task] of [
		["asr", "Automatic Speech Recognition"],
		["tts", "Text-to-Speech"],
	] as const) {
		for (let page = 1; page <= 5; page++) {
			const url = workersUrl(connection, "models/search");
			url.searchParams.set("task", task);
			url.searchParams.set("page", String(page));
			url.searchParams.set("per_page", "100");
			const json = await workersJson(send, url, token, signal);
			if (!Array.isArray(json.result))
				throw new Error("workers_ai_invalid_response");
			for (const value of json.result) {
				const model = object(value);
				if (
					typeof model.name !== "string" ||
					!model.name ||
					model.name.length > 200
				)
					throw new Error("workers_ai_invalid_response");
				if (
					!rows.some(
						(r) => r.purpose === purpose && r.model.name === model.name,
					)
				)
					rows.push({ model, purpose });
			}
			const pages = object(json.result_info).total_pages;
			if (
				(typeof pages === "number" && page >= pages) ||
				json.result.length < 100
			)
				break;
			if (page === 5) throw new Error("workers_ai_catalog_too_large");
		}
	}
	const models: ConnectionModels["models"] = [];
	// Schema reads have bounded concurrency; one missing schema does not discard the catalog.
	for (let start = 0; start < rows.length; start += 4) {
		const chunk = await Promise.all(
			rows.slice(start, start + 4).map(async ({ model, purpose }) => {
				const id = model.name as string;
				let contract: ReturnType<typeof speechContract>;
				try {
					contract = speechContract(
						await workersSchema(send, connection, token, id, signal),
						purpose,
					);
				} catch (error) {
					signal.throwIfAborted();
					if (
						error instanceof Error &&
						/^workers_ai_http_(401|403)$/.test(error.message)
					)
						throw error;
					contract = speechContract({}, purpose);
				}
				const {
					supported,
					reason,
					voices,
					languages,
					voiceRequired,
					languageRequired,
					voiceDefault,
					languageDefault,
				} = contract;
				return {
					id,
					displayName: id,
					contextWindow: null,
					purpose,
					speech: {
						supported,
						reason,
						voices,
						languages,
						voiceRequired,
						languageRequired,
						voiceDefault,
						languageDefault,
						voiceSelectable: !!contract.voiceKey,
						languageSelectable: !!contract.languageKey,
					},
				};
			}),
		);
		models.push(...chunk);
	}
	return { models, account: { auth: "api-key", subscriptionType: null } };
}
