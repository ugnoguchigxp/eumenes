import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migrations as settingsMigrations,
} from "../../settings";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../conversation";
import { createLiveVoice, migrations } from "..";
import type { LiveSocket } from "../contracts";

export class Peer extends EventTarget {
	readyState = 0;
	bufferedAmount = 0;
	sent: Array<Record<string, unknown>> = [];
	send(value: string) {
		this.sent.push(JSON.parse(value));
	}
	close() {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
	open() {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}
	event(value: unknown) {
		this.dispatchEvent(
			new MessageEvent("message", { data: JSON.stringify(value) }),
		);
	}
}
export async function until(check: () => boolean) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > end) throw new Error("fixture_timeout");
		await Bun.sleep(2);
	}
}
export async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-live-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [
		...settingsMigrations,
		...conversationMigrations,
		...migrations,
	]);
	const settings = await createSettings(store, { dbPath, env: {} });
	const conversation = createConversationService(store);
	const connectionId = crypto.randomUUID();
	const doc = settings.get();
	doc.connections.push({
		id: connectionId,
		name: "Fixture",
		baseUrl: "https://api.openai.com/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	doc.live = {
		enabled: true,
		cloudAllowed: true,
		connectionId,
		model: "fixture-voice",
		voice: "",
		startWithMicrophone: true,
		instructions: "",
	};
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: doc.revision,
		settings: doc,
		keys: [{ connectionId, value: "fixture-secret" }],
	});
	const peer = new Peer();
	const delegates: Array<{
		messageId: string;
		inputVersion: number;
		id: string;
	}> = [];
	let stopped = 0;
	const service = createLiveVoice({
		store,
		settings,
		connect: () => peer as unknown as LiveSocket,
		stopLegacy: async () => {
			stopped++;
		},
		conversation: {
			ensure: () => {},
			history: () => [],
			publish: (tx, input) =>
				conversation.appendInTransaction(tx, {
					id: input.id,
					conversationId: input.conversationId,
					role: input.role,
					text: input.text,
					createdAt: input.at,
					runId: null,
				}),
			delegate(tx, input) {
				const id = crypto.randomUUID();
				delegates.push({ ...input, id });
				service.delivery.capture(tx, id, input.conversationId);
				return { id };
			},
			wake: () => {},
			cancelReply: async () => ({ status: "completed" }),
		},
	});
	async function start(test = false) {
		const s = await service.start({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			test,
		});
		service.attach(s.id, () => {});
		peer.open();
		peer.event({
			type: "session.started",
			session: { id: "fixture-provider" },
		});
		await until(() => service.state(s.id)?.status === "active");
		return s.id;
	}
	return {
		store,
		settings,
		conversation,
		peer,
		service,
		start,
		delegates,
		stopped: () => stopped,
		async close() {
			await service.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
