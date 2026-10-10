import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations,
	hashRequirementData,
	type RequirementProfileData,
} from "..";
import { requirementProfileData } from "../contracts/requirements";
export const sampleProfile: RequirementProfileData = {
	version: 1,
	title: "確認基準",
	scope: "依頼の条件を確認",
	requirements: [
		{
			id: "value",
			statement: "値を確認する",
			required: true,
			applicability: "常に",
			allowNotApplicable: false,
			valueSchema: { type: "number", minimum: 0 },
		},
	],
	provenance: { kind: "user" },
};
test("profile validity compares instants with mixed fractional-second precision", () => {
	const provenance = {
		kind: "web" as const,
		url: "https://example.org/policy",
		retrievedAt: "2026-10-10T00:00:00Z",
		contentDigest: "0".repeat(64),
		scope: "期間限定の条件",
		validFrom: "2026-10-10T00:00:00Z",
		validUntil: "2026-10-10T00:00:00.001Z",
	};
	expect(
		requirementProfileData.safeParse({ ...sampleProfile, provenance }).success,
	).toBe(true);
	expect(
		requirementProfileData.safeParse({
			...sampleProfile,
			provenance: {
				...provenance,
				validFrom: provenance.validUntil,
				validUntil: provenance.validFrom,
			},
		}).success,
	).toBe(false);
});
test("R02/R03/R06 immutable profile revisions, CAS, independent catalogs and invalidation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "requirements-"));
	const store = openStore(join(dir, "db"), migrations),
		caps = createCapabilities(store);
	await caps.seed();
	try {
		const a = await caps.putRequirementProfile("criteria", null, sampleProfile);
		expect(a.revision).toBe(1);
		expect(
			(
				await caps.putRequirementProfile(a.id, a.stateToken, {
					...sampleProfile,
				})
			).revision,
		).toBe(1);
		const catalog = store.read((db) =>
			caps.requirementCatalogInTransaction(db),
		);
		const snapshots = store.read((db) =>
			caps.resolveRequirementProfilesInTransaction(db, catalog, ["p1"]),
		);
		await caps.putRequirementProfile("unrelated", null, {
			...sampleProfile,
			title: "別の基準",
		});
		store.read((db) =>
			caps.validateRequirementProfilesInTransaction(db, snapshots),
		);
		await expect(
			caps.putRequirementProfile(a.id, null, sampleProfile),
		).rejects.toThrow("requirement_conflict");
		const off = await caps.setRequirementProfileState(
			a.id,
			a.stateToken,
			false,
		);
		expect(off.generation).toBe(1);
		const revised = await caps.putRequirementProfile(a.id, off.stateToken, {
			...sampleProfile,
			title: "改訂",
		});
		expect(revised.enabled).toBe(false);
		expect(revised.revision).toBe(2);
		await caps.setRequirementProfileState(a.id, revised.stateToken, true);
		expect(() =>
			store.read((db) =>
				caps.validateRequirementProfilesInTransaction(db, snapshots),
			),
		).toThrow("requirement_profile_invalidated");
		expect(() =>
			store.read((db) =>
				caps.resolveRequirementProfilesInTransaction(db, catalog, ["p99"]),
			),
		).toThrow();
		expect(
			store.read((db) =>
				db
					.query("SELECT definition_json FROM capability_revisions WHERE id=?")
					.get(a.revisionId),
			),
		).toMatchObject({ definition_json: expect.stringContaining("確認基準") });
		expect(hashRequirementData({ a: 1, b: 2 })).toBe(
			hashRequirementData({ b: 2, a: 1 }),
		);
		expect(caps.list().items.some((i) => i.id === a.id)).toBe(false);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
