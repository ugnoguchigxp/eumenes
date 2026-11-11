import { afterEach, expect, test } from "bun:test";
import { cleanup, setup } from "./inference.fixture";
import { codexUsageInTransaction } from "../service/accounting";
import { createUsageReader } from "../service/usage";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("a Codex SDK turn run outside any request is a finished, accepted attempt with its tokens in the usage views", async () => {
	const h = await setup();
	await h.inference.recordExternalCodexAttempt!({
		subject: "web-note:one",
		model: "fixture-codex-model",
		started: 1_000,
		ended: 31_000,
		status: "succeeded",
		reason: null,
		usage: { input: 25_000, cachedInput: 20_000, output: 900, reasoning: 300 },
	});
	await h.inference.recordExternalCodexAttempt!({
		subject: "web-note:two",
		model: "fixture-codex-model",
		started: 2_000,
		ended: 3_000,
		status: "failed",
		reason: "web_note_codex_exit",
		usage: null,
	});
	const rows = h.store.read((db) => codexUsageInTransaction(db, 0, 100_000));
	expect(rows).toHaveLength(2);
	const ok = rows.find((r) => r.started === 1_000)!;
	expect(ok).toMatchObject({
		status: "succeeded",
		model: "fixture-codex-model",
		requestedModel: "fixture-codex-model",
		role: "auxiliary",
		inputTokens: 25_000,
		outputTokens: 900,
		cacheReadTokens: 20_000,
		reasoningTokens: 300,
		billingPath: "codex",
		observed: 1,
		connectionName: "Codex SDK",
	});
	expect(rows.find((r) => r.started === 2_000)).toMatchObject({
		status: "failed",
		inputTokens: null,
		billingPath: "codex",
		observed: 0,
	});
	// The general usage list shows both, with the request they belong to.
	const listed = createUsageReader(h.store).usage();
	expect(
		listed.map((u) => [u.subject, u.status, u.billingPath]).sort(),
	).toEqual([
		["web-note:one", "succeeded", "codex"],
		["web-note:two", "failed", "codex"],
	]);
	const kinds = h.store.read((db) =>
		db
			.query(
				"SELECT connection_kind AS kind, accepted FROM inference_attempts ORDER BY started",
			)
			.all(),
	);
	expect(kinds).toEqual([
		{ kind: "codex-sdk", accepted: 1 },
		{ kind: "codex-sdk", accepted: 0 },
	]);
});
