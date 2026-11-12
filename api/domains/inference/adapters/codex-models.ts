import { z } from "zod";
import type { CodexHost } from "./codex-host";
import { fail } from "./cloud-agent-shared";
import type { Connection } from "../../settings";
import type { ConnectionModels } from "../contracts";

const pageSchema = z.object({
	data: z.array(
		z.object({
			model: z.string(),
			displayName: z.string(),
			inputModalities: z.array(z.string()).optional(),
		}),
	),
	nextCursor: z.string().nullable(),
});
export async function codexModels(
	host: CodexHost | undefined,
	connection: Connection,
	credential: string | null,
	signal: AbortSignal,
): Promise<ConnectionModels> {
	if (!host) throw fail("codex_unavailable");
	return {
		models: await host.models(
			{ credential, baseUrl: connection.baseUrl },
			signal,
		),
		account: {
			auth: credential ? "api-key" : "subscription",
			subscriptionType: null,
		},
	};
}

export async function readCodexModels(
	request: (method: string, params: unknown) => Promise<unknown>,
): Promise<ConnectionModels["models"]> {
	const models: ConnectionModels["models"] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	do {
		const page = pageSchema.parse(
			await request("model/list", {
				limit: 100,
				includeHidden: true,
				...(cursor ? { cursor } : {}),
			}),
		);
		for (const row of page.data)
			models.push({
				id: row.model,
				displayName: row.displayName,
				contextWindow: null,
				...(row.inputModalities
					? {
							inputModalities: row.inputModalities.filter(
								(m): m is "text" | "image" => m === "text" || m === "image",
							),
						}
					: {}),
			});
		if (
			models.length > 500 ||
			(page.nextCursor && cursors.has(page.nextCursor))
		)
			throw fail("invalid_model_catalog");
		cursor = page.nextCursor;
		if (cursor) cursors.add(cursor);
	} while (cursor);
	return models;
}
