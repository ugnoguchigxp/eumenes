import { harness } from "./toolchain.fixture";
import {
	ledger,
	canonicalJson,
	sha256,
	type SearchSpec,
} from "../domains/research-routes";

/** A stored legacy record, never produced by interpreting a new user request. */
export async function routeHarness() {
	const h = await harness();
	const now = Date.now();
	const spec: SearchSpec = {
		keyVersion: 1,
		scope: "local:owner",
		language: "ja",
		region: "JP",
		timeZone: "Asia/Tokyo",
		keywords: "天気予報 鎌倉",
		purpose: "weather",
		target: { name: "鎌倉市", prefecture: "神奈川県", granularity: "city" },
		requiredFields: ["condition"],
		timeMode: "today",
	};
	const key = sha256(canonicalJson(spec));
	await h.store.write((db) => {
		const skillId = "learned.web." + "a".repeat(32);
		h.toolchain.capabilities.registerLearnedInTransaction(db, {
			kind: "skill",
			id: skillId,
			revision: 1,
			title: "保存済み手順",
			summary: "旧方式の手順",
			aliases: [],
			tags: [],
			useWhen: [],
			avoidWhen: [],
			dependencies: [],
			discoveryMode: "route-only",
			body: "過去に保存した鎌倉の取得手順。現在の調査には適用しない。",
		});
		ledger.insertKey(db, {
			epoch: 0,
			key,
			incarnation: "legacy-fixture",
			specJson: canonicalJson(spec),
			keywords: spec.keywords,
			now,
		});
		ledger.insertRevision(db, {
			version_id: "legacy-fixture-v1",
			epoch: 0,
			key,
			incarnation: "legacy-fixture",
			revision: 1,
			recipe_json: canonicalJson({
				toolId: "web.read",
				arguments: { url: "https://example.com/legacy" },
				sourceUrl: "https://example.com/legacy",
				specDigest: key,
				validationProfile: "weather-excerpt-v1",
				singleSource: true,
			}),
			context_projection:
				"過去に保存された補足です。現在の調査では資料を選び直します。",
			skill_revision_id: `skill:${skillId}@1`,
			package_revision_id: "package:web.read@2",
			proof_digest: "a".repeat(64),
			review_digest: "b".repeat(64),
			registration_certificate_json: "{}",
			validation_policy_version: 1,
			created_at: now,
			revalidate_at: now + 86400000,
		});
		db.query(
			"UPDATE research_route_keys SET active_version_id=? WHERE key=?",
		).run("legacy-fixture-v1", key);
	});
	return h;
}
