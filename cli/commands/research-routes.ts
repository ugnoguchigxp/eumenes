import { readFile } from "node:fs/promises";
import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional } = args;
	const sub = positional.shift();
	const usage =
		"usage: research-routes list [--cursor C] [--limit 1-50]|show <key>|edit <key> <stateToken> <instruction-file>|disable <key> <stateToken>|rediscover <key> <stateToken>|clear <expectedEpoch> [--request-id UUID]";
	const requestId = args.explicitRequestId ?? crypto.randomUUID();
	// Mutations surface the request ID on failure so an identical retry stays idempotent.
	const mutate = async <T>(operation: () => Promise<T>) => {
		try {
			return await operation();
		} catch (error) {
			io.error(
				`Request ID: ${requestId}. Retry with --request-id ${requestId} to repeat the same request.`,
			);
			throw error;
		}
	};
	if (sub === "list") {
		show(
			await client.researchRoutes({
				...(args.listCursor ? { cursor: args.listCursor } : {}),
				...(args.listLimit ? { limit: args.listLimit } : {}),
			}),
		);
		return 0;
	}
	const [key, token, file] = positional;
	if (sub === "show" && key) {
		show(await client.researchRoute(key));
		return 0;
	}
	if (sub === "edit" && key && token && file) {
		// The instruction comes from a file so the text never passes through a shell line.
		const instruction = (await readFile(file, "utf8")).trim();
		show(
			await mutate(() =>
				client.editResearchRoute(key, {
					requestId,
					expectedStateToken: token,
					instruction,
				}),
			),
		);
		return 0;
	}
	if (sub === "disable" && key && token) {
		show(
			await mutate(() =>
				client.disableResearchRoute(key, {
					requestId,
					expectedStateToken: token,
				}),
			),
		);
		return 0;
	}
	if (sub === "rediscover" && key && token) {
		show(
			await mutate(() =>
				client.rediscoverResearchRoute(key, {
					requestId,
					expectedStateToken: token,
				}),
			),
		);
		return 0;
	}
	if (sub === "clear" && key !== undefined && /^\d+$/.test(key)) {
		show(
			await mutate(() =>
				client.clearResearchRoutes({
					requestId,
					expectedEpoch: Number(key),
				}),
			),
		);
		return 0;
	}
	throw new Error(usage);
};
