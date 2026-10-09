/**
 * P3-06 vertical slice on a REAL host store: temp file, WAL, the single Writer
 * and readonly reader, the full production migrations (host, Memory, World),
 * the real conversation SourceAdapter and the real Memory dependent API.
 *
 * Manual means: no extraction. A person's confirmed message is the source and
 * the structured claim is stated explicitly (fixture-grade claim text).
 * NOT covered here (phase 2): forget/restore lifecycle and the World journal.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildWorldSlice, toSliceReceipt } from "eumenes-world-model";
import type { WorldSnapshotResult } from "eumenes-world-model/sqlite";
import {
	MemoryRegistrationRejected,
	WORLD_PROVIDER_REF,
	externalIdOf,
} from "..";
import {
	ACCESS,
	NOW,
	SCOPE,
	addMessage,
	adoptPlan,
	claim,
	count,
	currentRef,
	dump,
	entityOp,
	keyOf,
	probe,
	registerClaim,
	request,
	withHarness,
	worldEdges,
	type Harness,
} from "./fixture";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { registerExternalDependents } from "eumenes-memory/sqlite";

const hasher = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const read = (h: Harness) =>
	h.world.read({ access: ACCESS, scope: SCOPE, asOf: NOW });
const ready = (result: WorldSnapshotResult | { status: string }) => {
	if (result.status !== "ready") throw new Error(JSON.stringify(result));
	return result as Extract<WorldSnapshotResult, { status: "ready" }>;
};
const sliceOf = async (h: Harness) => {
	const snapshot = ready(await read(h)).snapshot;
	const slice = buildWorldSlice(
		{ contractVersion: 1, snapshot, request: {} },
		hasher,
	);
	if (!slice.ok) throw new Error(slice.code);
	return { snapshot, slice: slice.value, receipt: toSliceReceipt(slice.value) };
};
const usage = (h: Harness, receipt: unknown) =>
	h.world.validateUsage(receipt, { access: ACCESS, scope: SCOPE });

const adopt = (key: string, id: string, revision: number) =>
	request(key, {
		kind: "assertion.transition",
		plan: adoptPlan(id, revision),
	});

test("manual input end to end: target -> explicit claim -> Slice -> correction -> old Slice refused", async () => {
	await withHarness(
		async (h) => {
			// World is OFF by default and then refuses every normal change and read.
			expect(h.world.status()).toEqual({
				enabled: false,
				schema: "current",
				usable: false,
			});
			expect(await h.world.apply(entityOp())).toEqual({
				status: "blocked",
				reasonCode: "WORLD_DISABLED",
				stage: "host",
			});
			expect(await read(h)).toEqual({
				status: "blocked",
				reasonCode: "WORLD_DISABLED",
			});
			expect(count(h, "world_operation")).toBe(0);
			await h.world.setEnabled(true);
			expect(h.world.status().usable).toBe(true);

			// 1. Explicit target registration.
			expect((await h.world.apply(entityOp())).status).toBe("applied");

			// 2. A confirmed message, then an explicit structured claim from it.
			await addMessage(h, "m1", "音声サービスは9月から利用できる。");
			const ref1 = currentRef(h, "m1");
			const registered = await h.world.apply(
				registerClaim("c-1", claim("claim-1", [ref1])),
			);
			expect(registered).toMatchObject({
				status: "applied",
				memory: { dependents: 1, registered: 1 },
			});
			expect((await h.world.apply(adopt("ad-1", "claim-1", 1))).status).toBe(
				"applied",
			);
			expect(worldEdges(h)).toHaveLength(1);

			// 3. The Slice is read on the readonly snapshot and carries the claim.
			const first = await sliceOf(h);
			expect(
				first.snapshot.assertions.map((a) => [a.id, a.revision, a.lifecycle]),
			).toEqual([["claim-1", 2, "active"]]);
			// Source states came from the host adapter, not from the caller.
			expect(first.snapshot.sources.map((s) => s.id)).toEqual(["m1"]);
			expect(first.receipt.sourceVersions.map((s) => s.id)).toEqual(["m1"]);
			expect((await usage(h, first.receipt)).status).toBe("valid");

			// 4. The message is corrected. The old receipt cites a stale source.
			await h.conversation.correct({ messageId: "m1", text: "10月から。" });
			expect(await usage(h, first.receipt)).toEqual({
				status: "blocked",
				reasonCode: "SOURCE_CHANGED",
			});
			// A claim that still cites the old revision is refused by World.
			const stale = await h.world.apply(
				registerClaim("c-stale", claim("claim-stale", [ref1])),
			);
			expect(stale).toMatchObject({
				status: "rejected",
				reasonCode: "SOURCE_VERSION_MISMATCH",
				stage: "world",
			});
			// The correction stops the claim at once, by the source it depended on.
			const stopped = await h.world.apply(
				request("inv-1", {
					kind: "invalidate",
					reasonCode: "SOURCE_RETRACTED",
					targets: [],
					sourceKeys: [keyOf("m1")],
				}),
			);
			expect(stopped.status).toBe("applied");
			const afterStop = ready(await read(h)).snapshot;
			expect(
				afterStop.assertions.filter((a) => a.lifecycle === "active"),
			).toHaveLength(0);

			// 5. A new explicit claim on the corrected message; the old Slice stays refused.
			const ref2 = currentRef(h, "m1");
			expect(ref2.revision).not.toBe(ref1.revision);
			await h.world.apply(registerClaim("c-2", claim("claim-2", [ref2], {})));
			await h.world.apply(adopt("ad-2", "claim-2", 1));
			const second = await sliceOf(h);
			expect(
				second.snapshot.assertions
					.filter((a) => a.lifecycle === "active")
					.map((a) => a.id),
			).toEqual(["claim-2"]);
			expect((await usage(h, second.receipt)).status).toBe("valid");
			expect(await usage(h, first.receipt)).toEqual({
				status: "blocked",
				reasonCode: "SCOPE_EPOCH_CHANGED",
			});
			// Memory knows both claims' inputs under separate opaque ids.
			expect(new Set(worldEdges(h).map((e) => e.dependent_id)).size).toBe(2);
		},
		{},
		{ enabled: false },
	);
});

test("injection: a Memory refusal rolls back World, host rows and the Memory write; the next change works", async () => {
	await withHarness(async (h) => {
		await h.world.apply(entityOp());
		await addMessage(h, "m1", "text");
		const op = registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")]));
		const externalId = externalIdOf(
			"a",
			SCOPE.principal,
			SCOPE.scopeKey,
			["claim-1", 1],
			0,
		);
		await h.store.write((db) => {
			const policy = String(
				(
					db
						.query("SELECT revision FROM memory_host_settings WHERE id=1")
						.get() as {
						revision: number;
					}
				).revision,
			);
			registerExternalDependents(db, {
				contractVersion: CONTRACT_VERSIONS.external,
				access: {
					principal: SCOPE.principal,
					scopeKeys: ["x"],
					purpose: "world.test",
					policyRevision: policy,
				},
				scopeKey: "x",
				clock: { atMs: NOW },
				dependents: [
					{
						providerRef: WORLD_PROVIDER_REF,
						externalId,
						dependsOn: [{ type: "source", id: '["a","b","c",null]' }],
					},
				],
			});
		});
		const before = dump(h);
		await expect(
			h.store.write((db) => {
				probe(db);
				return h.world.applyInWriter(db, op);
			}),
		).rejects.toBeInstanceOf(MemoryRegistrationRejected);
		expect(dump(h)).toEqual(before);
		// A different claim is unaffected, and the failed one stays absent.
		expect(
			(
				await h.world.apply(
					registerClaim("c-2", claim("claim-2", [currentRef(h, "m1")])),
				)
			).status,
		).toBe("applied");
		expect(count(h, "world_assertion")).toBe(1);
	});
});

test("injection: a full Writer queue yields typed WRITER_BUSY and writes nothing for the refused ones", async () => {
	await withHarness(async (h) => {
		const ops = Array.from({ length: 70 }, (_, i) =>
			h.world.apply(
				request(`e-${i}`, {
					kind: "entity.register",
					entity: {
						id: `svc-${i}`,
						displayName: `service ${i}`,
						aliases: [],
						externalRefs: [],
					},
				}),
			),
		);
		const results = await Promise.all(ops);
		const busy = results.filter(
			(r) => r.status === "blocked" && r.reasonCode === "WRITER_BUSY",
		);
		const applied = results.filter((r) => r.status === "applied");
		expect(busy.length).toBeGreaterThan(0);
		expect(busy.length + applied.length).toBe(70);
		// Exactly the accepted ones are stored; the refused ones left no trace.
		expect(count(h, "world_entity")).toBe(applied.length);
		expect(count(h, "world_operation")).toBe(applied.length);
	});
});

test("injection: a closing store refuses new changes and reads with typed results", async () => {
	await withHarness(async (h) => {
		await h.world.apply(entityOp());
		const closing = h.store.close();
		expect(await h.world.apply(entityOp("e-2"))).toEqual({
			status: "blocked",
			reasonCode: "STORE_CLOSING",
			stage: "host",
		});
		expect(await read(h)).toEqual({
			status: "blocked",
			reasonCode: "STORE_CLOSING",
		});
		await closing;
	});
});
