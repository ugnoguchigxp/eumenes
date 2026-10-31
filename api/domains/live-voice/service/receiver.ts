import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { LiveConversationPort, LiveEvent } from "../contracts";
import type { Runtime } from "./runtime";
import { session } from "../repository";
import { appendTranscript, publishSegments } from "./transcripts";
import { validPcm } from "./protocol";
export function createReceiver({
	store,
	conversation,
	clock,
	runtimes,
	valid,
	send,
	sendState,
	finish,
	enqueue,
	emit,
}: {
	store: SqliteStore;
	conversation: LiveConversationPort;
	clock: () => string;
	runtimes: Map<string, Runtime>;
	valid: (id: string) => boolean;
	send: (id: string, event: unknown) => void;
	sendState: (id: string) => void;
	finish: (
		id: string,
		status: "closed" | "failed" | "interrupted",
		error?: string | null,
		usage?: unknown,
	) => Promise<void>;
	enqueue: (id: string, work: () => Promise<void>) => void;
	emit: (id: string, event: LiveEvent) => void;
}) {
	function scheduleDelegations(id: string) {
		const rt = runtimes.get(id);
		if (!rt) return;
		clearTimeout(rt.delegationTimer);
		// Coalesce stream fragments before inference. This delay never establishes semantic completion or approval.
		rt.delegationTimer = setTimeout(
			() =>
				enqueue(id, async () => {
					const pending = store.read(
						(db) =>
							db
								.query(
									"SELECT delegation_id FROM live_voice_delegations WHERE session_id=? AND state='awaiting_context'",
								)
								.all(id) as { delegation_id: string }[],
					);
					for (const item of pending) await delegate(id, item.delegation_id);
				}),
			400,
		);
	}
	async function delegate(id: string, delegationId: string) {
		if (!valid(id)) return;
		let wake = false;
		await store.write((db) => {
			const row = session(db, id);
			if (!row || row.status !== "active" || row.test) return;
			const existing = db
				.query(
					"SELECT run_id FROM live_voice_delegations WHERE session_id=? AND delegation_id=?",
				)
				.get(id, delegationId) as { run_id: string | null } | null;
			if (existing?.run_id) return;
			db.query(
				"INSERT OR IGNORE INTO live_voice_delegations VALUES(?,?,?,NULL,'awaiting_context')",
			).run(id, delegationId, row.input_version);
			publishSegments(db, id, conversation, clock());
			const reused = db
				.query(
					"SELECT run_id FROM live_voice_runs WHERE session_id=? AND input_version=? LIMIT 1",
				)
				.get(id, row.input_version) as { run_id: string } | null;
			const input = db
				.query(
					"SELECT id,text FROM live_voice_segments WHERE session_id=? AND speaker='user' AND length(trim(text))>0 ORDER BY seq DESC LIMIT 1",
				)
				.get(id) as { id: string; text: string } | null;
			if (!input && !reused) return;
			const runId =
				reused?.run_id ??
				conversation.delegate(db, {
					requestId: crypto.randomUUID(),
					conversationId: row.conversation_id,
					messageId: input!.id,
					text: input!.text,
					sessionId: id,
					inputVersion: row.input_version,
				}).id;
			db.query(
				"UPDATE live_voice_delegations SET input_version=?,run_id=?,state='running' WHERE session_id=? AND delegation_id=?",
			).run(row.input_version, runId, id, delegationId);
			wake = !reused;
		});
		if (wake) conversation.wake();
		sendState(id);
	}
	async function receive(id: string, raw: unknown) {
		if (typeof raw !== "string" || raw.length > 1_000_000)
			throw new Error("live_frame_invalid");
		const event = JSON.parse(raw) as Record<string, unknown>;
		if (!valid(id)) {
			await finish(id, "interrupted", "live_permission_revoked");
			return;
		}
		switch (event.type) {
			case "session.started":
				clearTimeout(runtimes.get(id)?.startupTimer);
				if (store.read((db) => session(db, id)?.muted))
					send(id, {
						type: "session.input_audio.mute",
						event_id: crypto.randomUUID(),
					});
				await store.write((db) => {
					db.query(
						"UPDATE live_voice_sessions SET status='active' WHERE id=? AND status='connecting'",
					).run(id);
				});
				sendState(id);
				break;
			case "session.input_transcript.delta":
			case "session.output_transcript.delta": {
				if (
					typeof event.delta !== "string" ||
					event.delta.length > 6000 ||
					!Number.isFinite(event.start_ms) ||
					!Number.isFinite(event.end_ms) ||
					Number(event.start_ms) < 0 ||
					Number(event.end_ms) < Number(event.start_ms) ||
					Number(event.end_ms) > 604_800_000
				)
					throw new Error("live_transcript_invalid");
				await store.write((db) =>
					appendTranscript(
						db,
						id,
						{
							speaker:
								event.type === "session.input_transcript.delta"
									? "user"
									: "assistant",
							delta: event.delta as string,
							start: Number(event.start_ms),
							end: Number(event.end_ms),
						},
						conversation,
						clock(),
					),
				);
				sendState(id);
				const rt = runtimes.get(id);
				if (rt) {
					clearTimeout(rt.flushTimer);
					rt.flushTimer = setTimeout(
						() =>
							enqueue(id, async () => {
								await store.write((db) =>
									publishSegments(db, id, conversation, clock()),
								);
								sendState(id);
							}),
						1500,
					);
				}
				if (event.type === "session.input_transcript.delta") {
					const stale = store.read(
						(db) =>
							db
								.query(
									"SELECT d.delegation_id,d.run_id FROM live_voice_delegations d JOIN live_voice_sessions s ON s.id=d.session_id WHERE d.session_id=? AND d.state='running' AND d.input_version<>s.input_version",
								)
								.all(id) as { delegation_id: string; run_id: string }[],
					);
					for (const item of stale) {
						const result = await conversation.cancelReply(item.run_id);
						await store.write((db) => {
							db.query(
								"UPDATE live_voice_delegations SET state=?,run_id=? WHERE session_id=? AND delegation_id=?",
							).run(
								result?.status === "cancelled"
									? "awaiting_context"
									: "superseded",
								result?.status === "cancelled" ? null : item.run_id,
								id,
								item.delegation_id,
							);
						});
					}
					scheduleDelegations(id);
				}
				break;
			}
			case "session.output_audio.delta": {
				if (
					typeof event.delta !== "string" ||
					event.delta.length > 256_000 ||
					!validPcm(event.delta, 192_000)
				)
					throw new Error("live_audio_invalid");
				const rt = runtimes.get(id);
				if (rt)
					emit(id, {
						type: "audio",
						sequence: ++rt.output,
						audio: event.delta,
					});
				break;
			}
			case "session.delegation.created": {
				const d = event.delegation as { id?: unknown } | undefined;
				if (typeof d?.id !== "string" || !d.id || d.id.length > 200)
					throw new Error("live_delegation_invalid");
				const delegationId = d.id;
				await store.write((db) => {
					const row = session(db, id);
					if (row && !row.test)
						db.query(
							"INSERT OR IGNORE INTO live_voice_delegations VALUES(?,?,?,NULL,'awaiting_context')",
						).run(id, delegationId, row.input_version);
				});
				scheduleDelegations(id);
				break;
			}
			case "session.input_audio.muted":
			case "session.input_audio.unmuted":
				await store.write((db) => {
					db.query("UPDATE live_voice_sessions SET muted=? WHERE id=?").run(
						event.type === "session.input_audio.muted" ? 1 : 0,
						id,
					);
				});
				sendState(id);
				break;
			case "session.closed":
				await finish(id, "closed", null, event.usage);
				break;
			case "error":
				await finish(id, "failed", "live_provider_error");
				break;
		}
	}

	return receive;
}
