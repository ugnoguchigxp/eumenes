import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import {
	SCREEN_COMMAND_TTL_MS,
	createScreen,
	migrations,
	registerScreen,
	type ScreenCommand,
} from "..";

const T0 = Date.parse("2026-10-25T00:00:00.000Z");

function open() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-screen-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		{ id: "conversation/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	let clock = T0;
	const settled: ScreenCommand[] = [];
	const screen = createScreen({
		store,
		now: () => clock,
		onSettled: (_db, command) => settled.push(command),
	});
	return {
		store,
		screen,
		settled,
		setNow: (ms: number) => {
			clock = ms;
		},
		issue: (conversationId = "main", action: "open" | "play" = "play") =>
			store.write((db) =>
				screen.issueInTransaction(db, {
					conversationId,
					uri: "eumenes://music.track/t1",
					action,
					adapterRef: "adapter:music",
					targetRef: "playlist-1",
				}),
			),
		async close() {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("issue, pendingAfter and the first receipt settle a command; a later receipt is command_settled", async () => {
	const h = open();
	try {
		const first = await h.issue("main", "play");
		const second = await h.issue("main", "open");
		const other = await h.issue("other");
		expect(first).toMatchObject({
			seq: 1,
			conversationId: "main",
			uri: "eumenes://music.track/t1",
			action: "play",
			adapterRef: "adapter:music",
			targetRef: "playlist-1",
			status: "pending",
			createdAt: "2026-10-25T00:00:00.000Z",
			settledAt: null,
		});
		expect(other.seq).toBeGreaterThan(second.seq);
		expect(h.screen.pendingAfter("main", 0).map((c) => c.seq)).toEqual([
			first.seq,
			second.seq,
		]);
		expect(h.screen.pendingAfter("main", first.seq).map((c) => c.seq)).toEqual([
			second.seq,
		]);

		h.setNow(T0 + 1000);
		const done = await h.screen.receipt(first.seq, "done");
		expect(done).toMatchObject({
			ok: true,
			command: {
				seq: first.seq,
				status: "done",
				settledAt: "2026-10-25T00:00:01.000Z",
			},
		});
		expect(await h.screen.receipt(first.seq, "blocked")).toEqual({
			ok: false,
			code: "command_settled",
		});
		expect(h.screen.command(first.seq)?.status).toBe("done");
		expect(h.screen.pendingAfter("main", 0).map((c) => c.seq)).toEqual([
			second.seq,
		]);
		expect(await h.screen.receipt(999, "done")).toEqual({
			ok: false,
			code: "command_not_found",
		});
		expect((await h.screen.receipt(second.seq, "blocked")).ok).toBe(true);
		expect(h.settled.map((c) => [c.seq, c.status])).toEqual([
			[first.seq, "done"],
			[second.seq, "blocked"],
		]);
	} finally {
		await h.close();
	}
});

test("a pending command older than the TTL is hidden, expires on the next issue and can no longer be received", async () => {
	const h = open();
	try {
		const old = await h.issue();
		const stale = await h.issue();
		h.setNow(T0 + SCREEN_COMMAND_TTL_MS - 1);
		expect(h.screen.pendingAfter("main", 0)).toHaveLength(2);
		h.setNow(T0 + SCREEN_COMMAND_TTL_MS + 1);
		expect(h.screen.pendingAfter("main", 0)).toEqual([]);
		// The receipt of a command past the TTL settles it as expired.
		expect(await h.screen.receipt(old.seq, "done")).toEqual({
			ok: false,
			code: "command_settled",
		});
		expect(h.screen.command(old.seq)?.status).toBe("expired");
		// A new issue sweeps the rest.
		const fresh = await h.issue();
		expect(h.screen.command(stale.seq)).toMatchObject({
			status: "expired",
			settledAt: "2026-10-25T00:00:30.001Z",
		});
		expect(h.screen.pendingAfter("main", 0).map((c) => c.seq)).toEqual([
			fresh.seq,
		]);
		expect(h.settled.map((c) => [c.seq, c.status])).toEqual([
			[old.seq, "expired"],
			[stale.seq, "expired"],
		]);
		// Expiry only touches pending commands.
		await h.store.write((db) => h.screen.expireInTransaction(db));
		expect(h.settled).toHaveLength(2);
	} finally {
		await h.close();
	}
});

test("HTTP: commands are listed after a seq and receipts map to 200, 404, 409 and 400", async () => {
	const h = open();
	try {
		const app = new Hono();
		registerScreen(app, h.screen);
		const a = await h.issue();
		const b = await h.issue();
		const list = async (query: string) =>
			app.request(`/api/screen/commands${query}`);
		const listed = (await (
			await list("?conversationId=main&after=0")
		).json()) as {
			commands: ScreenCommand[];
		};
		expect(listed.commands.map((c) => c.seq)).toEqual([a.seq, b.seq]);
		expect(
			(
				(await (await list(`?conversationId=main&after=${a.seq}`)).json()) as {
					commands: ScreenCommand[];
				}
			).commands.map((c) => c.seq),
		).toEqual([b.seq]);
		expect((await list("?after=0")).status).toBe(400);
		expect((await list("?conversationId=main&after=x")).status).toBe(400);

		const receipt = (seq: string, body: unknown) =>
			app.request(`/api/screen/commands/${seq}/receipt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const ok = await receipt(String(a.seq), { outcome: "unavailable" });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({
			ok: true,
			command: { seq: a.seq, status: "unavailable" },
		});
		const again = await receipt(String(a.seq), { outcome: "done" });
		expect(again.status).toBe(409);
		expect(await again.json()).toEqual({ ok: false, code: "command_settled" });
		expect((await receipt("99", { outcome: "done" })).status).toBe(404);
		expect((await receipt(String(b.seq), { outcome: "pending" })).status).toBe(
			400,
		);
		expect(
			(await receipt(String(b.seq), { outcome: "done", x: 1 })).status,
		).toBe(400);
		expect((await receipt("abc", { outcome: "done" })).status).toBe(400);
	} finally {
		await h.close();
	}
});
