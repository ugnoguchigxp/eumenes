import { expect, test } from "bun:test";
import { Hono } from "hono";
import { errorStatus, registerKanban } from "..";
import { openKanban } from "./kanban.fixture";

/** The notice API over a real store; thrown codes map to the domain's statuses as the app does. */
function api() {
	const { store, kanban } = openKanban();
	const app = new Hono();
	app.onError((error, c) =>
		c.json(
			{ error: error.message },
			(errorStatus as unknown as Record<string, 404>)[error.message] ?? 500,
		),
	);
	registerKanban(app, kanban);
	return { app, store, kanban };
}

async function twoNotices(ctx: ReturnType<typeof api>) {
	const { store, kanban } = ctx;
	for (const title of ["A", "B"]) {
		const card = (
			await store.write((tx) =>
				kanban.addInTransaction(tx, { title, prompt: "依頼" }, `add-${title}`),
			)
		).receipt;
		const run = await store.write((tx) =>
			kanban.runInTransaction(
				tx,
				{ cardId: card.cardId, expectedRevision: 1 },
				`run-${title}`,
				{ origin: "board", runnable: true },
			),
		);
		await store.write((tx) =>
			kanban.finishRunInTransaction(tx, {
				runId: run.receipt.runId!,
				state: "completed",
				lastReport: "",
				files: [],
			}),
		);
	}
}

test("GET lists notices newest first with the unread count and honours limit", async () => {
	const ctx = api();
	await twoNotices(ctx);
	const all = await (await ctx.app.request("/api/kanban/notices")).json();
	expect(all.unread).toBe(2);
	expect(all.notices.map((n: { text: string }) => n.text)).toEqual([
		"タスク『B』が終わりました",
		"タスク『A』が終わりました",
	]);
	expect(all.notices[0]).toMatchObject({ kind: "done", read: false });
	const one = await (
		await ctx.app.request("/api/kanban/notices?limit=1")
	).json();
	expect(one.notices).toHaveLength(1);
	expect(one.unread).toBe(2);
	for (const bad of ["0", "51", "x", "1.5"])
		expect(
			(await ctx.app.request(`/api/kanban/notices?limit=${bad}`)).status,
		).toBe(400);
});

test("POST read marks a notice read (204) and refuses an unknown one (404)", async () => {
	const ctx = api();
	await twoNotices(ctx);
	const [first] = (await (await ctx.app.request("/api/kanban/notices")).json())
		.notices;
	const read = await ctx.app.request(`/api/kanban/notices/${first.id}/read`, {
		method: "POST",
	});
	expect(read.status).toBe(204);
	const after = await (await ctx.app.request("/api/kanban/notices")).json();
	expect(after.unread).toBe(1);
	expect(after.notices[0].read).toBe(true);
	// Reading again is harmless.
	expect(
		(
			await ctx.app.request(`/api/kanban/notices/${first.id}/read`, {
				method: "POST",
			})
		).status,
	).toBe(204);
	for (const id of ["00000000-0000-4000-8000-0000000000ff", "not-an-id"]) {
		const missing = await ctx.app.request(`/api/kanban/notices/${id}/read`, {
			method: "POST",
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "kanban_notice_not_found" });
	}
});
