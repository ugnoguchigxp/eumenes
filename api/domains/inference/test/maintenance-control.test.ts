import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../../settings";
import type { LarmPort } from "../../larm";
import {
	createInference,
	migration,
	parentsMigration,
	diagnosticsMigration,
	controlMigration,
} from "..";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "hello" },
];
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-maint-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [
		settingsMigration,
		migration,
		settingsEpochsMigration,
		parentsMigration,
		diagnosticsMigration,
		controlMigration,
	]);
	const settings = await createSettings(store, { dbPath, env: {} });
	const s = settings.get();
	const connectionId = crypto.randomUUID();
	const id = crypto.randomUUID();
	s.resources.push({
		id,
		connectionId,
		purpose: "llm",
		model: "fixture-llm",
		contextWindow: 8192,
		voice: null,
	});
	s.routes.llm.fallbackId = id;
	s.connections.push({
		id: connectionId,
		name: "Fixture",
		baseUrl: "http://127.0.0.1:19999/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId, value: "fixture-key" }],
	});
	let opts: unknown;
	const port: LarmPort = {
		decisionModel: () => null,
		status: () => ({ state: "unconfigured", capabilities: [] }),
		connect: async () => {},
		answer: async (_m, _s, options) => {
			opts = options;
			return '{"ok":true}';
		},
		transcribe: async () => {
			throw new Error("larm_control_503");
		},
		speak: async () => {
			throw new Error("larm_control_503");
		},
		close: async () => {},
	};
	const inference = createInference(store, settings, {
		larmFactory: () => port,
		cloudMs: 1000,
	});
	cleanup.push(async () => {
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, settings, inference, opts: () => opts };
}
const cap = (
	h: Awaited<ReturnType<typeof setup>>,
	subject: string,
	ms = 9000,
) =>
	h.store.write((db) =>
		h.inference.captureMaintenanceControlInTransaction(db, {
			subject,
			deadline: Date.now() + ms,
			maxOutputTokens: 99999,
		}),
	);

test("I01 captures after the source answer was accepted, with its own deadline and fixed control limits", async () => {
	const h = await setup();
	const source = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "answer-1", "llm", Date.now() + 1),
	);
	await h.store.write((db) =>
		db
			.query("UPDATE inference_requests SET status='accepted' WHERE id=?")
			.run(source),
	);
	await Bun.sleep(5); // original deadline is now past
	const before = Date.now();
	const id = await cap(h, "research-route:d1:author-1");
	const row = h.store.read((db) =>
		db
			.query(
				"SELECT status,mode,output_limit,context_policy,parents,deadline,snapshot FROM inference_requests WHERE id=?",
			)
			.get(id),
	) as Record<string, unknown>;
	expect(row).toMatchObject({
		status: "pending",
		mode: "control",
		output_limit: 2048,
		context_policy: "exact",
		parents: "[]",
	});
	expect(Number(row.deadline)).toBeGreaterThan(before + 5000);
	const snap = JSON.parse(row.snapshot as string);
	expect(snap.routes.llm.mode).toBe("larm-only");
	expect(snap.routes.llm.cloudAllowed).toBe(false);
	const receipt = await h.inference.executeControl(
		id,
		messages,
		new AbortController().signal,
	);
	expect(receipt.value).toBe('{"ok":true}');
	expect(h.opts()).toMatchObject({
		contextPolicy: "exact",
		maxOutputTokens: 2048,
	});
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(true);
	// idempotent per subject
	expect(await cap(h, "research-route:d1:author-1")).toBe(id);
});

test("I01 rejects expired deadlines, cancelled requests and settings changes before the receipt is adopted", async () => {
	const h = await setup();
	await expect(cap(h, "research-route:d2:author-1", -1)).rejects.toThrow(
		"invalid_maintenance_control",
	);
	const a = await cap(h, "research-route:d2:review-1");
	const receipt = await h.inference.executeControl(
		a,
		messages,
		new AbortController().signal,
	);
	await h.store.write((db) => h.inference.cancelRequestsInTransaction(db, [a]));
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(false);

	const s = h.settings.get();
	s.larm = { ...s.larm, profile: `${s.larm.profile}-changed` };
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: h.settings.get().revision,
		settings: s,
		keys: [],
	});
	const b = await cap(h, "research-route:d3:author-1");
	const snap = h.store.read((db) =>
		h.inference.snapshotFor(db, "research-route:d3:author-1"),
	);
	expect(snap?.larm.profile).toBe(s.larm.profile);
	expect(snap?.routes.llm.cloudAllowed).toBe(false);
	const ok = await h.inference.executeControl(
		b,
		messages,
		new AbortController().signal,
	);
	// a receipt for an already-expired request is refused
	await h.store.write((db) =>
		db
			.query("UPDATE inference_requests SET deadline=? WHERE id=?")
			.run(Date.now() - 1, b),
	);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, ok)),
	).toBe(false);
});

test("I01 normal captureControl still requires a pending parent", async () => {
	const h = await setup();
	const source = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "answer-2", "llm", Date.now() + 10000),
	);
	await h.store.write((db) =>
		db
			.query("UPDATE inference_requests SET status='accepted' WHERE id=?")
			.run(source),
	);
	await expect(
		h.store.write((db) =>
			h.inference.captureControlInTransaction(db, {
				subject: "agent:control:x",
				policySubject: "answer-2",
				deadline: Date.now() + 5000,
				maxOutputTokens: 100,
			}),
		),
	).rejects.toThrow("permission_revoked");
});
