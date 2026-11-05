import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "../repository";
import { migrations as settingsMigrations } from "../../settings";
import { createUsageReader } from "../service/usage";
import { seedUsageFixture } from "./usage.fixture";

test("receipt usage matches both identities outside latest-N and preserves missing usage", async () => {
	const dir = mkdtempSync(join(tmpdir(), "receipt-usage-")),
		store = openStore(join(dir, "db"), [...settingsMigrations, ...migrations]);
	try {
		await seedUsageFixture(store);
		const reader = createUsageReader(store),
			receipt = { requestId: "usage-000", attemptId: "usage-000", value: "" };
		expect(reader.usage().some((u) => u.id === receipt.attemptId)).toBe(false);
		expect(
			store.read((db) => reader.usageOfInTransaction(db, receipt)),
		).toMatchObject({
			model: "fixture-model-000",
			inputTokens: 120,
			outputTokens: 48,
		});
		expect(
			store.read((db) =>
				reader.usageOfInTransaction(db, { ...receipt, requestId: "usage-001" }),
			),
		).toBeNull();
		await store.write((db) =>
			db
				.query(
					"UPDATE inference_attempts SET input_tokens=NULL,output_tokens=NULL WHERE id=?",
				)
				.run(receipt.attemptId),
		);
		expect(
			store.read((db) => reader.usageOfInTransaction(db, receipt)),
		).toMatchObject({
			inputTokens: null,
			outputTokens: null,
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
