/**
 * real-local-provider: the P3-09 operation sequence against a REAL Local
 * Provider (register -> ask -> correct -> re-ask -> forget during generation
 * -> restart -> ask).
 *
 * STATUS: NOT EXECUTED, NOT IMPLEMENTED. This file is a marker, not a result.
 * No Local Provider was connected for P3-09, so no real-model acceptance
 * exists; it is carried to P4-05. The deterministic run on the fixture
 * provider is `world-acceptance-p3.test.ts`.
 *
 * It is skipped unless EUMENES_WORLD_REAL_PROVIDER=1 and then FAILS on purpose
 * until someone writes the real run, so it can never pass as a stub. Bun
 * reports it under "skip", which is the honest "not executed".
 */
import { test } from "bun:test";

const requested = process.env["EUMENES_WORLD_REAL_PROVIDER"] === "1";

test.skipIf(!requested)(
	"real-local-provider: one Scope end to end on a real Local Provider (NOT EXECUTED)",
	() => {
		throw new Error(
			"real-local-provider acceptance is not implemented: no Local Provider run has been performed (carried to P4-05)",
		);
	},
);
