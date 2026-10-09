import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { ledger, migration } from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
function open() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-routes-"));
	dirs.push(dir);
	const s = openStore(join(dir, "db"), [migration]);
	stores.push(s);
	return s;
}
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const K = "a".repeat(64);
const rev = (id: string, inc: string, n: number, epoch = 0) => ({
	version_id: id,
	epoch,
	key: K,
	incarnation: inc,
	revision: n,
	recipe_json: "{}",
	context_projection: "c",
	skill_revision_id: "s",
	package_revision_id: "p",
	proof_digest: "d",
	review_digest: "r",
	registration_certificate_json: "{}",
	validation_policy_version: 1,
	created_at: 1,
	revalidate_at: 10,
});
const proof = (id: string, inc: string) => ({
	id,
	root_run_id: "r",
	task_id: "t",
	ticket_id: null,
	report_epoch: null,
	epoch: 0,
	incarnation: inc,
	key: K,
	generation: 0,
	source_url: "https://x.test/",
	binding_json: "{}",
	projection_digest: "p",
	lookup_provenance_json: "{}",
	validation_policy_version: 1,
	facts_json: "{}",
	fetched_at: 1,
	validated_at: 1,
	adopted_at: null,
	status: "observed" as const,
	digest: "d",
	expires_at: 5,
});
const draft = (
	id: string,
	inc: string,
	over: Record<string, unknown> = {},
) => ({
	id,
	key: K,
	epoch: 0,
	incarnation: inc,
	base_generation: 0,
	base_version_id: null,
	origin: "adoption" as const,
	proof_id: null as string | null,
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
	...over,
});

test("D01 same key in different epochs coexists; incarnation is unique", async () => {
	const s = open();
	await s.write((db) => {
		ledger.insertKey(db, {
			epoch: 0,
			key: K,
			incarnation: "i0",
			specJson: "{}",
			keywords: "k",
			now: 1,
		});
		ledger.insertKey(db, {
			epoch: 1,
			key: K,
			incarnation: "i1",
			specJson: "{}",
			keywords: "k",
			now: 1,
		});
		expect(() =>
			ledger.insertKey(db, {
				epoch: 0,
				key: K,
				incarnation: "i2",
				specJson: "{}",
				keywords: "k",
				now: 1,
			}),
		).toThrow();
		expect(() =>
			ledger.insertKey(db, {
				epoch: 2,
				key: K,
				incarnation: "i1",
				specJson: "{}",
				keywords: "k",
				now: 1,
			}),
		).toThrow();
		expect(ledger.getKey(db, 1, K)?.incarnation).toBe("i1");
	});
});

test("D01 revision numbers are unique per incarnation only; FKs reject orphans", async () => {
	const s = open();
	await s.write((db) => {
		ledger.insertKey(db, {
			epoch: 0,
			key: K,
			incarnation: "i0",
			specJson: "{}",
			keywords: "k",
			now: 1,
		});
		ledger.insertKey(db, {
			epoch: 1,
			key: K,
			incarnation: "i1",
			specJson: "{}",
			keywords: "k",
			now: 1,
		});
		ledger.insertRevision(db, rev("v1", "i0", 1));
		expect(() => ledger.insertRevision(db, rev("v2", "i0", 1))).toThrow();
		ledger.insertRevision(db, rev("v3", "i1", 1, 1));
		expect(() => ledger.insertRevision(db, rev("v4", "nope", 1))).toThrow();
		expect(() => ledger.putHealth(db, "missing", 1, "x")).toThrow();
		expect(ledger.nextRevisionNumber(db, "i0")).toBe(2);
	});
});

