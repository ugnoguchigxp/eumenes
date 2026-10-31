import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Runtime } from "./runtime";
import type { createLiveDelivery } from "./delivery";
export function bindOutputs({
	store,
	runtimes,
	valid,
	enqueue,
	finish,
	send,
	sendState,
	delivery,
}: {
	store: SqliteStore;
	runtimes: Map<string, Runtime>;
	valid: (id: string) => boolean;
	enqueue: (id: string, work: () => Promise<void>) => void;
	finish: (
		id: string,
		status: "closed" | "failed" | "interrupted",
		error?: string | null,
	) => Promise<void>;
	send: (id: string, event: unknown) => void;
	sendState: (id: string) => void;
	delivery: ReturnType<typeof createLiveDelivery>;
}) {
	return store.onCommit(() => {
		for (const id of runtimes.keys()) {
			if (!valid(id)) {
				enqueue(id, () => finish(id, "interrupted", "live_permission_revoked"));
				continue;
			}
			const outputs = store.read(
				(db) =>
					db
						.query(
							"SELECT id,run_id,text,kind FROM live_voice_outputs WHERE session_id=? AND sent=0 ORDER BY id",
						)
						.all(id) as {
						id: number;
						run_id: string | null;
						text: string;
						kind: string;
					}[],
			);
			if (!outputs.length) continue;
			enqueue(id, async () => {
				for (const out of outputs) {
					if (out.run_id) {
						try {
							store.read((db) => delivery.assertCurrent(db, out.run_id!));
						} catch {
							await store.write((db) => {
								db.query("UPDATE live_voice_outputs SET sent=1 WHERE id=?").run(
									out.id,
								);
							});
							continue;
						}
					}
					const pending = store.read(
						(db) =>
							db
								.query("SELECT sent FROM live_voice_outputs WHERE id=?")
								.get(out.id) as { sent: number } | null,
					);
					if (pending?.sent) continue;
					await store.write((db) => {
						db.query("UPDATE live_voice_outputs SET sent=1 WHERE id=?").run(
							out.id,
						);
					});
					const d = out.run_id
						? store.read(
								(db) =>
									db
										.query(
											"SELECT delegation_id FROM live_voice_delegations WHERE session_id=? AND run_id=? LIMIT 1",
										)
										.get(id, out.run_id) as { delegation_id: string } | null,
							)
						: null;
					// Bound every append conservatively, including multibyte text; preserve all chunks in order.
					const points = Array.from(out.text);
					for (let at = 0; at < points.length; at += 120)
						send(id, {
							type:
								out.kind === "thinking"
									? "session.thinking.append"
									: "session.commentary.append",
							event_id: crypto.randomUUID(),
							delegation_id: d?.delegation_id ?? null,
							content: points.slice(at, at + 120).join(""),
						});
				}
				sendState(id);
			});
		}
	});
}
