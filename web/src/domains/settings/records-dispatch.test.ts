import { expect, test, vi } from "vitest";
import type { ArtifactEvent } from "@eumenes/artifact-ui";
import { createRecordsDispatch } from "./records-dispatch";
import type { Recipe } from "./records-presentation";

test("record commands reject foreign sources, stale and malformed choices; locks and receipts fence mutations", async () => {
	let done!: () => void;
	let alive = true;
	const state = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				done = resolve;
			}),
	);
	const refresh = vi.fn(async () => {});
	const dispatch = createRecordsDispatch({
		revision: () => 2,
		alive: () => alive,
		recipes: () => [{ id: "r" } as Recipe],
		refresh,
		query: () => {},
		state,
		remove: refresh,
		download: refresh,
	});
	const event = (patch: Partial<ArtifactEvent> = {}): ArtifactEvent => ({
		id: crypto.randomUUID(),
		source: "settings-records",
		revision: 2,
		action: "records-procedure-state",
		values: { id: "r", enabled: false },
		...patch,
	});
	const cases: Partial<ArtifactEvent>[] = [
		{ source: "foreign" },
		{ revision: 1 },
		{ values: { id: "other", enabled: false } },
		{ values: { id: "r", enabled: "true" } },
		{ values: { id: "r", enabled: true, extra: true } },
		{ action: "settings-apply" as const },
		{ action: "records-query" as const, values: { tabId: "ai" } },
	];
	for (const patch of cases)
		expect((await dispatch(event(patch))).status).not.toBe("accepted");
	expect(state).not.toHaveBeenCalled();
	const input = event();
	const pending = dispatch(input);
	expect((await dispatch(input)).status).toBe("duplicate");
	expect((await dispatch(event())).status).toBe("rejected");
	expect(state).toHaveBeenCalledOnce();
	alive = false;
	done();
	expect((await pending).status).toBe("rejected");
	expect(
		(await dispatch(event({ action: "records-refresh", values: {} }))).status,
	).toBe("rejected");
	expect(refresh).not.toHaveBeenCalled();
});

test("failed commands return a retryable message without automatically repeating a write", async () => {
	const remove = vi.fn(async () => {
		throw new Error("failed");
	});
	const noop = vi.fn(async () => {});
	const dispatch = createRecordsDispatch({
		revision: () => 1,
		alive: () => true,
		recipes: () => [{ id: "r" } as Recipe],
		refresh: noop,
		query: () => {},
		state: noop,
		remove,
		download: noop,
	});
	const event: ArtifactEvent = {
		id: "e",
		source: "settings-records",
		revision: 1,
		action: "records-procedure-delete",
		values: { id: "r" },
	};
	expect((await dispatch(event)).message).toContain("状態を確認");
	expect((await dispatch(event)).status).toBe("duplicate");
	expect(remove).toHaveBeenCalledOnce();
});
