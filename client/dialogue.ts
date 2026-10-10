import {
	runSchema,
	type PublicSubmit,
} from "../api/domains/dialogue/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";
import { watchRun } from "./run-stream";
export function dialogueClient(transport: Transport) {
	return {
		identity: transport.identity,
		watchRun: (
			id: string,
			signal: AbortSignal,
			onProgress: Parameters<typeof watchRun>[3],
		) => watchRun(transport, id, signal, onProgress),
		runs: async (id: string, signal?: AbortSignal) =>
			runSchema
				.array()
				.parse(
					await (
						await transport.call(
							`/api/conversations/${encodeURIComponent(id)}/runs`,
							{ signal },
						)
					).json(),
				),
		submit: async (input: PublicSubmit) =>
			runSchema.parse(
				await (await transport.call("/api/runs", json(input))).json(),
			),
		run: async (id: string, signal?: AbortSignal) =>
			runSchema.parse(
				await (
					await transport.call(`/api/runs/${encodeURIComponent(id)}`, {
						signal,
					})
				).json(),
			),
		cancel: async (id: string) =>
			runSchema.parse(
				await (
					await transport.call(
						`/api/runs/${encodeURIComponent(id)}/cancel`,
						json({}),
					)
				).json(),
			),
	};
}
export type DialogueClient = ReturnType<typeof dialogueClient>;
