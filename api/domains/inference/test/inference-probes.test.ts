import { afterEach, expect, spyOn, test } from "bun:test";
import { WriterBusyError } from "../../../infrastructure/sqlite";
import { cleanup, setup, probeRow } from "./inference.fixture";
import { waitFor } from "../../../infrastructure/wait-for";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
test("a probe stuck running for over 10 minutes is marked probe_stale and a new probe starts", async () => {
	const { store, inference, settings } = await setup();
	await store.write((db) =>
		db
			.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
			.run("old", "larm", settings.get().revision, Date.now() - 11 * 60_000),
	);
	const { id } = await inference.startProbe("larm");
	expect(probeRow(store, "old")).toEqual({
		status: "failed",
		error: "probe_stale",
	});
	await waitFor(() => probeRow(store, id)?.status === "succeeded");
});
test("a probe registered inside a transaction runs after the commit and only if it committed", async () => {
	const { store, inference, settings } = await setup();
	const registered = await store.write((db) =>
		inference.startProbeInTransaction(db, "larm"),
	);
	expect(probeRow(store, registered.id)?.status).toBe("running");
	registered.launch();
	await waitFor(() => probeRow(store, registered.id)?.status === "succeeded");
	// A rolled-back registration leaves no row and launching it does nothing.
	let lost: ReturnType<typeof inference.startProbeInTransaction> | undefined;
	await store
		.write((db) => {
			lost = inference.startProbeInTransaction(db, "larm");
			throw new Error("rolled_back");
		})
		.catch(() => undefined);
	expect(probeRow(store, lost!.id)).toBeNull();
	lost!.launch();
	expect(probeRow(store, lost!.id)).toBeNull();
	// An unknown target is refused before a row is written.
	await expect(
		store.write((db) =>
			inference.startProbeInTransaction(db, crypto.randomUUID()),
		),
	).rejects.toThrow("invalid_probe_target");
	// A resource target runs against its saved resource.
	const resource = settings.get().resources[0]!;
	const second = await store.write((db) =>
		inference.startProbeInTransaction(db, resource.id),
	);
	second.launch();
	await waitFor(() => probeRow(store, second.id)?.status !== "running");
});
test("a probe cancel is a mark written by the transaction: a rollback leaves it running", async () => {
	const { store, inference, settings } = await setup();
	await store.write((db) =>
		db
			.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
			.run("live", "larm", settings.get().revision, Date.now()),
	);
	await store
		.write((db) => {
			inference.cancelProbeInTransaction(db, "live");
			throw new Error("rolled_back");
		})
		.catch(() => undefined);
	expect(probeRow(store, "live")?.status).toBe("running");
	await store.write((db) => inference.cancelProbeInTransaction(db, "live"));
	expect(probeRow(store, "live")?.status).toBe("cancelling");
	// Only a running probe is marked; a stuck mark is failed like a stuck run.
	await expect(
		store.write((db) => inference.cancelProbeInTransaction(db, "live")),
	).rejects.toThrow("probe_not_running");
	await expect(
		store.write((db) => inference.cancelProbeInTransaction(db, "none")),
	).rejects.toThrow("probe_not_found");
	await inference.recover();
	expect(probeRow(store, "live")?.status).toBe("interrupted");
});
test("a recent running probe still blocks a new one", async () => {
	const { store, inference, settings } = await setup();
	await store.write((db) =>
		db
			.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
			.run("recent", "larm", settings.get().revision, Date.now() - 60_000),
	);
	await expect(inference.startProbe("larm")).rejects.toThrow(
		"invalid_probe_busy",
	);
	expect(probeRow(store, "recent")?.status).toBe("running");
});
test("the final probe status survives a momentarily full writer queue", async () => {
	const { store, inference } = await setup();
	const write = store.write.bind(store);
	let writes = 0;
	const spy = spyOn(store, "write").mockImplementation(((
		operation: Parameters<typeof write>[0],
	) =>
		writes++ === 1
			? Promise.reject(new WriterBusyError())
			: write(operation)) as typeof store.write);
	try {
		const { id } = await inference.startProbe("larm");
		await waitFor(() => probeRow(store, id)?.status === "succeeded");
		expect(writes).toBeGreaterThanOrEqual(3);
	} finally {
		spy.mockRestore();
	}
});
