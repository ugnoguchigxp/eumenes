import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	learnedMigration,
	migration,
	type Definition,
} from "..";
import { builtins } from "../builtin/web-research";

const owner = { rootRunId: "root", taskId: "task", cancelEpoch: 0 };
const hex = (n: number) => n.toString(16).padStart(32, "0");
export function learnedPair(
	n: number,
	body = "鎌倉の天気を確認する手順",
): Definition[] {
	const id = `learned.web.${hex(n)}`;
	const base = {
		revision: 1,
		aliases: [],
		tags: [],
		useWhen: [],
		avoidWhen: [],
	};
	return [
		{
			...base,
			kind: "skill",
			id,
			title: "学習",
			summary: "学習",
			dependencies: [],
			body,
			discoveryMode: "route-only",
		},
		{
			...base,
			kind: "package",
			id,
			title: "学習",
			summary: "学習",
			backend: "web",
			schemaKey: "research",
			discoveryMode: "route-only",
			dependencies: [
				"profile:web.research@1",
				"skill:web.research@2",
				`skill:${id}@1`,
				"tool:web.read@1",
			],
			profileRevisionId: "profile:web.research@1",
			requiredSkillRevisionIds: ["skill:web.research@2", `skill:${id}@1`],
			toolRevisionIds: ["tool:web.read@1"],
		},
	];
}
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-learned-"));
	const store = openStore(join(dir, "db"), [migration, learnedMigration]);
	const caps = createCapabilities(store);
	await caps.seed();
	return {
		store,
		caps,
		done: async () => {
			caps.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("C01 learned registration rejects conflicts, bad bundles and oversize; builtin hashes unchanged", async () => {
	const { store, caps, done } = await setup();
	try {
		const before = store.read((db) =>
			db
				.query(
					"SELECT id,definition_hash FROM capability_revisions WHERE item_key NOT LIKE 'learned%' ORDER BY id",
				)
				.all(),
		);
		await store.write((db) => {
			const [skill, pkg] = learnedPair(1);
			caps.registerLearnedInTransaction(db, skill!);
			caps.registerLearnedInTransaction(db, pkg!);
			caps.registerLearnedInTransaction(db, skill!); // idempotent
			expect(() =>
				caps.registerLearnedInTransaction(db, { ...skill!, body: "変更" }),
			).toThrow("capability_revision_conflict");
			expect(() =>
				caps.registerLearnedInTransaction(db, {
					...skill!,
					id: "learned.web.zz",
				}),
			).toThrow("invalid_capability");
			expect(() =>
				caps.registerLearnedInTransaction(db, {
					...skill!,
					discoveryMode: undefined,
				}),
			).toThrow("invalid_capability");
			expect(() =>
				caps.registerLearnedInTransaction(db, { ...skill!, revision: 2 }),
			).toThrow("invalid_capability");
			const [s2, p2] = learnedPair(2);
			expect(() =>
				caps.registerLearnedInTransaction(db, { ...p2!, schemaKey: undefined }),
			).toThrow();
			expect(() =>
				caps.registerLearnedInTransaction(db, {
					...p2!,
					requiredSkillRevisionIds: [`skill:${p2!.id}@1`],
				}),
			).toThrow("invalid_capability_bundle");
			expect(() => caps.registerLearnedInTransaction(db, { ...p2! })).toThrow(); // own skill missing
			expect(() =>
				caps.registerLearnedInTransaction(db, {
					...s2!,
					body: "x".repeat(17000),
				}),
			).toThrow("invalid_capability");
			expect(() =>
				caps.registerBuiltinInTransaction(db, learnedPair(3)[0]!),
			).toThrow("invalid_capability");
		});
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT id,definition_hash FROM capability_revisions WHERE item_key NOT LIKE '%learned%' ORDER BY id",
					)
					.all(),
			),
		).toEqual(before);
	} finally {
		await done();
	}
});

test("C01 5000 learned definitions never enter FTS/alias/list and do not displace builtins", async () => {
	const { store, caps, done } = await setup();
	try {
		await store.write((db) => {
			for (let i = 1; i <= 5000; i++) {
				const [s, p] = learnedPair(i);
				caps.registerLearnedInTransaction(db, { ...s!, aliases: ["天気"] });
				caps.registerLearnedInTransaction(db, {
					...p!,
					aliases: ["天気"],
					title: "天気 鎌倉",
					useWhen: ["天気"],
				});
			}
		});
		await store.write((db) => {
			expect(
				db
					.query(
						"SELECT COUNT(*) c FROM capability_search WHERE key LIKE '%learned%'",
					)
					.get(),
			).toEqual({ c: 0 });
			const found = caps.searchInTransaction(
				db,
				owner,
				"天気",
				["天気"],
				Date.now() + 10000,
				8,
			);
			expect(found.length).toBeGreaterThan(0);
			expect(found.every((c) => !c.id.startsWith("learned."))).toBe(true);
		});
		const list = caps.list("", 50);
		expect(list.items.every((i) => !i.id.startsWith("learned."))).toBe(true);
		expect(list.items.length).toBeGreaterThan(0);
		expect(store.read((db) => caps.learnedUsageInTransaction(db)).count).toBe(
			10000,
		);
	} finally {
		await done();
	}
}, 60000);

test("seed adds web.research skill@2 and package@3 without touching old revisions", async () => {
	const { store, done } = await setup();
	try {
		const ids = store.read((db) =>
			(
				db.query("SELECT id FROM capability_revisions").all() as {
					id: string;
				}[]
			).map((r) => r.id),
		);
		for (const id of [
			"skill:web.research@1",
			"skill:web.research@2",
			"package:web.research@2",
			"package:web.research@3",
			"package:web.lookup@3",
			"package:web.read@2",
		])
			expect(ids).toContain(id);
		expect(ids).not.toContain("package:web.read@3");
		const v1 = builtins.find((d) => d.kind === "skill" && d.revision === 1)!;
		expect(v1.body).not.toContain("実Web検索とする");
		const v2 = builtins.find((d) => d.kind === "skill" && d.revision === 2)!;
		expect(v2.body).toContain("最初のactionは必ずweb.lookup");
	} finally {
		await done();
	}
});
