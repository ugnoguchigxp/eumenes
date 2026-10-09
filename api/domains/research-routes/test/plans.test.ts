import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	type RequestBinding,
	type SearchSpec,
	canonicalJson,
	createResearchRoutes,
	ledger,
	migration,
	sha256,
	ttl,
} from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-plans-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), [migration]);
	stores.push(store);
	let t = 1_000_000;
	let n = 0;
	const clock = { now: () => t, id: () => `inc-${++n}` };
	return {
		store,
		routes: createResearchRoutes({ clock }),
		advance: (ms: number) => (t += ms),
		clock,
	};
}
const spec = (name = "鎌倉市"): SearchSpec => ({
	keyVersion: 1,
	scope: "local:owner",
	language: "ja",
	region: "JP",
	timeZone: "Asia/Tokyo",
	keywords: `天気予報 ${name}`,
	purpose: "weather",
	target: { name, prefecture: "神奈川県", granularity: "city" },
	requiredFields: ["condition"],
	timeMode: "today",
});
const keyOf = (s: SearchSpec) => sha256(canonicalJson(s));
const bindingOf = (s: SearchSpec, policy = 1): RequestBinding => ({
	specDigest: keyOf(s),
	requestAtMs: 1,
	expectedDate: "2026-10-09",
	validationPolicyVersion: policy,
});
const hits = [{ url: "https://w.test/a", title: "t", snippet: "s" }];
const prov = (at: number) => ({
	runId: "r",
	stepId: "s",
	query: "天気予報 鎌倉市",
	searchedAt: at,
	provider: "p",
	digest: "a".repeat(64),
	origin: "lookup" as const,
});
function install(
	db: any,
	s: SearchSpec,
	versionId: string,
	incarnation: string,
	revalidateAt: number,
	now: number,
) {
	const k = keyOf(s);
	ledger.insertRevision(db, {
		version_id: versionId,
		epoch: 0,
		key: k,
		incarnation,
		revision: ledger.nextRevisionNumber(db, incarnation),
		recipe_json: JSON.stringify({
			toolId: "web.read",
			arguments: { url: "https://w.test/a" },
			sourceUrl: "https://w.test/a",
			specDigest: k,
			validationProfile: "weather-json-v1",
			singleSource: true,
		}),
		context_projection: "c",
		skill_revision_id: "s",
		package_revision_id: "p",
		proof_digest: "d",
		review_digest: "r",
		registration_certificate_json: "{}",
		validation_policy_version: 1,
		created_at: now,
		revalidate_at: revalidateAt,
	});
	const row = ledger.getKey(db, 0, k)!;
	expect(
		ledger.activateVersionCas(db, {
			epoch: 0,
			key: k,
			incarnation,
			generation: row.generation,
			expectedVersionId: row.active_version_id,
			versionId,
			now,
			idleExpiresAt: now + ttl.idleMs,
		}),
	).toBe(true);
}

test("D02 new key -> lookup, candidate, direct; other places never reuse it", async () => {
	const { store, routes, clock } = setup();
	const s = spec();
	await store.write((db) => {
		const first = routes.lookupInTransaction(db, s, bindingOf(s));
		expect(first).toMatchObject({ kind: "lookup", reason: "new_key" });
		if (first.kind !== "lookup" || !first.fence) throw new Error("fence");
		expect(
			routes.storeCandidatesInTransaction(db, {
				fence: first.fence,
				provenance: prov(clock.now()),
				hits,
				providerVersion: "1",
			}).kind,
		).toBe("stored");
		expect(routes.lookupInTransaction(db, s, bindingOf(s)).kind).toBe(
			"candidate",
		);
		const other = spec("静岡市");
		expect(
			routes.lookupInTransaction(db, other, bindingOf(other)),
		).toMatchObject({ kind: "lookup", reason: "new_key" });
	});
});

test("D02 candidate needs fresh lookup provenance, current fence and 24h TTL", async () => {
	const { store, routes, advance, clock } = setup();
	const s = spec();
	await store.write((db) => {
		const l = routes.lookupInTransaction(db, s, bindingOf(s));
		if (l.kind !== "lookup" || !l.fence) throw new Error("fence");
		expect(
			routes.storeCandidatesInTransaction(db, {
				fence: l.fence,
				provenance: { ...prov(clock.now()), origin: "candidate-cache" },
				hits,
				providerVersion: "1",
			}),
		).toEqual({ kind: "skipped", code: "not_fresh_lookup" });
		expect(
			routes.storeCandidatesInTransaction(db, {
				fence: { ...l.fence, generation: 9 },
				provenance: prov(clock.now()),
				hits,
				providerVersion: "1",
			}),
		).toEqual({ kind: "skipped", code: "stale_fence" });
		expect(
			routes.storeCandidatesInTransaction(db, {
				fence: l.fence,
				provenance: prov(clock.now()),
				hits: [],
				providerVersion: "1",
			}),
		).toEqual({ kind: "skipped", code: "no_hits" });
		routes.storeCandidatesInTransaction(db, {
			fence: l.fence,
			provenance: prov(clock.now()),
			hits,
			providerVersion: "1",
		});
		advance(ttl.candidateMs + 1);
		expect(routes.lookupInTransaction(db, s, bindingOf(s))).toMatchObject({
			kind: "lookup",
			reason: "no_candidate",
		});
	});
});

