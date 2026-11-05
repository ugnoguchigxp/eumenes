import { expect, test } from "bun:test";
import { findSiteObjects, listPageProfiles } from "eumenes-interact/sqlite";
import { interactFixture } from "./interact.fixture";
import {
	seedInteractSites,
	interactKnowledge,
} from "../service/interact-knowledge";
import seed from "../../../../vendor/interact/site-candidates.json";
test("public site seeds preserve origin/provenance/revision and never claim live verification", async () => {
	const f = await interactFixture({ startQueue: false });
	try {
		const now = new Date().toISOString();
		await f.store.write((db) => {
			seedInteractSites(db, f.owner, seed, now);
			seedInteractSites(db, f.owner, seed, now);
		});
		const objects = f.store.read((db) =>
			seed.sites.flatMap((site) =>
				site.origins.flatMap((origin) =>
					findSiteObjects(db, f.owner, { origin }),
				),
			),
		);
		expect(objects).toHaveLength(10);
		expect(
			objects
				.flatMap((o) => o.candidates)
				.every((c) => c.status === "candidate"),
		).toBe(true);
		const profiles = f.store.read((db) =>
			listPageProfiles(db, f.owner, "https://ja.wikipedia.org"),
		);
		expect(profiles[0]!.conditions.sourceRevision).toBe(seed.sourceCommit);
		expect(profiles[0]!.basis).toContain("unknown");
		const body = '- searchbox "Wikipedia内を検索" [ref=e17]';
		const knowledge = interactKnowledge(f.store, f.owner, Date.now);
		expect(
			knowledge.resolve(
				"https://ja.wikipedia.org/wiki/Test",
				body,
				"search.query",
			),
		).toEqual({ ref: "e17", role: "searchbox", name: "Wikipedia内を検索" });
		expect(
			knowledge.resolve("https://foreign.example/", body, "search.query"),
		).toBeNull();
		expect(
			interactKnowledge(f.store, "foreign", Date.now).resolve(
				"https://ja.wikipedia.org/",
				body,
				"search.query",
			),
		).toBeNull();
		expect(
			knowledge.resolve(
				"https://ja.wikipedia.org/",
				body + '\n- searchbox "Wikipedia内を検索" [ref=e18]',
				"search.query",
			),
		).toBeNull();
	} finally {
		await f.close();
	}
});
