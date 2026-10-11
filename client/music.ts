import { musicRecord } from "../api/domains/music/contracts";
import type { Transport } from "./transport";
export function musicClient(t: Transport) {
	return {
		musicList: async (conversationId: string, signal?: AbortSignal) =>
			musicRecord
				.array()
				.parse(
					await (
						await t.call(
							`/api/music?conversationId=${encodeURIComponent(conversationId)}`,
							{ signal },
						)
					).json(),
				),
		music: async (id: string, signal?: AbortSignal) =>
			musicRecord.parse(
				await (
					await t.call(`/api/music/${encodeURIComponent(id)}`, { signal })
				).json(),
			),
		musicAudio: async (id: string, signal?: AbortSignal) =>
			(
				await t.call(`/api/music/${encodeURIComponent(id)}/audio`, { signal })
			).blob(),
	};
}
