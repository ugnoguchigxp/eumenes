import { expect, test } from "bun:test";
import { createWorldQuery } from "..";
import {
	NOW,
	PURPOSE,
	SCOPE,
	withHarness,
	claim,
	registerClaim,
} from "./fixture";
import { messageRef } from "./query-fixture";

test("snapshot preserves condition evaluation with valid time and an explicit evaluation instant", async () => {
	await withHarness(async (h) => {
		const ref = await messageRef(h);
		const validTime = {
			kind: "period",
			precision: "exact",
			original: "施行前",
			start: { earliest: NOW + 10000, latest: NOW + 10000 },
		};
		const applied = await h.world.apply(
			registerClaim(
				"future",
				claim("future", [ref], {
					validTime,
					condition: {
						kind: "explicitly_unconditional",
						adoptionEvidenceId: "ev-future-0",
					},
				}),
			),
		);
		expect(applied.status).toBe("applied");
		const result = await createWorldQuery({
			store: h.store,
			world: h.world,
			purpose: PURPOSE,
			now: () => NOW,
		}).query(
			{ principal: SCOPE.principal, scopeKeys: [SCOPE.scopeKey] },
			{ mode: "snapshot" },
		);
		if (result.status !== "ok" || result.result.mode !== "snapshot")
			throw new Error(JSON.stringify(result));
		expect(result.result.entries[0]).toMatchObject({
			validTime,
			evaluatedAt: NOW,
			conditionEvaluation: { result: "violated", reasons: ["CLAIM_NOT_VALID"] },
		});
	});
});