test("D02 direct, expired and policy mismatch; candidates never override expiry or failure", async () => {
	const { store, routes, advance, clock } = setup();
	const s = spec();
	await store.write((db) => {
		const l = routes.lookupInTransaction(db, s, bindingOf(s));
		if (l.kind !== "lookup" || !l.fence) throw new Error("fence");
		routes.storeCandidatesInTransaction(db, {
			fence: l.fence,
			provenance: prov(clock.now()),
			hits,
			providerVersion: "1",
		});
		install(db, s, "v1", l.fence.incarnation, clock.now() + 1000, clock.now());
		const d = routes.lookupInTransaction(db, s, bindingOf(s));
		expect(d).toMatchObject({ kind: "direct", versionId: "v1" });
		expect(routes.lookupInTransaction(db, s, bindingOf(s, 2))).toEqual({
			kind: "unavailable",
			code: "policy_unavailable",
		});
		advance(1001);
		expect(routes.lookupInTransaction(db, s, bindingOf(s))).toMatchObject({
			kind: "lookup",
			reason: "expired",
		});
		expect(routes.getRouteInTransaction(db, keyOf(s))?.state).toBe("expired");
	});
});

test("D02 failure disqualifies without bumping generation; warm use keeps tokens; no auto restore", async () => {
	const { store, routes, advance, clock } = setup();
	const s = spec();
	await store.write((db) => {
		const l = routes.lookupInTransaction(db, s, bindingOf(s));
		if (l.kind !== "lookup" || !l.fence) throw new Error("fence");
		install(db, s, "v1", l.fence.incarnation, clock.now() + 1e9, clock.now());
		const before = routes.getRouteInTransaction(db, keyOf(s))!;
		expect(before.state).toBe("active");
		advance(500);
		expect(
			routes.recordRouteUseInTransaction(db, {
				versionId: "v1",
				fence: l.fence,
				usedAt: clock.now(),
			}).kind,
		).toBe("updated");
		const warm = routes.getRouteInTransaction(db, keyOf(s))!;
		expect(warm.stateToken).toBe(before.stateToken);
		expect(warm.row.generation).toBe(before.row.generation);
		expect(warm.row.last_success_at).toBe(clock.now());
		expect(
			routes.recordRouteUseInTransaction(db, {
				versionId: "vX",
				fence: l.fence,
				usedAt: 1,
			}).kind,
		).toBe("stale");
		expect(
			routes.markVersionDisqualifiedInTransaction(db, {
				versionId: "v1",
				fence: l.fence,
				reason: "http_404",
			}).kind,
		).toBe("updated");
		expect(routes.getRouteInTransaction(db, keyOf(s))?.state).toBe("suspended");
		expect(routes.lookupInTransaction(db, s, bindingOf(s))).toMatchObject({
			kind: "lookup",
			reason: "source_failure",
		});
		advance(ttl.retryAfterMs + 1);
		expect(routes.getRouteInTransaction(db, keyOf(s))?.state).toBe("suspended");
		expect(
			routes.recordRouteUseInTransaction(db, {
				versionId: "v1",
				fence: l.fence,
				usedAt: clock.now(),
			}).kind,
		).toBe("stale");
	});
});