test("D01 drafts: origin decides proof requirement; one open draft per incarnation", async () => {
	const s = open();
	await s.write((db) => {
		ledger.insertKey(db, {
			epoch: 0,
			key: K,
			incarnation: "i0",
			specJson: "{}",
			keywords: "k",
			now: 1,
		});
		ledger.insertRevision(db, rev("v1", "i0", 1));
		expect(() => ledger.insertDraft(db, draft("d0", "i0"))).toThrow(); // adoption without proof
		expect(() =>
			ledger.insertDraft(db, draft("d1", "i0", { proof_id: "missing" })),
		).toThrow(); // proof FK
		ledger.insertProof(db, proof("p1", "i0"));
		ledger.insertDraft(db, draft("d2", "i0", { proof_id: "p1" }));
		expect(() =>
			ledger.insertDraft(db, draft("d3", "i0", { proof_id: "p1" })),
		).toThrow(); // second open draft
		expect(ledger.setDraftState(db, "d2", ["queued"], "rejected", "x", 2)).toBe(
			true,
		);
		// edit origin needs base version and certificate digest, no proof
		expect(() =>
			ledger.insertDraft(db, draft("e0", "i0", { origin: "edit" })),
		).toThrow();
		expect(() =>
			ledger.insertDraft(
				db,
				draft("e1", "i0", {
					origin: "edit",
					proof_id: "p1",
					base_version_id: "v1",
					base_certificate_digest: "c",
				}),
			),
		).toThrow();
		ledger.insertDraft(
			db,
			draft("e2", "i0", {
				origin: "edit",
				base_version_id: "v1",
				base_certificate_digest: "c",
			}),
		);
		expect(ledger.openDraftOf(db, "i0")?.id).toBe("e2");
	});
});

test("D01 activateVersionCas verifies incarnation and expected previous version", async () => {
	const s = open();
	await s.write((db) => {
		ledger.insertKey(db, {
			epoch: 0,
			key: K,
			incarnation: "i0",
			specJson: "{}",
			keywords: "k",
			now: 1,
		});
		ledger.insertKey(db, {
			epoch: 1,
			key: K,
			incarnation: "i1",
			specJson: "{}",
			keywords: "k",
			now: 1,
		});
		ledger.insertRevision(db, rev("v1", "i0", 1));
		ledger.insertRevision(db, rev("v9", "i1", 1, 1));
		const a = {
			epoch: 0,
			key: K,
			incarnation: "i0",
			generation: 0,
			expectedVersionId: null,
			versionId: "v1",
			now: 5,
			idleExpiresAt: 50,
		};
		expect(ledger.activateVersionCas(db, { ...a, versionId: "v9" })).toBe(
			false,
		); // other incarnation
		expect(
			ledger.activateVersionCas(db, { ...a, expectedVersionId: "zz" }),
		).toBe(false);
		expect(ledger.activateVersionCas(db, a)).toBe(true);
		expect(ledger.activateVersionCas(db, a)).toBe(false); // pointer already moved
	});
});

test("D01 rollback leaves nothing behind and operations are unique per scope/request", async () => {
	const s = open();
	await expect(
		s.write((db) => {
			ledger.insertKey(db, {
				epoch: 0,
				key: K,
				incarnation: "i0",
				specJson: "{}",
				keywords: "k",
				now: 1,
			});
			throw new Error("boom");
		}),
	).rejects.toThrow("boom");
	await s.write((db) => {
		expect(ledger.countKeys(db, 0)).toBe(0);
		const op = {
			scope: "s",
			request_id: "r",
			input_digest: "d",
			response_json: "{}",
			status: 200,
			created_at: 1,
			expires_at: 2,
		};
		ledger.insertOperation(db, op);
		expect(() =>
			ledger.insertOperation(db, { ...op, input_digest: "e" }),
		).toThrow();
		ledger.insertOperation(db, { ...op, scope: "t" });
		expect(ledger.getEpoch(db)).toBe(0);
		expect(ledger.bumpEpoch(db)).toBe(1);
	});
});

test("D01 ledger bytes count UTF-8 bytes, not characters", async () => {
	const s = open();
	const jp = "天気予報鎌倉".repeat(10); // 60 chars, 180 bytes
	const bytes = async (keywords: string) => {
		await s.write((db) => {
			ledger.insertKey(db, {
				epoch: 0,
				key: K,
				incarnation: crypto.randomUUID(),
				specJson: "{}",
				keywords,
				now: 1,
			});
		});
		return s.read((db) => ledger.ledgerBytes(db));
	};
	const base = await bytes("a");
	await s.write((db) => db.exec("DELETE FROM research_route_keys"));
	expect((await bytes(jp)) - base).toBe(180 - 1);
});
