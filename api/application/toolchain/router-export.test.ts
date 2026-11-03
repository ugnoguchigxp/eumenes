import { afterEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { migrations } from "../migrations";
import { openStore, type SqliteStore } from "../../infrastructure/sqlite";
import {
	hash,
	packVector,
	routerPassage,
	toolchainPassages,
	vectorSpaceKey,
	type FixedDefinition,
} from "../../domains/capabilities";
import type { RouterTrace } from "../../domains/toolchain-history";
import { createRouterExport, registerRouterExport } from "./router-export";
import { createApp } from "../app";
import { routerExportClient } from "../../../client/router-export";
import { writeRouterExport } from "../../../cli/commands/router-export";
import { exportRedactor } from "./router-export-safety";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const at = Date.parse("2026-10-31T12:00:00Z");
const space = {
	modelId: "fixture-vector",
	dimension: 2,
	revision: "1",
	artifactDigest: "fixture",
};
async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-router-export-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	stores.push(store);
	const definition: FixedDefinition = {
		kind: "toolchain",
		id: "fixture.card",
		revision: 3,
		revisionId: "toolchain:fixture.card@3",
		hash: "",
		generation: 0,
		title: "名前",
		summary: "説明",
		aliases: [],
		tags: [],
		useWhen: ["用途1", "用途2", "用途3"],
		avoidWhen: ["対象外"],
		examples: ["田中花子の依頼\n2行目"],
		dependencies: [],
		functionName: "fixture_card",
		minImpact: "modify_existing",
		general: true,
	};
	await store.write((db) => {
		db.query(
			"INSERT INTO capability_items(key,id,kind,active_revision_id,enabled) VALUES(?,?,?,?,0)",
		).run(
			"toolchain:fixture.card",
			definition.id,
			"toolchain",
			definition.revisionId,
		);
		db.query("INSERT INTO capability_revisions VALUES(?,?,?,?,?,?)").run(
			definition.revisionId,
			"toolchain:fixture.card",
			3,
			JSON.stringify({
				...definition,
				token: "must-not-export",
				body: "must-not-export",
			}),
			"fixture",
			at,
		);
		db.query("INSERT INTO capability_toolchain_vectors VALUES(?,?,?,?,?)").run(
			definition.revisionId,
			0,
			vectorSpaceKey(space),
			hash(toolchainPassages(definition)[0]!),
			packVector([1, 0]),
		);
		db.query("INSERT INTO capability_toolchain_vectors VALUES(?,?,?,?,?)").run(
			definition.revisionId,
			1,
			vectorSpaceKey(space),
			"stale",
			packVector([0, 1]),
		);
		db.query("INSERT INTO conversations(id,created_at) VALUES('conv',?)").run(
			new Date(at).toISOString(),
		);
		for (const [n, role, text] of [
			[0, "user", "前の利用者"],
			[1, "assistant", "前の返答"],
			[2, "user", "田中花子 token=fixture-private"],
			[3, "user", "次の依頼"],
			[4, "user", "影の依頼"],
		] as const) {
			const time = new Date(at + n * 1000).toISOString();
			db.query(
				"INSERT INTO messages(id,conversation_id,role,text,created_at) VALUES(?,'conv',?,?,?)",
			).run(`m${n}`, role, text, time);
			db.query(
				"INSERT INTO conversation_utterances(conversation_id,seq,speaker,text,message_id,created_at) VALUES('conv',?,?,?,?,?)",
			).run(n, role === "assistant" ? "agent" : "user", text, `m${n}`, time);
		}
		for (const n of [2, 3, 4]) {
			db.query(
				"INSERT INTO dialogue_runs(id,request_id,conversation_id,status,revision,seq,input_message_id,created_at,updated_at) VALUES(?,?,'conv','completed',1,?,?,?,?)",
			).run(
				`turn${n}`,
				`req${n}`,
				n,
				`m${n}`,
				new Date(at + n * 1000).toISOString(),
				new Date(at + n * 1000).toISOString(),
			);
			const candidates = [
				{
					toolchainId: definition.id,
					revisionId: definition.revisionId,
					functionName: "fixture_card",
					rank: 1,
					similarity: 0.8,
					ftsRank: null,
					fromHistory: false,
				},
			];
			db.query(
				"INSERT INTO toolchain_selections(id,run_id,conversation_id,retrieval,candidates_json,history_refs_json,decision,toolchain_id,outcome,created_at,expires_at) VALUES(?,?,'conv','embedding',?,'[]',?,?,?,?,?)",
			).run(
				`s${n}`,
				`turn${n}`,
				JSON.stringify(candidates),
				n === 4 ? "answer" : "toolchain",
				n === 4 ? null : definition.id,
				n === 2 ? "failed" : n === 3 ? "cancelled" : "answered",
				at + n * 1000,
				at + 100000,
			);
		}
		for (const n of [3, 4]) {
			const trace: RouterTrace = {
				mode: n === 4 ? "shadow" : "on",
				revision: null,
				model: null,
				candidates: [
					{
						id: definition.id,
						kind: "toolchain",
						raw: 0.9,
						p: 0.9,
						correction: 0,
						score: null,
					},
				],
				set: [definition.id],
				row: 1,
				decided: definition.id,
				durationMs: 10,
				error: null,
			};
			db.query(
				"INSERT INTO router_traces(run_id,conversation_id,message_id,message_ids_json,query_text,query_space,query_space_json,decided_id,set_json,trace_json,created_at,expires_at) VALUES(?,'conv',?,'[]',?,?,?,?, '[]',?,?,?)",
			).run(
				`turn${n}`,
				`m${n}`,
				`次の依頼${n}`,
				vectorSpaceKey(space),
				JSON.stringify(space),
				definition.id,
				JSON.stringify(trace),
				at + n * 1000,
				at + 100000,
			);
		}
		db.query(
			"INSERT INTO router_feedback VALUES('correction','conv','m3','[]','turn3','review','本文',?,?,?,?,'active',?,?)",
		).run(
			vectorSpaceKey(space),
			packVector([1, 0]),
			definition.id,
			"none",
			at + 5000,
			at + 6000,
		);
		db.query(
			"INSERT INTO dialogue_resources(id,conversation_id,ref,uri,kind,label,source,used_at,created_at) VALUES('r','conv',1,'resource:fixture','image','画像','viewed',?,?)",
		).run(new Date(at).toISOString(), new Date(at).toISOString());
		db.query(
			"UPDATE dialogue_runs SET viewing_resource='resource:fixture' WHERE id='turn3'",
		).run();
	});
	return { store, dir, definition };
}

