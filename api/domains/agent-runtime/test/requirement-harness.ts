import { harness } from "./route-harness";
import type { RequirementProfileData } from "../../capabilities";
const profile: RequirementProfileData = {
	version: 1,
	title: "数値の確認",
	scope: "値と例外を確認",
	requirements: [
		{
			id: "quantity",
			statement: "数量を正の整数で確認",
			required: true,
			allowNotApplicable: true,
			applicability: "対象が存在するとき",
			valueSchema: { type: "integer", minimum: 1 },
		},
	],
	provenance: { kind: "user" },
};
export const requests = [
	{
		id: "r1",
		statement: "依頼の明示条件",
		requestQuote: "条件",
		valueSchema: { type: "string", maxLength: 100 },
	},
];
export async function requirementHarness() {
	const h = await harness();
	const dto = await h.caps.putRequirementProfile("numbers", null, profile);
	const snapshots = h.store.read((db) =>
		h.caps.resolveRequirementProfilesInTransaction(
			db,
			h.caps.requirementCatalogInTransaction(db),
			["p1"],
		),
	);
	const root = await h.store.write((db) =>
		h.agents.startInTransaction(db, {
			rootRunId: "requirements",
			input: { kind: "web", question: "条件を確認" },
			deadline: Date.now() + 120000,
			requirementProfiles: snapshots,
		}),
	);
	const child = h.agents.list("requirements").find((t) => t.kind === "worker")!;
	return { h, dto, root, child };
}
