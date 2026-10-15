import { test, expect } from "bun:test";
import type { Source } from "../../tool-runtime";
import { EvidenceCatalog } from "../service/evidence-catalog";
import { verifyReport } from "../service/verify-report";

const reading = (
	sourceRef: string,
	over: Partial<Source> = {},
	body = `対象: 経費精算 / 項目: owner / 値: ${sourceRef}`,
): Source => ({
	kind: "world_claim",
	sourceId: crypto.randomUUID(),
	viewId: crypto.randomUUID(),
	viewDigest: `digest:${body}`,
	sourceRef,
	sourceRevision: "1",
	scopeRef: "scope",
	title: "Worldの記録",
	basis: "world",
	origin: "user_report",
	fetchedAt: new Date().toISOString(),
	truncated: false,
	body,
	...over,
});
const refs = (observed: unknown[]) =>
	(observed as Array<{ excerpts: Array<{ reference: string }> }>).flatMap((o) =>
		o.excerpts.map((e) => e.reference),
	);

test("re-reading the same claim revision reuses the registered excerpt and source", () => {
	const catalog = new EvidenceCatalog();
	const first = reading("claim-1");
	const again = reading("claim-1");
	const a = refs(catalog.observe([first]));
	const b = refs(catalog.observe([first, again]));
	expect(a).toHaveLength(1);
	expect(b).toEqual(a);
	expect(catalog.list()).toHaveLength(1);
	expect(catalog.sources().map((s) => s.sourceId)).toEqual([first.sourceId]);
	// Two copies in one batch collapse as well.
	const fresh = new EvidenceCatalog();
	const both = fresh.observe([reading("claim-2"), reading("claim-2")]);
	expect(refs(both)).toHaveLength(1);
	expect(fresh.list()).toHaveLength(1);
});

test("a different revision, scope or text is registered separately", () => {
	const catalog = new EvidenceCatalog();
	catalog.observe([
		reading("claim-1"),
		reading("claim-1", { sourceRevision: "2" }),
		reading("claim-1", { scopeRef: "other" }),
		reading("claim-1", {}, "対象: 経費精算 / 項目: owner / 値: 変更"),
	]);
	expect(catalog.list()).toHaveLength(4);
});

test("repeated queries over the same claims never fill the catalog", () => {
	const catalog = new EvidenceCatalog();
	const claims = Array.from({ length: 10 }, (_, i) => `claim-${i}`);
	// The source list grows with every query, as the task's operations do.
	const all: Source[] = [];
	for (let query = 0; query < 20; query++) {
		all.push(...claims.map((c) => reading(c)));
		catalog.reconcile(all);
		catalog.observe(all);
	}
	expect(catalog.list()).toHaveLength(10);
	expect(catalog.full).toBe(false);
});

test("the report cites the registered source and verifies it, whichever query read it last", () => {
	const catalog = new EvidenceCatalog();
	const first = reading("claim-1");
	const again = reading("claim-1");
	const [ref] = refs(catalog.observe([first]));
	catalog.observe([first, again]);
	const report = catalog.report(
		{
			outcome: "answered",
			summary: "記録があります。",
			claims: [{ text: "記録", evidence: [ref!] }],
			limitations: [],
		},
		["確認した操作2件。"],
	);
	expect(report.claims[0]!.evidence[0]).toMatchObject({
		sourceId: first.sourceId,
		viewId: first.viewId,
	});
	const verified = verifyReport(report, catalog.sources(), false, true);
	expect(verified.sources.map((s) => s.sourceId)).toEqual([first.sourceId]);
	expect(catalog.referencedSources([ref!])).toEqual([first]);
	expect(catalog.verificationEvidence([ref!])[0]).toMatchObject({
		sourceId: first.sourceId,
		viewId: first.viewId,
	});
});

test("a registered reading that is gone is invalidated and a re-read registers anew", () => {
	const catalog = new EvidenceCatalog();
	const first = reading("claim-1");
	const [old] = refs(catalog.observe([first]));
	const again = reading("claim-1");
	catalog.reconcile([again]);
	const [fresh] = refs(catalog.observe([again]));
	expect(fresh).not.toBe(old);
	expect(() => catalog.verificationEvidence([old!])).toThrow(
		"evidence_invalidated",
	);
	expect(catalog.verificationEvidence([fresh!])[0]!.sourceId).toBe(
		again.sourceId,
	);
	// copy() keeps the mapping independent of the original.
	const copy = catalog.copy();
	expect(copy.list()).toEqual(catalog.list());
});