test("fixture snapshot preserves cards, context, both routing paths, corrections and matching passage vectors without writes", async () => {
	const { store, definition } = await fixture();
	let commits = 0;
	const unsubscribe = store.onCommit(() => commits++);
	const exportSnapshot = createRouterExport(store);
	const data = exportSnapshot({ withEmbeddings: true });
	unsubscribe();
	expect(commits).toBe(0);
	expect(() =>
		store.readSnapshot((db) =>
			db.query("DELETE FROM toolchain_selections").run(),
		),
	).toThrow();
	const card = data.cards.find((c) => c.id === definition.id)!;
	expect(card).toMatchObject({
		kind: "general",
		enabled: false,
		version: 3,
		requiresApproval: true,
		highImpact: true,
		updatedAt: null,
	});
	expect(card.embeddingPassages).toEqual(toolchainPassages(definition));
	expect(card.embeddingText).toBe(toolchainPassages(definition).join("\n"));
	expect(card.routerText).toBe(routerPassage(definition));
	expect(data.cards.some((c) => c.kind === "read")).toBe(true);
	expect(data.cards.some((c) => c.kind === "conversation")).toBe(true);
	expect(data.utterances[0]).toMatchObject({
		turnId: "turn2",
		text: "田中花子 token=[REDACTED]",
		previousUser: "前の利用者",
		previousAgent: "前の返答",
		activeTaskId: null,
	});
	expect(
		data.utterances.find((u) => u.turnId === "turn3")?.resourceKinds,
	).toEqual(["image"]);
	expect(data.choices.map((c) => [c.route, c.selectedId, c.result])).toEqual([
		["llm", definition.id, "failure"],
		["router", definition.id, "cancelled"],
		["llm", "none", "success"],
	]);
	expect(data.corrections[0]).toMatchObject({
		turnId: "turn3",
		wrongId: definition.id,
		rightId: "none",
		state: "active",
	});
	expect(data.embeddings).toEqual([
		{
			cardId: definition.id,
			revisionId: definition.revisionId,
			item: 0,
			spaceId: vectorSpaceKey(space),
			modelId: space.modelId,
			dimension: 2,
			vector: [1, 0],
		},
	]);
	expect(JSON.stringify(data)).not.toContain("must-not-export");
	expect(JSON.stringify(data)).not.toContain("fixture-private");
	expect(
		data.manifest.unavailableFields.some(
			(f) => f.field === "utterances.activeTaskId",
		),
	).toBe(true);
	const filtered = exportSnapshot({ since: new Date(at + 4000).toISOString() });
	expect(filtered.utterances.map((u) => u.turnId)).toEqual(["turn4"]);
	expect(filtered.corrections).toHaveLength(1);
	expect(filtered.cards).toHaveLength(data.cards.length);
	expect(filtered.embeddings).toEqual([]);
});

