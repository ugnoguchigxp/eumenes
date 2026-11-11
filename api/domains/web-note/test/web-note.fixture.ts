import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "../../../application/migrations";
import { offlineBundleHost } from "../../../application/toolchain/toolchain-adapters";
import { createCapabilities, hash } from "../../capabilities";
import { createQueue } from "../../queue";
import {
	createWebNote,
	type SourcePort,
	type WebNoteAttempt,
	type WebNoteTurn,
} from "..";

export const NOTE_TEXT = [
	"題: 七里ヶ浜の日の出",
	"要約: 2026年11月12日の日の出は6時12分ごろ。",
	"---",
	"## 日の出と日の入り",
	"2026年11月11日時点の情報では、11月12日の日の出は6:12です。",
	"## 出典",
	"- [気象庁](https://www.jma.go.jp/sunrise)",
	"- https://example.com/almanac",
].join("\n");

type Turn = Parameters<WebNoteTurn>[0];
/** The scripted Codex of a test: no real model and no network. */
export async function fixture(
	options: {
		turn?: WebNoteTurn | null;
		record?: ((attempt: WebNoteAttempt) => Promise<void>) | null;
		/** The clock's start (epoch ms). */
		at?: number;
		/** The model of the saved setting (default a fixture model; null is Codex's own default). */
		model?: () => string | null;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-web-note-")),
		path = join(dir, "db");
	const store = openStore(path, migrations);
	let now = options.at ?? Date.now(),
		valid = true;
	const calls: Turn[] = [],
		attempts: WebNoteAttempt[] = [],
		notices: Array<{ status: string; eventId: string; result: unknown }> = [];
	const turn: WebNoteTurn | undefined =
		options.turn === null
			? undefined
			: (options.turn ??
				(async (call) => {
					calls.push(call);
					return {
						text: NOTE_TEXT,
						searches: 2,
						usage: {
							input: 25000,
							cachedInput: 20000,
							output: 900,
							reasoning: 300,
						},
					};
				}));
	const queue = createQueue(store, {
		pollMs: 2,
		resources: { "codex.search": 2 },
		now: () => now,
	});
	const capabilities = createCapabilities(store, new Set(["web-note"]), {
		bundleHost: offlineBundleHost,
	});
	await capabilities.seed();
	const source: SourcePort = {
		validSourceInTransaction: () => valid,
		deliverInTransaction: (_db, view, eventId) => {
			notices.push({ status: view.status, eventId, result: view.result });
			return true;
		},
		revokeDeliveryInTransaction: () => {},
	};
	const service = createWebNote({
		store,
		queue,
		capabilities,
		...(turn ? { turn } : {}),
		model: options.model ?? (() => "fixture-model"),
		record:
			options.record === null
				? undefined
				: (options.record ??
					(async (attempt) => {
						attempts.push(attempt);
					})),
		now: () => now,
	});
	service.configure(source);
	const request = "明日の七里ヶ浜の日の出時刻を調べる";
	const start = (text = request, extra: { deadline?: number } = {}) =>
		store.write((db) =>
			service.task.startInTransaction(db, {
				source: {
					conversationId: "main",
					runId: "origin",
					messageId: "message",
					request: text,
					digest: hash(text),
				},
				request: text,
				references: [],
				toolchainRevisionId: "toolchain:web.note@1",
				bindingRevisionId: "binding:web.note@1",
				...extra,
			}),
		);
	return {
		dir,
		request,
		calls,
		attempts,
		notices,
		store,
		service,
		queue,
		start,
		run() {
			queue.start();
		},
		view: (id: string) =>
			store.readSnapshot((db) => service.task.viewInTransaction(db, id)),
		invalidate: () => {
			valid = false;
		},
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
		async close() {
			service.close();
			await queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
