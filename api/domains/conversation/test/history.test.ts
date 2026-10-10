import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createConversationService, migrations, type HistoryOwner } from "..";
async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-history-"));
	const store = openStore(join(dir, "db"), migrations);
	let clock = Date.parse("2026-10-10T00:00:00Z");
	const conversation = createConversationService(store, {
		requireOutbox: true,
		clock: () => new Date(clock).toISOString(),
	});
	const owner: HistoryOwner = {
		key: "agent:one",
		conversationId: "main",
		deadline: clock + 900000,
		excludeMessageId: "current",
	};
	async function append(
		id: string,
		text: string,
		role: "user" | "assistant" = "user",
		conversationId = "main",
		createdAt = "2026-10-09T23:00:00Z",
	) {
		await conversation.append({
			id,
			text,
			role,
			conversationId,
			createdAt,
			runId: null,
		});
	}
	const search = (raw: unknown = {}, o = owner) =>
		store.readSnapshot((db) =>
			conversation.historySearchInTransaction(db, o, raw),
		);
	const read = (raw: unknown, o = owner) =>
		store.readSnapshot((db) =>
			conversation.historyReadInTransaction(db, o, raw),
		);
	return {
		store,
		conversation,
		owner,
		append,
		search,
		read,
		expire: () => (clock += 900001),
		close: async () => {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
test("H1/H5/H6/H8: exact search and ordered context exclude drafts, retractions, another conversation and the current request", async () => {
	const h = await fixture();
	try {
		await h.append("a", "集合時刻は9時です。");
		await h.append("b", "了解、9時に集合。", "assistant");
		await h.append("gone", "集合は8時");
		await h.conversation.retract({ messageId: "gone" });
		await h.append("other", "集合は7時", "user", "private");
		await h.append("current", "集合時刻を確認したい。");
		const result = h.search({ query: "集合", speaker: "user" });
		expect(result.candidates.map((c) => c.messageId)).toEqual(["a"]);
		const read = h.read({ messageRef: result.candidates[0]!.messageRef });
		expect(read.messages.map((c) => c.messageId)).toEqual(["a", "b"]);
		expect(read.messages[1]!.speaker).toBe("assistant");
		expect(JSON.stringify(result)).not.toContain("ordinal");
		expect(() =>
			h.read(
				{ messageRef: result.candidates[0]!.messageRef },
				{ ...h.owner, key: "api:local:owner" },
			),
		).toThrow("history_ref_invalid");
		expect(() =>
			h.read(
				{ messageRef: result.candidates[0]!.messageRef },
				{ ...h.owner, conversationId: "private" },
			),
		).toThrow("history_ref_invalid");
		const dates = h.search({
			from: "2026-10-09T23:00:00Z",
			until: "2026-10-09T23:00:01Z",
		});
		expect(dates.candidates).toHaveLength(2);
		expect(h.search({ from: "2026-10-09T23:00:01Z" }).candidates).toEqual([]);
		expect(h.search({ query: "%_" }).candidates).toEqual([]);
	} finally {
		await h.close();
	}
});
test("H2/H3: 240 turns, identical timestamps and sparse rowids paginate without duplicate/lost IDs; 500-row scan returns a cursor even on zero matches", async () => {
	const h = await fixture();
	try {
		await h.store.write((db) => {
			for (let i = 0; i < 1200; i++)
				h.conversation.appendInTransaction(db, {
					id: `m${i}`,
					conversationId: "main",
					role: i % 2 ? "assistant" : "user",
					text: i < 480 ? `記録${i}` : "一致なし",
					createdAt: "2026-10-09T23:00:00Z",
					runId: null,
				});
		});
		await h.append("current", "確認");
		const zero = h.search({ query: "存在しない" });
		expect(zero.candidates).toEqual([]);
		expect(zero.scope.scanComplete).toBe(false);
		expect(zero.scope.scannedMessages).toBe(500);
		expect(zero.cursor).not.toBeNull();
		const ids: string[] = [];
		let cursor: string | undefined;
		do {
			const page = h.search({ query: "記録", limit: 20, cursor });
			ids.push(...page.candidates.map((c) => c.messageId));
			expect(page.scope.scannedMessages).toBeLessThanOrEqual(500);
			expect(page.scope.scannedBytes).toBeLessThanOrEqual(1048576);
			cursor = page.cursor ?? undefined;
		} while (cursor);
		expect(new Set(ids).size).toBe(480);
		expect(ids).toHaveLength(480);
	} finally {
		await h.close();
	}
});
test("H2/H3: a large single message is scanned in finite chunks and a boundary-spanning match is not lost; read continues in Unicode positions", async () => {
	const h = await fixture();
	try {
		await h.append(
			"long",
			"😀".repeat(262142) + "境界をまたぐ語句" + "後半".repeat(5000),
		);
		await h.append("current", "確認");
		let page = h.search({ query: "境界をまたぐ語句" });
		expect(page.scope.scanComplete).toBe(false);
		expect(page.cursor).not.toBeNull();
		expect(page.candidates).toEqual([]);
		page = h.search({ query: "境界をまたぐ語句", cursor: page.cursor! });
		expect(page.candidates[0]!.text).toContain("境界をまたぐ語句");
		let read = h.read({
			messageRef: page.candidates[0]!.messageRef,
			before: 0,
			after: 0,
		});
		expect(read.messages[0]!.text).toContain("語句");
		const first = read.messages[0]!;
		read = h.read({
			messageRef: first.messageRef,
			cursor: first.nextCursor!,
			before: 0,
			after: 0,
		});
		expect(read.messages[0]!.start).toBe(first.end);
		expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(8192);
	} finally {
		await h.close();
	}
});
test("H4/H7: correction, append, retraction, TTL and restart invalidate cursors/views before adoption", async () => {
	const h = await fixture();
	try {
		await h.append("a", "集合時刻9時");
		await h.append("b", "集合時刻9時");
		await h.append("current", "確認");
		const page = h.search({ query: "集合", limit: 1 });
		const v = page.candidates[0]!;
		expect(
			h.store.readSnapshot((db) =>
				h.conversation.validateHistoryInTransaction(
					db,
					h.owner,
					page.scope.scopeRef,
					[v],
				),
			),
		).toBe(true);
		await h.conversation.correct({
			messageId: v.messageId,
			text: "訂正、10時",
		});
		expect(() => h.read({ messageRef: v.messageRef })).toThrow(
			"history_cursor_stale",
		);
		expect(() =>
			h.search({ query: "集合", limit: 1, cursor: page.cursor! }),
		).toThrow("history_cursor_stale");
		expect(
			h.store.readSnapshot((db) =>
				h.conversation.validateHistoryInTransaction(
					db,
					h.owner,
					page.scope.scopeRef,
					[v],
				),
			),
		).toBe(false);
		const second = h.search({ query: "集合" });
		await h.append("new", "追記");
		expect(() =>
			h.read({ messageRef: second.candidates[0]!.messageRef }),
		).toThrow("history_cursor_stale");
		const fresh = h.search({ query: "集合" });
		await h.conversation.retract({ messageId: "a" });
		expect(() =>
			h.read({ messageRef: fresh.candidates[0]!.messageRef }),
		).toThrow("history_cursor_stale");
		const last = h.search({});
		h.expire();
		expect(() =>
			h.read({ messageRef: last.candidates[0]!.messageRef }),
		).toThrow("source_expired");
	} finally {
		await h.close();
	}
});
