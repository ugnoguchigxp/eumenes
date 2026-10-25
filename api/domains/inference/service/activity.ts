import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ActivityObservation } from "../../larm";

export type AttemptGroup = "llm" | "asr" | "tts";
const group = "r.purpose";
const from =
	"FROM inference_attempts a JOIN inference_requests r ON r.id=a.request_id WHERE r.subject NOT LIKE 'probe:%'";

/** Running attempts now, and the newest success and failure since `since` (cancellations are not failures). */
export function createActivityReader(store: SqliteStore) {
	return {
		attemptActivity: (since: number) =>
			store.read((db) => {
				const result = Object.fromEntries(
					(["llm", "asr", "tts"] as const).map((g) => [
						g,
						{ running: 0, lastSuccessAt: null, lastFailure: null },
					]),
				) as Record<AttemptGroup, ActivityObservation>;
				const pick = (g: unknown) => result[g as AttemptGroup];
				for (const row of db
					.query(
						`SELECT ${group} AS g,COUNT(*) AS n ${from} AND a.status='running' GROUP BY g`,
					)
					.all() as { g: string; n: number }[])
					if (pick(row.g)) pick(row.g).running = row.n;
				for (const row of db
					.query(
						`SELECT ${group} AS g,MAX(a.ended) AS at ${from} AND a.status='succeeded' AND a.ended>=? GROUP BY g`,
					)
					.all(since) as { g: string; at: number }[])
					if (pick(row.g)) pick(row.g).lastSuccessAt = row.at;
				for (const row of db
					.query(
						`SELECT ${group} AS g,a.reason,a.ended AS at ${from} AND a.status='failed' AND a.ended>=? AND coalesce(a.reason,'')<>'cancelled' ORDER BY a.ended DESC`,
					)
					.all(since) as { g: string; reason: string | null; at: number }[])
					if (pick(row.g) && !pick(row.g).lastFailure)
						pick(row.g).lastFailure = {
							at: row.at,
							reason: row.reason ?? "failed",
						};
				return result;
			}),
	};
}
