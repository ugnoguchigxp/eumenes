import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { workersSettingsFixture } from "./workers-ai-settings.fixture";

test("the published Workers AI settings applies registration, catalog selection and route assignment through the ledger", async () => {
	const h = await workersSettingsFixture();
	try {
		const submit = (input: unknown) =>
			h.ledger.submit({
				version: 1,
				eventId: crypto.randomUUID(),
				eventCreatedAt: new Date().toISOString(),
				eventExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				artifactId: "tab-ai",
				artifactRevisionId: "artifact:settings.ai-connections@7",
				source: "settings-ai",
				sourceRevision: h.settings.get().revision,
				actionId: "apply",
				scopeRef: h.ledger.scopeRef,
				input,
			});
		const connectionId = crypto.randomUUID();
		const registered = await submit({
			expectedRevision: h.settings.get().revision,
			changes: [],
			structural: [
				{
					structure: "structure:settings.add-connection@2",
					input: {
						connectionId,
						kind: "cloudflare-workers-ai",
						name: "Workers音声",
						accountId: "a".repeat(32),
					},
				},
			],
			keys: [{ connectionId, value: "fixture-private-token" }],
		});
		expect(registered.request.status).toBe("accepted");
		expect(JSON.stringify(registered)).not.toContain("fixture-private-token");
		const response = await h.app.request(
			`/api/inference/connections/${connectionId}/models?refresh=1`,
			{
				headers: { authorization: "Bearer fixture-workers-api-browser-token" },
			},
		);
		expect(response.status).toBe(200);
		const listed = (await response.json()) as {
			models: Array<{ id: string; purpose: "asr" | "tts" }>;
		};
		const resources = listed.models.map((m) => ({
			resourceId: crypto.randomUUID(),
			connectionId,
			model: m.id,
			purpose: m.purpose,
		}));
		const saved = await submit({
			expectedRevision: h.settings.get().revision,
			changes: [],
			structural: resources.map((input) => ({
				structure: "structure:settings.add-resource@2",
				input,
			})),
		});
		expect(saved.request.status).toBe("accepted");
		expect(h.settings.get().resources).toHaveLength(2);
		const assigned = await submit({
			expectedRevision: h.settings.get().revision,
			changes: resources.flatMap((r) => [
				{ fieldId: `route.${r.purpose}.fallback`, value: r.resourceId },
				{ fieldId: `route.${r.purpose}.mode`, value: "cloud-only" },
			]),
		});
		expect(assigned.request.status).toBe("accepted");
		for (const r of resources)
			expect(h.settings.get().routes[r.purpose]).toMatchObject({
				mode: "cloud-only",
				fallbackId: r.resourceId,
			});
		expect(h.wire).toHaveLength(4);
	} finally {
		await h.close();
	}
});

test("published settings upgrade preserves the old artifact and repeats without changing revisions", async () => {
	const h = await workersSettingsFixture(true);
	try {
		const old = h.caps.documentInTransaction;
		expect(old).toBeDefined();
		const before = h.store.read((db) =>
			h.caps.documentInTransaction(db, "artifact:settings.ai-connections@6"),
		);
		expect(
			h.ledger
				.artifacts()
				.some(
					(a) => a.artifactRevisionId === "artifact:settings.ai-connections@6",
				),
		).toBe(true);
		const again = await h.store.write((db) =>
			h.caps.importBundleInTransaction(db, h.bundle, h.host()),
		);
		expect(again.issues).toEqual([]);
		const repeated = await h.store.write((db) =>
			h.caps.importBundleInTransaction(db, h.bundle, h.host()),
		);
		expect(repeated.issues).toEqual([]);
		expect(
			h.store.read((db) =>
				h.caps.documentInTransaction(db, "artifact:settings.ai-connections@6"),
			),
		).toEqual(before);
		expect(
			h.ledger
				.artifacts()
				.some(
					(a) => a.artifactRevisionId === "artifact:settings.ai-connections@7",
				),
		).toBe(true);
	} finally {
		await h.close();
	}
});

test("the spatial settings bundle keeps its latest screen and shares the new save contract without a revision collision", async () => {
	const h = await workersSettingsFixture();
	try {
		const bundle = JSON.parse(
			readFileSync(
				new URL(
					"../domains/capabilities/bundles/settings.spatial.bundle.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const imported = await h.store.write((db) =>
			h.caps.importBundleInTransaction(db, bundle, h.host()),
		);
		expect(imported.issues).toEqual([]);
		expect(
			h.ledger.artifacts().find((a) => a.artifactId === "settings.display")
				?.artifactRevisionId,
		).toBe("artifact:settings.display@9");
		const doc = h.store.read((db) =>
			h.caps.documentInTransaction(db, "artifact:settings.display@9"),
		);
		expect(JSON.stringify(doc?.document)).toContain("settings.apply-v4");
	} finally {
		await h.close();
	}
});
