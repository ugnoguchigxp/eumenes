import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, learnedMigration, migration } from "..";
import { learnedPair } from "./learned.test";

const owner = { rootRunId: "root", taskId: "task", cancelEpoch: 0 };
const input = { question: "鎌倉の天気" };
const pk = (n: number) =>
	`package:learned.web.${n.toString(16).padStart(32, "0")}@1`;

test("C02 prepare by ID keeps shared checks; independent registration does not disturb A; GC spares builtins/protected", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-prep-"));
	const store = openStore(join(dir, "db"), [migration, learnedMigration]);
	const caps = createCapabilities(store);
	await caps.seed();
	try {
		await store.write((db) => {
			for (const n of [1])
				for (const d of learnedPair(n))
					caps.registerLearnedInTransaction(db, d);
		});
		let prepared!: ReturnType<typeof caps.prepareActiveByIdInTransaction>;
		await store.write((db) => {
			prepared = caps.prepareActiveByIdInTransaction(db, owner, pk(1), input);
			expect(prepared.package.id).toContain("learned.web.");
			expect(prepared.dependencies.map((d) => d.revisionId)).toContain(
				"skill:web.research@2",
			);
			expect(() =>
				caps.prepareActiveByIdInTransaction(db, owner, pk(1), { bad: 1 }),
			).toThrow("invalid_capability_input");
			expect(() =>
				caps.prepareActiveByIdInTransaction(db, owner, pk(1), input, {
					hash: "0".repeat(64),
				}),
			).toThrow("capability_revoked");
			expect(() =>
				caps.prepareActiveByIdInTransaction(db, owner, pk(9), input),
			).toThrow("capability_unavailable");
			expect(() =>
				caps.prepareActiveByIdInTransaction(
					db,
					{ ...owner, taskId: "" },
					pk(1),
					input,
				),
			).toThrow();
			// builtin cold package is preparable by ID too
			expect(
				caps.prepareActiveByIdInTransaction(
					db,
					owner,
					"package:web.research@3",
					input,
				).package.revision,
			).toBe(3);
			expect(() =>
				caps.prepareActiveByIdInTransaction(
					db,
					owner,
					"package:web.research@2",
					input,
				),
			).toThrow("capability_unavailable");
		});
		await store.write((db) => {
			for (const d of learnedPair(2)) caps.registerLearnedInTransaction(db, d);
			caps.validateInTransaction(db, prepared); // A remains valid
		});
		await store.write((db) => {
			const sk = caps.getDefinitionInTransaction(
				db,
				`skill:learned.web.${"1".padStart(32, "0")}@1`,
			);
			expect(sk?.kind).toBe("skill");
			expect(sk?.body).toContain("鎌倉");
			expect(caps.getDefinitionInTransaction(db, pk(1))?.body).toBeNull();
			expect(caps.getDefinitionInTransaction(db, "skill:nope@1")).toBeNull();
		});
		// stop / resume invalidates the earlier preparation
		await store.write((db) => {
			caps.setEnabledInTransaction(db, "skill", "web.research", false);
			expect(() =>
				caps.prepareActiveByIdInTransaction(db, owner, pk(1), input),
			).toThrow();
			caps.setEnabledInTransaction(db, "skill", "web.research", true);
			expect(() => caps.validateInTransaction(db, prepared)).toThrow(
				"capability_revoked",
			);
			caps.prepareActiveByIdInTransaction(db, owner, pk(1), input);
		});
		// GC: protected closure and builtins survive
		await store.write((db) => {
			const r = caps.pruneLearnedInTransaction(db, {
				remove: [pk(1), pk(2), "package:web.research@3"],
				protect: [pk(1)],
			});
			expect(r.removed).toBe(2); // package 2 + its skill
			caps.prepareActiveByIdInTransaction(db, owner, pk(1), input);
			expect(() =>
				caps.prepareActiveByIdInTransaction(db, owner, pk(2), input),
			).toThrow("capability_unavailable");
			caps.prepareActiveByIdInTransaction(
				db,
				owner,
				"package:web.research@3",
				input,
			);
			expect(
				caps.pruneLearnedInTransaction(db, { remove: [pk(1)], protect: [] })
					.removed,
			).toBe(2);
			expect(caps.learnedUsageInTransaction(db)).toEqual({
				count: 0,
				bytes: 0,
			});
			caps.prepareActiveByIdInTransaction(
				db,
				owner,
				"package:web.research@3",
				input,
			);
		});
	} finally {
		caps.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
