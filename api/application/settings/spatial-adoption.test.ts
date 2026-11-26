import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { workersSettingsFixture } from "./workers-ai-settings.fixture";

test("Display v12 upgrades v9 immutably and reimports idempotently", async () => {
	const h = await workersSettingsFixture();
	try {
		const bundle = JSON.parse(
			readFileSync(
				new URL(
					"../../domains/capabilities/bundles/settings.spatial.bundle.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const legacy = {
			...bundle,
			artifacts: bundle.artifacts.filter(
				(a: { revision: number }) => a.revision <= 9,
			),
		};
		await h.store.write((db) =>
			h.caps.importBundleInTransaction(db, legacy, h.host()),
		);
		const before = h.store.read((db) =>
			h.caps.documentInTransaction(db, "artifact:settings.display@9"),
		);
		for (let i = 0; i < 2; i++) {
			const result = await h.store.write((db) =>
				h.caps.importBundleInTransaction(db, bundle, h.host()),
			);
			expect(result.issues).toEqual([]);
		}
		expect(
			h.store.read((db) =>
				h.caps.documentInTransaction(db, "artifact:settings.display@9"),
			),
		).toEqual(before);
		const active = h.store
			.read((db) => h.caps.artifactsInTransaction(db))
			.find((a) => a.artifactId === "settings.display");
		expect(active?.artifactRevisionId).toBe("artifact:settings.display@12");
		const latest = bundle.artifacts.at(-1);
		expect(
			latest.fields
				.find((f: { fieldId: string }) => f.fieldId === "appearance.background")
				.options.map((o: { value: string }) => o.value),
		).toEqual(["light-fairy", "spatial", "live2d-hiyori"]);
		expect(
			latest.fields.find(
				(f: { fieldId: string }) =>
					f.fieldId === "appearance.avatar-background-color",
			),
		).toMatchObject({
			path: "$.general.avatarBackgroundColor",
			control: "color",
			unset: "delete-key",
			visibleWhen: "condition:settings.background-live2d@1",
		});
		const scatter = latest.fields.find(
			(f: { fieldId: string }) => f.fieldId === "spatial.scatter",
		);
		expect(scatter.max).toBe(500);
		expect(scatter.defaultValue).toBe("350");
		expect(
			latest.fields.some(
				(f: { fieldId: string }) => f.fieldId === "spatial.spin-speed",
			),
		).toBe(false);
	} finally {
		await h.close();
	}
});

test("Display saves different Live2D colours through the published settings action and resets to the default", async () => {
	const h = await workersSettingsFixture();
	try {
		const bundle = JSON.parse(
			readFileSync(
				new URL(
					"../../domains/capabilities/bundles/settings.spatial.bundle.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const imported = await h.store.write((db) =>
			h.caps.importBundleInTransaction(db, bundle, h.host()),
		);
		expect(imported.issues).toEqual([]);

		const headers = {
			authorization: "Bearer fixture-workers-api-browser-token",
			"content-type": "application/json",
		};
		const list = await h.app.request("/api/toolchain-artifacts", { headers });
		const active = (
			(await list.json()) as {
				artifacts: { artifactId: string; artifactRevisionId: string }[];
			}
		).artifacts.find(({ artifactId }) => artifactId === "settings.display");
		expect(active).toBeDefined();
		const artifactRevisionId = active!.artifactRevisionId;
		const ref = encodeURIComponent(artifactRevisionId);
		const artifact = await h.app.request("/api/toolchain-artifacts/" + ref, {
			headers,
		});
		const { scopeRef } = (await artifact.json()) as { scopeRef: string };
		const source = "settings-display";
		const get = async () => {
			const response = await h.app.request("/api/settings", { headers });
			expect(response.status).toBe(200);
			return (await response.json()) as ReturnType<typeof h.settings.get>;
		};
		async function save(changes: object[]) {
			const { revision } = await get();
			const now = Date.now();
			const response = await h.app.request("/api/toolchain-actions", {
				method: "POST",
				headers,
				body: JSON.stringify({
					version: 1,
					eventId: crypto.randomUUID(),
					eventCreatedAt: new Date(now).toISOString(),
					eventExpiresAt: new Date(now + 60_000).toISOString(),
					artifactId: "tab-display",
					artifactRevisionId,
					scopeRef,
					source,
					sourceRevision: revision,
					actionId: "apply",
					input: { expectedRevision: revision, changes },
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ status: "accepted" });
			return (await get()).general;
		}
		const fieldId = "appearance.avatar-background-color";
		expect(
			await save([
				{ fieldId: "appearance.background", value: "live2d-hiyori" },
				{ fieldId, value: "#e46a90" },
			]),
		).toMatchObject({
			background: "live2d-hiyori",
			avatarBackgroundColor: "#e46a90",
		});
		expect(
			(await save([{ fieldId, value: "#36a8c7" }])).avatarBackgroundColor,
		).toBe("#36a8c7");
		expect(await save([{ fieldId, unset: true }])).not.toHaveProperty(
			"avatarBackgroundColor",
		);
	} finally {
		await h.close();
	}
});
