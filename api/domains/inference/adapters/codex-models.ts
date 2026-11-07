import { z } from "zod";
import { withCodexTransport } from "./codex-transport";
import { codexRuntime } from "./codex-sdk";
import { fail } from "./cloud-agent-shared";
import { withClaudeDirs } from "./cloud-agent-claude";
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
/** No thread or model turn is created while reading the selected account's catalog. */
export async function codexModels(
	environment: Readonly<Record<string, string | undefined>>,
	connection: Connection,
	credential: string | null,
	signal: AbortSignal,
	executable?: string,
): Promise<ConnectionModels> {
	const runtime = codexRuntime(environment, executable);
	if (!runtime) throw fail("codex_unavailable");
	const keyed = credential
		? {
				...runtime,
				env: { ...runtime.env, CODEX_API_KEY: credential },
				extraArgs: [
					"-c",
					`openai_base_url=${JSON.stringify(connection.baseUrl)}`,
				],
			}
		: runtime;
	return withClaudeDirs(({ cwd }) =>
		withCodexTransport(keyed, cwd, signal, fail, async ({ request }) => {
			const models = await readCodexModels(request);
			return {
				models,
				account: {
					auth: credential ? "api-key" : "subscription",
					subscriptionType: null,
				},
			};
		}),
	);
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