test("authenticated API, typed client and JSONL/gzip writer work together; Git destinations and overwrites are refused", async () => {
	const { store, dir } = await fixture();
	const app = createApp({
		token: "fixture-token",
		origin: "http://localhost",
		modules: [
			{ mount: (app) => registerRouterExport(app, createRouterExport(store)) },
		],
	});
	expect((await app.request("/api/router-export")).status).toBe(401);
	expect(
		(
			await app.request("/api/router-export?since=invalid", {
				headers: { Authorization: "Bearer fixture-token" },
			})
		).status,
	).toBe(400);
	const client = routerExportClient({
		identity: "fixture",
		call: async (path, init) =>
			app.request(path, {
				...init,
				headers: { Authorization: "Bearer fixture-token" },
			}),
	});
	const data = await client.routerExport({ withEmbeddings: true });
	const out = join(dir, "snapshot");
	await writeRouterExport(out, data);
	for (const key of [
		"cards",
		"utterances",
		"choices",
		"corrections",
	] as const) {
		const rows = readFileSync(join(out, `${key}.jsonl`), "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toEqual(data[key]);
		expect(statSync(join(out, `${key}.jsonl`)).mode & 0o777).toBe(0o600);
	}
	expect(
		gunzipSync(readFileSync(join(out, "embeddings.jsonl.gz")))
			.toString()
			.trim(),
	).toBe(JSON.stringify(data.embeddings[0]));
	expect(
		JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).counts
			.embeddings,
	).toBe(1);
	expect(statSync(out).mode & 0o777).toBe(0o700);
	await expect(writeRouterExport(out, data)).rejects.toThrow(
		"router_export_output_exists_or_unavailable",
	);
	await expect(
		writeRouterExport(resolve(import.meta.dir, "snapshot"), data),
	).rejects.toThrow("router_export_output_must_be_outside_git");
	expect(readdirSync(dir).some((name) => name.includes("partial"))).toBe(false);
});

test("security filtering removes environment values, credentials and signed/authenticated URLs while retaining names", () => {
	const redactor = exportRedactor(["fixture-connection", "fixture-env"]);
	const text =
		"田中花子 fixture-env fixture-connection EUMENES_TEST=hidden Authorization: Bearer abc.secret https://user:pass@example.test/ https://example.test/?token=hidden";
	const result = redactor.scrub(text) as string;
	for (const secret of [
		"fixture-env",
		"fixture-connection",
		"hidden",
		"abc.secret",
		"user:pass",
	])
		expect(result).not.toContain(secret);
	expect(result).toContain("田中花子");
});

test("CLI parser and command dispatch write a fixture without printing prose, and reject invalid dates", async () => {
	const { store, dir } = await fixture();
	const data = createRouterExport(store)({ withEmbeddings: true });
	const responsePath = join(dir, "response.json");
	const preload = join(dir, "fetch-fixture.ts");
	writeFileSync(responsePath, JSON.stringify(data), { mode: 0o600 });
	writeFileSync(
		preload,
		`globalThis.fetch = async () => Response.json(await Bun.file(${JSON.stringify(responsePath)}).json());`,
		{ mode: 0o600 },
	);
	const cli = async (args: string[]) => {
		const child = Bun.spawn(
			[process.execPath, "--preload", preload, "cli/index.ts", ...args],
			{
				cwd: resolve(import.meta.dir, "../../.."),
				env: {
					PATH: process.env.PATH,
					EUMENES_API_TOKEN: "fixture-token-at-least-24-characters",
					EUMENES_URL: "http://localhost",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	};
	const out = join(dir, "cli-snapshot");
	const result = await cli([
		"router-export",
		"--out",
		out,
		"--with-embeddings",
		"--since",
		"2026-10-31T00:00:00+09:00",
		"--json",
	]);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({ counts: data.manifest.counts });
	expect(result.stdout).not.toContain("田中");
	expect(result.stdout).not.toContain("fixture-token");
	for (const date of [
		"not-a-date",
		"2026-02-31T00:00:00Z",
		"2026-10-31T00:00:00",
	])
		expect(
			(
				await cli([
					"router-export",
					"--out",
					join(dir, "invalid"),
					"--since",
					date,
				])
			).code,
		).toBe(2);
	const empty = {
		...data,
		embeddings: [],
		manifest: {
			...data.manifest,
			counts: { ...data.manifest.counts, embeddings: 0 },
		},
	};
	const emptyOut = join(dir, "empty-vectors");
	await writeRouterExport(emptyOut, empty);
	expect(
		gunzipSync(readFileSync(join(emptyOut, "embeddings.jsonl.gz"))).toString(),
	).toBe("");
});

test("a retracted input is not resurrected from trace text; an orphaned run uses only an exact retained message link", async () => {
	const { store } = await fixture();
	await store.write((db) => {
		db.query("UPDATE messages SET retracted_at='removed' WHERE id='m3'").run();
		db.query(
			"UPDATE conversation_utterances SET retracted_at='removed' WHERE message_id='m3'",
		).run();
		db.query("DELETE FROM dialogue_runs WHERE id='turn2'").run();
		db.query("UPDATE messages SET run_id='turn2' WHERE id='m2'").run();
	});
	const data = createRouterExport(store)();
	expect(data.utterances.find((u) => u.turnId === "turn3")?.text).toBeNull();
	expect(data.utterances.find((u) => u.turnId === "turn2")?.messageId).toBe(
		"m2",
	);
	expect(data.utterances.find((u) => u.turnId === "turn2")?.text).toContain(
		"田中花子",
	);
});