test("D02 disable keeps the key (no idle GC data loss), stops candidates; rediscover re-opens lookup", async () => {
	const { store, routes, clock } = setup();
	const s = spec();
	await store.write((db) => {
		const l = routes.lookupInTransaction(db, s, bindingOf(s));
		if (l.kind !== "lookup" || !l.fence) throw new Error("fence");
		routes.storeCandidatesInTransaction(db, {
			fence: l.fence,
			provenance: prov(clock.now()),
			hits,
			providerVersion: "1",
		});
		install(db, s, "v1", l.fence.incarnation, clock.now() + 1e9, clock.now());
		const t0 = routes.getRouteInTransaction(db, keyOf(s))!.stateToken;
		expect(
			routes.disableInTransaction(db, {
				key: keyOf(s),
				expectedStateToken: "0".repeat(64),
			}),
		).toEqual({ kind: "conflict" });
		const dis = routes.disableInTransaction(db, {
			key: keyOf(s),
			expectedStateToken: t0,
		});
		expect(dis).toMatchObject({ kind: "updated", state: "disabled" });
		expect(routes.lookupInTransaction(db, s, bindingOf(s))).toEqual({
			kind: "disabled",
		});
		expect(
			routes.storeCandidatesInTransaction(db, {
				fence: l.fence,
				provenance: prov(1),
				hits,
				providerVersion: "1",
			}).kind,
		).toBe("skipped");
		if (dis.kind !== "updated") throw new Error("x");
		expect(
			routes.disableInTransaction(db, {
				key: keyOf(s),
				expectedStateToken: t0,
			}),
		).toEqual({ kind: "conflict" }); // old token
		const re = routes.rediscoverInTransaction(db, {
			key: keyOf(s),
			expectedStateToken: dis.stateToken,
		});
		expect(re).toMatchObject({ kind: "updated", state: "unregistered" });
		expect(routes.lookupInTransaction(db, s, bindingOf(s))).toMatchObject({
			kind: "lookup",
			reason: "rediscover",
		});
		expect(
			routes.disableInTransaction(db, {
				key: "f".repeat(64),
				expectedStateToken: t0,
			}),
		).toEqual({ kind: "not_found" });
	});
});

test("D02 drafts decide preparing; terminal draft ends it; healthy active stays active while editing", async () => {
	const { store, routes, clock } = setup();
	const s = spec();
	await store.write((db) => {
		const l = routes.lookupInTransaction(db, s, bindingOf(s));
		if (l.kind !== "lookup" || !l.fence) throw new Error("fence");
		const inc = l.fence.incarnation;
		const mk = (id: string) => ({
			id,
			key: keyOf(s),
			epoch: 0,
			incarnation: inc,
			base_generation: 0,
			base_version_id: null,
			origin: "adoption" as const,
			proof_id: "p1",
			base_certificate_digest: null,
			instruction: null,
			skill_draft: null,
			review_json: null,
			corrections: 0,
			state: "queued",
			error_code: null,
			created_at: 1,
			updated_at: 1,
			expires_at: 9,
		});
		ledger.insertProof(db, {
			id: "p1",
			root_run_id: "r",
			task_id: "t",
			ticket_id: null,
			report_epoch: null,
			epoch: 0,
			incarnation: inc,
			key: keyOf(s),
			generation: 0,
			source_url: "u",
			binding_json: "{}",
			projection_digest: "p",
			lookup_provenance_json: "{}",
			validation_policy_version: 1,
			facts_json: "{}",
			fetched_at: 1,
			validated_at: 1,
			adopted_at: null,
			status: "observed",
			digest: "d",
			expires_at: 5,
		});
		ledger.insertDraft(db, mk("d1"));
		expect(routes.getRouteInTransaction(db, keyOf(s))?.state).toBe("preparing");
		// candidate remains usable while preparing
		routes.storeCandidatesInTransaction(db, {
			fence: l.fence,
			provenance: prov(clock.now()),
			hits,
			providerVersion: "1",
		});
		expect(routes.lookupInTransaction(db, s, bindingOf(s)).kind).toBe(
			"candidate",
		);
		ledger.setDraftState(db, "d1", ["queued"], "interrupted", "restart", 2);
		expect(routes.getRouteInTransaction(db, keyOf(s))?.state).toBe(
			"unregistered",
		);
		install(db, s, "v1", inc, clock.now() + 1e9, clock.now());
		ledger.insertDraft(db, { ...mk("d2"), base_version_id: "v1" });
		expect(routes.getRouteInTransaction(db, keyOf(s))?.state).toBe("active");
		expect(routes.lookupInTransaction(db, s, bindingOf(s)).kind).toBe("direct");
	});
});

test("D02 capacity: full ledger gives fence=null lookup and creates no key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-plans-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), [migration]);
	stores.push(store);
	const routes = createResearchRoutes({
		clock: { now: () => 5, id: () => crypto.randomUUID() },
		externalBytes: () => 10 ** 12,
	});
	const s = spec();
	await store.write((db) => {
		expect(routes.lookupInTransaction(db, s, bindingOf(s))).toEqual({
			kind: "lookup",
			reason: "capacity",
			fence: null,
		});
		expect(ledger.countKeys(db, 0)).toBe(0);
	});
});

test("D02 binding for a different spec is unavailable", async () => {
	const { store, routes } = setup();
	await store.write((db) => {
		expect(
			routes.lookupInTransaction(db, spec(), bindingOf(spec("静岡市"))),
		).toEqual({ kind: "unavailable", code: "binding_mismatch" });
	});
});
