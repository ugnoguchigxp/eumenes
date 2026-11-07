import { expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { setup, done } from "./task-execution-harness";

test("an owner-selected capability executes once without a parent planning call and replays the same receipt", async () => {
	const h = await setup([], done("created"));
	const input = {
		source: h.source,
		chainRevisionId: "toolchain:lookup@1",
		request: h.source.request,
		references: [],
		deadline: Date.now() + 300_000,
	};
	const first = await h.store.write((db) =>
		h.runtime.startSelectedInTransaction(db, input),
	);
	await waitFor(() => h.get(first.id).status === "completed");
	expect(h.get(first.id).result?.summary).toBe("created");
	expect(h.stats()).toMatchObject({ count: 0, dispatches: 1, searches: 0 });
	expect(
		(
			await h.store.write((db) =>
				h.runtime.startSelectedInTransaction(db, input),
			)
		).id,
	).toBe(first.id);
	expect(h.stats().dispatches).toBe(1);
	await expect(
		h.store.write((db) =>
			h.runtime.startSelectedInTransaction(db, {
				...input,
				request: "different",
			}),
		),
	).rejects.toThrow("request_conflict");
});

test("a selected capability waits for its asynchronous result, and invalidation cancels it", async () => {
	const h = await setup([], { ...done(), state: "running" });
	const view = await h.store.write((db) =>
		h.runtime.startSelectedInTransaction(db, {
			source: h.source,
			chainRevisionId: "toolchain:lookup@1",
			request: h.source.request,
			references: [],
			deadline: Date.now() + 300_000,
		}),
	);
	await waitFor(() => h.children.length === 1);
	expect(h.get(view.id).result).toBeNull();
	h.invalidate();
	await h.runtime.reconcile();
	expect(h.get(view.id).status).toBe("failed");
	expect(h.stats().count).toBe(0);
	expect(h.stats().cancels).toBeGreaterThan(0);
});
