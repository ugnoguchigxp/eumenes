import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { SettingsService } from "../../settings";
import {
	liveStartSchema,
	type ConnectLive,
	type LiveSocket,
	type LiveConversationPort,
	type LiveSnapshot,
} from "../contracts";
import { active } from "../repository";
import type { Runtime } from "./runtime";
import { liveConfig, liveInstructions } from "./config";
import { historyInput } from "./protocol";
export function createStarter({
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
}: {
	store: SqliteStore;
	settings: SettingsService;
	conversation: LiveConversationPort;
	connect: ConnectLive;
	clock: () => string;
	stopLegacy: () => Promise<void>;
	runtimes: Map<string, Runtime>;
	isActive: (id: string) => boolean;
	state: (id: string) => LiveSnapshot | null;
	finish: (
		id: string,
		status: "closed" | "failed" | "interrupted",
		error?: string | null,
	) => Promise<void>;
	send: (id: string, event: unknown) => void;
	enqueue: (id: string, work: () => Promise<void>) => void;
	receive: (id: string, raw: unknown) => Promise<void>;
}) {
	async function start(raw: unknown) {
		const input = liveStartSchema.parse(raw);
		const cfg = liveConfig(settings);
		const reused = store.read(
			(db) =>
				db
					.query(
						"SELECT id,conversation_id,test FROM live_voice_sessions WHERE request_id=?",
					)
					.get(input.requestId) as {
					id: string;
					conversation_id: string;
					test: number;
				} | null,
		);
		if (reused) {
			if (
				reused.conversation_id !== input.conversationId ||
				!!reused.test !== !!input.test
			)
				throw new Error("live_request_conflict");
			return state(reused.id)!;
		}
		if (isActive(input.conversationId))
			throw new Error("live_conversation_busy");
		const id = crypto.randomUUID();
		const at = clock();
		await store.write((db) => {
			if (active(db, input.conversationId))
				throw new Error("live_conversation_busy");
			conversation.ensure(db, input.conversationId, at);
			db.query(
				"INSERT INTO live_voice_sessions(id,request_id,conversation_id,status,muted,test,started_at,connection_id,connection_epoch) VALUES(?,?,?,'connecting',?,?,?,?,?)",
			).run(
				id,
				input.requestId,
				input.conversationId,
				cfg.live.startWithMicrophone ? 0 : 1,
				input.test ? 1 : 0,
				at,
				cfg.connection.id,
				cfg.connection.epoch,
			);
		});
		let socket: LiveSocket;
		try {
			await stopLegacy();
			socket = connect(cfg.key);
		} catch {
			await finish(id, "failed", "live_connect_failed");
			return state(id)!;
		}
		const rt: Runtime = {
			socket,
			tail: Promise.resolve(),
			pending: [],
			lastInput: 0,
			lastAudio: "",
			output: 0,
		};
		runtimes.set(id, rt);
		rt.startupTimer = setTimeout(
			() => void finish(id, "failed", "live_start_timeout"),
			20000,
		);
		rt.attachTimer = setTimeout(
			() => void finish(id, "failed", "live_stream_not_attached"),
			10000,
		);
		socket.addEventListener("open", () => {
			try {
				const history = input.test
					? []
					: store.read((db) => conversation.history(db, input.conversationId));
				const kept = historyInput(history);
				send(id, {
					type: "session.start",
					session: {
						model: cfg.live.model,
						instructions: liveInstructions(cfg),
						audio: {
							format: { type: "audio/pcm", rate: 24000 },
							...(cfg.live.voice ? { output: { voice: cfg.live.voice } } : {}),
						},
						input: kept,
						store: false,
						delegation: { type: "client" },
					},
				});
			} catch {
				void finish(id, "failed", "live_connect_failed");
			}
		});
		socket.addEventListener("message", (event) =>
			enqueue(id, () => receive(id, (event as MessageEvent).data)),
		);
		socket.addEventListener(
			"error",
			() => void finish(id, "failed", "live_connect_failed"),
		);
		socket.addEventListener("close", () => {
			if (runtimes.has(id) && !runtimes.get(id)?.failed)
				void finish(id, "interrupted", "live_disconnected");
		});
		return state(id)!;
	}

	return start;
}
