import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { SettingsService } from "../../settings";

import {
	activeStatuses,
	type ConnectLive,
	type LiveConversationPort,
	type LiveEvent,
} from "../contracts";
import { active, latest, session, snapshot } from "../repository";
import { liveConfig } from "./config";
import { publishSegments, purgeMessage } from "./transcripts";
import { createLiveDelivery } from "./delivery";
import { validPcm } from "./protocol";
import { createTerminator } from "./terminal";
import type { Runtime } from "./runtime";
import { createReceiver } from "./receiver";
import { createStarter } from "./start";
import { bindOutputs } from "./outputs";
import { fetchModels } from "./models";

// Bun supports authenticated WebSocket construction; the DOM declaration omits this server-only overload.
const ServerSocket = WebSocket as unknown as new (
	url: string,
	options: { headers: Record<string, string> },
) => WebSocket;
const defaultConnect: ConnectLive = (key) =>
	new ServerSocket("wss://api.openai.com/v1/live/sessions", {
		headers: { Authorization: `Bearer ${key}` },
	});

export function createLiveVoice({
	store,
	settings,
	conversation,
	connect = defaultConnect,
	clock = () => new Date().toISOString(),
	stopLegacy = async () => {},
}: {
	store: SqliteStore;
	settings: SettingsService;
	conversation: LiveConversationPort;
	connect?: ConnectLive;
	clock?: () => string;
	stopLegacy?: () => Promise<void>;
}) {
	const runtimes = new Map<string, Runtime>();
	const isActive = (conversationId: string) =>
		store.read((db) => !!active(db, conversationId));
	function state(id: string) {
		const value = store.read((db) => snapshot(db, id));
		return value && runtimes.get(id)?.failed
			? {
					...value,
					status: "failed" as const,
					error: "live_storage_failed",
					usageConfirmed: false,
				}
			: value;
	}
	function emit(id: string, event: LiveEvent) {
		const runtime = runtimes.get(id);
		if (!runtime) return;
		if (runtime.listener) runtime.listener(event);
		else {
			runtime.pending.push(event);
			if (runtime.pending.length > 80)
				void finish(id, "failed", "live_stream_not_attached");
		}
	}
	function sendState(id: string) {
		const value = state(id);
		if (value) emit(id, { type: "state", state: value });
	}
	const delivery = createLiveDelivery(
		store,
		sendState,
		(id) => runtimes.has(id) && !runtimes.get(id)?.failed,
	);
	function valid(id: string) {
		if (runtimes.get(id)?.failed) return false;
		const row = store.read((db) => session(db, id));
		if (!row || !activeStatuses.includes(row.status)) return false;
		try {
			const cfg = liveConfig(settings, false);
			return (
				cfg.connection.id === row.connection_id &&
				cfg.connection.epoch === row.connection_epoch
			);
		} catch {
			return false;
		}
	}
	function send(id: string, event: unknown) {
		if (!valid(id)) throw new Error("live_permission_revoked");
		const runtime = runtimes.get(id);
		if (!runtime || runtime.socket.readyState !== 1)
			throw new Error("live_session_inactive");
		if (runtime.socket.bufferedAmount > 512_000)
			throw new Error("live_audio_backpressure");
		runtime.socket.send(JSON.stringify(event));
	}
	const finish = createTerminator({
		store,
		runtimes,
		conversation,
		clock,
		state,
	});
	function enqueue(id: string, work: () => Promise<void>) {
		const rt = runtimes.get(id);
		if (!rt) return;
		rt.tail = rt.tail
			.then(work)
			.catch(() => finish(id, "failed", "live_protocol_failed"));
	}
	const receive = createReceiver({
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
	});
	const start = createStarter({
		store,
		settings,
		conversation,
		connect,
		clock,
		stopLegacy,
		runtimes,
		isActive,
		state,
		finish,
		send,
		enqueue,
		receive,
	});
	async function stop(id: string) {
		const value = state(id);
		if (
			!value ||
			!activeStatuses.includes(value.status) ||
			value.status === "closing"
		)
			return value;
		try {
			send(id, { type: "session.close" });
			await store.write((db) => {
				db.query(
					"UPDATE live_voice_sessions SET status='closing' WHERE id=?",
				).run(id);
			});
			const rt = runtimes.get(id);
			if (rt)
				rt.closeTimer = setTimeout(
					() => void finish(id, "interrupted", "live_close_unconfirmed"),
					15000,
				);
			sendState(id);
		} catch {
			await finish(id, "interrupted", "live_disconnected");
		}
		return state(id);
	}
	function attach(id: string, listener: (event: LiveEvent) => void) {
		const rt = runtimes.get(id);
		if (!rt || rt.listener || rt.failed)
			throw new Error("live_stream_unavailable");
		clearTimeout(rt.attachTimer);
		rt.listener = listener;
		for (const event of rt.pending.splice(0)) listener(event);
		sendState(id);
		return () => {
			rt.listener = undefined;
			void finish(id, "interrupted", "live_client_disconnected");
		};
	}
	const drain = bindOutputs({
		store,
		runtimes,
		valid,
		enqueue,
		finish,
		send,
		sendState,
		delivery,
	});
	const unsubscribe = settings.onChange(() => {
		for (const id of runtimes.keys())
			if (!valid(id)) void finish(id, "interrupted", "live_permission_revoked");
	});
	return {
		models: (signal: AbortSignal) => fetchModels(settings, signal),
		async start(raw: unknown) {
			for (const [id, rt] of runtimes)
				if (rt.failed) await finish(id, "failed", "live_storage_failed");
			return start(raw);
		},
		stop,
		state,
		isActive,
		attach,
		delivery,
		activeInTransaction: (db: Database, conversationId: string) =>
			!!active(db, conversationId),
		current: (conversationId: string) => {
			const id = store.read((db) => latest(db, conversationId)?.id);
			return id ? state(id) : null;
		},
		async audio(id: string, sequence: number, audio: string) {
			const value = state(id);
			if (!value || value.status !== "active")
				throw new Error("live_session_inactive");
			const rt = runtimes.get(id);
			if (!rt) throw new Error("live_session_inactive");
			if (sequence === rt.lastInput && audio === rt.lastAudio) return;
			if (sequence !== rt.lastInput + 1) throw new Error("live_audio_sequence");
			const bytes = Buffer.from(audio, "base64");
			if (!validPcm(audio, 24000)) throw new Error("live_audio_invalid");
			send(id, {
				type: "session.input_audio.append",
				audio: value.muted
					? Buffer.alloc(bytes.length).toString("base64")
					: audio,
			});
			rt.lastInput = sequence;
			rt.lastAudio = audio;
		},
		async mute(id: string, muted: boolean) {
			send(id, {
				type: muted ? "session.input_audio.mute" : "session.input_audio.unmute",
				event_id: crypto.randomUUID(),
			});
		},
		purgeInTransaction(
			db: Database,
			messageId: string,
			conversationId?: string,
		) {
			const own = purgeMessage(db, messageId);
			const row = own
				? session(db, own)
				: conversationId
					? active(db, conversationId)
					: null;
			if (!row) return;
			publishSegments(db, row.id, conversation, clock());
			db.query(
				"UPDATE live_voice_sessions SET status='interrupted',error='live_history_changed',input_version=input_version+1 WHERE id=? AND status IN ('connecting','active','closing')",
			).run(row.id);
		},
		async recover() {
			await store.write((db) => {
				const rows = db
					.query(
						"SELECT id FROM live_voice_sessions WHERE status IN ('connecting','active','closing')",
					)
					.all() as { id: string }[];
				for (const r of rows) {
					publishSegments(db, r.id, conversation, clock());
					if (session(db, r.id)?.test) {
						db.query("DELETE FROM live_voice_fragments WHERE session_id=?").run(
							r.id,
						);
						db.query("DELETE FROM live_voice_segments WHERE session_id=?").run(
							r.id,
						);
					}
				}
				db.query(
					"UPDATE live_voice_sessions SET status='interrupted',error='live_process_restarted' WHERE status IN ('connecting','active','closing')",
				).run();
			});
		},
		async close() {
			drain();
			unsubscribe();
			await Promise.all(
				[...runtimes.keys()].map((id) =>
					finish(id, "interrupted", "live_shutdown"),
				),
			);
		},
		proposeInTransaction(db: Database, conversationId: string, text: string) {
			const row = active(db, conversationId);
			if (!row || row.test) return false;
			db.query(
				"INSERT INTO live_voice_outputs(session_id,text,kind) VALUES(?,?,'commentary')",
			).run(row.id, text);
			return true;
		},
	};
}
export type LiveVoiceService = ReturnType<typeof createLiveVoice>;
