import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { createSettings } from "../../domains/settings";
import {
	createCapabilities,
	capabilityBundleV1,
} from "../../domains/capabilities";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { createUsageAdapter } from "./usage-adapter";
const bundle = JSON.parse(
	readFileSync(
		new URL(
			"../../domains/capabilities/bundles/usage-dashboard.bundle.json",
			import.meta.url,
		),
		"utf8",
	),
);
import { harness } from "../toolchain/toolchain.fixture";

test("independent launcher and authenticated read are available without a model call", async () => {
	const h = await harness();
	try {
		const entries = (await (await h.request("/api/toolchain-artifacts")).json())
			.artifacts;
		expect(
			entries.find(
				(e: { artifactId: string }) => e.artifactId === "usage.dashboard",
			),
		).toMatchObject({
			title: "利用状況",
			artifactRevisionId: "artifact:usage.dashboard@1",
		});
		const base =
			"/api/toolchain-artifacts/" +
			encodeURIComponent("artifact:usage.dashboard@1");
		const response = await h.request(base + "/sources/usage");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: {
				kind: "usage-dashboard",
				total: 0,
				summary: { seconds: null, estimate: null, inputTokens: null },
			},
		});
		const invalid = encodeURIComponent(
			JSON.stringify({
				start: "bad",
				end: "bad",
				service: "all",
				model: "",
				connectionId: "",
				pageIndex: 0,
			}),
		);
		expect(
			(await h.request(base + "/sources/usage?params=" + invalid)).status,
		).toBe(400);
		expect((await h.app.request(base + "/sources/usage")).status).toBe(401);
		await h.store.write((db) =>
			db
				.query(
					"INSERT INTO live_voice_sessions(id,request_id,conversation_id,status,muted,test,started_at,connection_id,connection_epoch,model) VALUES('pricing','pricing','main','closed',0,0,?,'fixture',0,'voice-fixture')",
				)
				.run(new Date().toISOString()),
		);
		const registration = await (await h.request(base)).json();
		const event = {
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date().toISOString(),
			eventExpiresAt: new Date(Date.now() + 60000).toISOString(),
			artifactId: "usage-fixture",
			artifactRevisionId: "artifact:usage.dashboard@1",
			scopeRef: registration.scopeRef,
			source: "usage",
			sourceRevision: 0,
			actionId: "save",
			input: {
				expectedRevision: "0",
				model: "voice-fixture",
				amount: "0.03",
				effectiveFrom: "2026-10-01T00:00:00Z",
				source: "Fixture pricing",
			},
		};
		const write = await h.request("/api/toolchain-actions", event);
		expect(write.status).toBe(200);
		expect((await write.json()).status).toBe("accepted");
		expect(
			(await (await h.request("/api/toolchain-actions", event)).json()).status,
		).toBe("accepted");
		const priced = await (await h.request(base + "/sources/usage")).json();
		expect(priced.data.rates).toHaveLength(1);
		const liveDefinition = await (
			await h.request(
				"/api/toolchain-artifacts/" +
					encodeURIComponent("artifact:settings.live@4"),
			)
		).json();
		expect(
			liveDefinition.artifact.actionBindings.find(
				(a: { source: string }) => a.source === "settings-live-navigation",
			).navigateTo.artifacts.usage,
		).toBe("usage.dashboard");
		expect(h.calls).toBe(0);
	} finally {
		await h.close();
	}
});

test("registered artifact reads owner records across pages and stores reviewed rates through its public operation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-usage-api-"));
	const store = openStore(join(dir, "fixture.db"), migrations);
	try {
		const settings = await createSettings(store, {
			dbPath: join(dir, "fixture.db"),
			env: {},
		});
		const caps = createCapabilities(store, new Set(), {
			bundleHost: offlineBundleHost,
		});
		const checked = capabilityBundleV1.parse(bundle);
		expect(checked.artifacts[0]!.launcher).not.toHaveProperty("group");
		await caps.seed();
		const adapter = createUsageAdapter(settings);
		await store.write((db) => {
			// These fixtures are product-owner tables, written only in this application integration test.
			db.query(
				"INSERT INTO live_voice_sessions(id,request_id,conversation_id,status,muted,test,started_at,connection_id,connection_epoch,model,connection_name,observed_seconds,usage_confirmed) VALUES('live','live-request','chat','closed',0,1,'2026-10-30T15:00:00.000Z','connection',0,'voice-fixture','Original',61,1)",
			).run();
			db.query(
				"INSERT INTO inference_requests(id,subject,purpose,status,deadline,snapshot) VALUES('r','probe:fixture','llm','failed',0,'{}')",
			).run();
			for (let i = 0; i < 105; i++)
				db.query(
					"INSERT INTO inference_attempts(id,request_id,source,connection_id,model,status,started,ended,input_tokens,output_tokens,cache_read_tokens,billing_path,connection_kind,usage_model,usage_observed,session_role) VALUES(?,'r','cloud','sdk','selected-fixture','failed',?,?,1000,100,400,'codex','codex-sdk','selected-fixture',1,'subagent')",
				).run(
					"a" + i,
					+new Date("2026-10-31T01:00:00Z"),
					+new Date("2026-10-31T01:01:00Z"),
				);
		});
		const params = { start: "2026-10-31", end: "2026-10-31" };
		const data = store.read(
			(db) =>
				adapter.sourceInTransaction(
					db,
					"query:usage.dashboard@1",
					undefined,
					params,
				)!.data,
		) as {
			kind: string;
			total: number;
			summary: {
				seconds: number;
				inputTokens: number;
				cacheReadTokens: number;
				estimate: string | null;
			};
			rows: unknown[];
		};
		expect(data.kind).toBe("usage-dashboard");
		expect(data.total).toBe(106);
		expect(data.summary).toMatchObject({
			seconds: 61,
			inputTokens: 105000,
			cacheReadTokens: 42000,
			estimate: null,
		});
		expect(data.rows).toHaveLength(25);
		// A historical model is retained even when it is no longer in the current settings.
		const saved = await store.write((db) =>
			adapter.invokeInTransaction(db, {
				requestId: "save",
				issuedAt: "2026-10-31T03:00:00Z",
				origin: { kind: "ui", scope: "main", actionRequestId: "save" },
				operationName: "usage.rate-save",
				input: {
					expectedRevision: "0",
					model: "voice-fixture",
					amount: "0.06",
					effectiveFrom: "2026-10-01T00:00:00Z",
					source: "fixture pricing",
				},
			}),
		);
		expect(saved.replay).toBe(false);
		const repriced = store.read(
			(db) =>
				adapter.sourceInTransaction(
					db,
					"query:usage.dashboard@1",
					undefined,
					params,
				)!.data,
		) as typeof data;
		expect(repriced.summary.estimate).toBe("0.061000000000");
		expect(
			store.read((db) => adapter.readInTransaction(db, "save"))?.replay,
		).toBe(true);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
