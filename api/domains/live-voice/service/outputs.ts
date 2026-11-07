import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Runtime } from "./runtime";
import type { createLiveDelivery } from "./delivery";
import type { Database } from "bun:sqlite";
import { addSessionInput } from "../repository/inputs";
import type { LiveOutputOrigin } from "../contracts";
export function bindOutputs({
	store,
	runtimes,
	valid,
	enqueue,
	finish,
	send,
	sendState,
	delivery,
	validProposal,
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
	validProposal(db: Database, outputId: number, text: string): boolean;
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
					if (!store.read((db) => validProposal(db, out.id, out.text))) {
						await store.write((db) =>
							db
								.query(
									"UPDATE live_voice_outputs SET text='',sent=1 WHERE id=?",
								)
								.run(out.id),
						);
						continue;
					}
					// Settled work may outlive its input turn; normal reply drafts still need that version.
					if (out.run_id && out.kind !== "report") {
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
					if (!pending || pending.sent) continue;
					const claimed = await store.write((db) => {
						if (!validProposal(db, out.id, out.text)) return false;
						const claim =
							db
								.query(
									"UPDATE live_voice_outputs SET sent=1 WHERE id=? AND sent=0",
								)
								.run(out.id).changes === 1;
						if (claim) {
							const origin = db
								.query("SELECT origin_input FROM live_voice_outputs WHERE id=?")
								.get(out.id) as { origin_input: string | null };
							if (origin.origin_input)
								addSessionInput(
									db,
									id,
									(JSON.parse(origin.origin_input) as LiveOutputOrigin).input,
								);
						}
						return claim;
					});
					if (!claimed) continue;
					if (!store.read((db) => validProposal(db, out.id, out.text))) {
						await store.write((db) =>
							db
								.query("UPDATE live_voice_outputs SET text='' WHERE id=?")
								.run(out.id),
						);
						continue;
					}
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
