import { expect, test } from "bun:test";
import { environment, fixture } from "./compute.fixture";

const discovered = (revision: string) => ({
	url: "http://compute.test/v1/compute",
	description: "CPU",
	environment: { ...environment, environmentRevision: revision },
});

test("cold discovery is shared while a cancelled caller cannot create a job", async () => {
	const f = await fixture({ warm: false });
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let discoveries = 0;
	f.port.discover = async () => {
		discoveries++;
		entered.resolve();
		await gate.promise;
		return discovered("shared");
	};
	try {
		expect(f.store.read(f.service.availableInTransaction)).toBe(true);
		expect(f.service.list("owner")).toEqual([]);
		await expect(
			f.service.submit("owner", "main", {}, "invalid"),
		).rejects.toThrow("invalid_request");
		expect(discoveries).toBe(0);

		const caller = new AbortController();
		const waiting = f.service.submit(
			"owner",
			"main",
			{ code: "result=1" },
			"cancelled",
			caller.signal,
		);
		await entered.promise;
		expect(await f.store.write(() => "writer_available")).toBe(
			"writer_available",
		);
		const active = f.service.submit(
			"owner",
			"main",
			{ code: "result=2" },
			"active",
		);
		caller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
		expect(discoveries).toBe(1);
		expect(f.service.list("owner")).toEqual([]);
		gate.resolve();
		const accepted = await active;
		expect(f.service.list("owner").map((row) => row.id)).toEqual([
			accepted.jobId,
		]);
		expect(
			await f.service.submit("owner", "main", { code: "result=2" }, "active"),
		).toEqual(accepted);
		expect(discoveries).toBe(1);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("a new binding discovers independently and a late old response cannot replace it", async () => {
	const f = await fixture({ warm: false });
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const visited: string[] = [];
	f.state.binding = "old";
	f.port.discover = async () => {
		const binding = f.port.binding;
		visited.push(binding);
		if (binding === "old") {
			entered.resolve();
			await gate.promise;
		}
		return discovered(binding);
	};
	try {
		const old = f.service.refresh();
		await entered.promise;
		f.state.binding = "new";
		await f.service.refresh();
		const revision = () =>
			f.store.read(
				(db) =>
					f.service.snapshotInTransaction(db, "owner").environment
						?.environmentRevision,
			);
		expect(revision()).toBe("new");
		gate.resolve();
		await old;
		expect(revision()).toBe("new");
		expect(visited).toEqual(["old", "new"]);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("a known discovery failure suppresses new selection until the next retry", async () => {
	const f = await fixture({ warm: false });
	let discoveries = 0;
	f.port.discover = async () => {
		if (++discoveries === 1) throw new Error("fixture failure");
		return discovered("available");
	};
	try {
		await f.service.refresh();
		expect(f.store.read(f.service.availableInTransaction)).toBe(false);
		await f.service.refresh();
		expect(discoveries).toBe(1);
		await f.store.write((db) =>
			db
				.query("UPDATE compute_environment SET checked_at=?")
				.run(Date.now() - 60_001),
		);
		expect(f.store.read(f.service.availableInTransaction)).toBe(true);
		await f.service.refresh();
		expect(discoveries).toBe(2);
		expect(
			f.store.read(
				(db) => f.service.snapshotInTransaction(db, "owner").environment,
			),
		).toMatchObject({ environmentRevision: "available" });
	} finally {
		await f.close();
	}
});

test("a selected command refreshes an aging environment before translating the request", async () => {
	const f = await fixture();
	let discoveries = 0;
	f.port.discover = async () => {
		discoveries++;
		return discovered("renewed");
	};
	try {
		await f.store.write((db) =>
			db
				.query("UPDATE compute_environment SET checked_at=?")
				.run(Date.now() - 60_001),
		);
		expect(
			f.store.read(
				(db) => f.service.snapshotInTransaction(db, "owner").environment,
			),
		).toMatchObject({ environmentRevision: "fixture-revision" });
		expect(f.store.read(f.service.needsDiscoveryInTransaction)).toBe(true);
		await f.service.refresh();
		expect(f.store.read(f.service.needsDiscoveryInTransaction)).toBe(false);
		expect(discoveries).toBe(1);
	} finally {
		await f.close();
	}
});
