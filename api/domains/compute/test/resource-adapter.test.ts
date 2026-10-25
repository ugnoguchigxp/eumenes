import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as queueMigrations } from "../../queue";
import { parseResourceUri, resourceRefSchema } from "../../resources";
import { createComputeResourceAdapter, migrations } from "..";
import type { Result } from "../contracts";

const OWNER = "owner";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanup.splice(0)) await c();
});
type Job = {
	id: string;
	state?: string;
	code?: string;
	owner?: string;
	createdAt?: number;
	result?: Partial<Result>;
	errorCode?: string;
};
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-compute-resource-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	cleanup.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const adapter = createComputeResourceAdapter({ store, owner: OWNER });
	const job = (j: Job) =>
		store.write((db) =>
			db
				.query(
					`INSERT INTO compute_jobs(id,owner,conversation_id,origin,request_id,idempotency_key,body_json,binding,service_url,state,result_json,error_code,deadline,created_at,updated_at)
					 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					j.id,
					j.owner ?? OWNER,
					"main",
					"task",
					`req-${j.id}`,
					`key-${j.id}`,
					JSON.stringify({
						code: j.code ?? "print(1)",
						inputs: {},
						timeoutSec: 60,
						accelerator: "auto",
					}),
					"binding",
					"http://compute.test",
					j.state ?? "completed",
					j.result
						? JSON.stringify({
								value: null,
								stdout: "",
								stderr: "",
								stdoutTruncated: false,
								stderrTruncated: false,
								artifacts: [],
								...j.result,
							})
						: null,
					j.errorCode ?? null,
					Date.now() + 1000,
					j.createdAt ?? Date.parse("2026-10-20T00:00:00.000Z"),
					Date.now(),
				),
		);
	return { store, adapter, job };
}
const signal = new AbortController().signal;

test("a completed job maps to its result; unfinished, failed, deleted and foreign jobs map to nothing", async () => {
	const { store, adapter, job } = await setup();
	await job({ id: "j-done", code: "# 素数を数える\nprint(2)" });
	await job({ id: "j-run", state: "running" });
	await job({ id: "j-fail", state: "failed", errorCode: "compute_error" });
	await job({ id: "j-del", state: "deleted" });
	await job({ id: "j-foreign", owner: "someone" });
	const refs = (result: unknown) =>
		store.read((db) =>
			adapter.fromResultInTransaction(db, result, { conversationId: "main" }),
		);
	const [ref] = refs({ jobId: "j-done", state: "completed", value: 2 });
	expect(ref).toMatchObject({
		uri: "eumenes://compute.result/j-done",
		kind: "compute.result",
		label: "素数を数える",
	});
	expect(resourceRefSchema.safeParse(ref).success).toBe(true);
	expect(parseResourceUri(ref!.uri)?.id).toBe("j-done");
	expect(refs({ id: "j-done" })).toHaveLength(1);
	for (const jobId of ["j-run", "j-fail", "j-del", "j-foreign", "nope"])
		expect(refs({ jobId })).toEqual([]);
	expect(refs(undefined)).toEqual([]);
});

test("get returns the screen target, and null for a deleted, foreign or unknown job", async () => {
	const { store, adapter, job } = await setup();
	await job({ id: "j-done" });
	await job({ id: "j-del", state: "deleted" });
	await job({ id: "j-foreign", owner: "someone" });
	expect(
		store.read((db) => adapter.getInTransaction(db, "j-done")),
	).toMatchObject({
		adapterRef: "adapter:compute@1",
		targetRef: "j-done",
		actions: ["open", "read"],
		createdAt: "2026-10-20T00:00:00.000Z",
	});
	for (const id of ["j-del", "j-foreign", "nope"])
		expect(store.read((db) => adapter.getInTransaction(db, id))).toBeNull();
});

test("search is newest first, filters by text and period, and skips deleted jobs", async () => {
	const { adapter, job } = await setup();
	await job({
		id: "j-old",
		code: "print('regression')",
		createdAt: Date.parse("2026-10-01T00:00:00.000Z"),
	});
	await job({
		id: "j-new",
		code: "print('graph')",
		result: { stdout: "regression done" },
		createdAt: Date.parse("2026-10-20T00:00:00.000Z"),
	});
	await job({
		id: "j-mid",
		code: "print('x')",
		result: { value: { answer: 42 } },
		createdAt: Date.parse("2026-10-10T00:00:00.000Z"),
	});
	await job({ id: "j-del", state: "deleted", code: "print('regression')" });
	const ids = async (query: Parameters<typeof adapter.search>[0]) =>
		(await adapter.search(query, signal)).map(
			(r) => parseResourceUri(r.uri)!.id,
		);
	expect(await ids({ text: "", limit: 10 })).toEqual([
		"j-new",
		"j-mid",
		"j-old",
	]);
	expect(await ids({ text: "regression", limit: 10 })).toEqual([
		"j-new",
		"j-old",
	]);
	expect(await ids({ text: "42", limit: 10 })).toEqual(["j-mid"]);
	expect(await ids({ text: "", limit: 2 })).toEqual(["j-new", "j-mid"]);
	expect(
		await ids({
			text: "",
			since: "2026-10-05T00:00:00.000Z",
			until: "2026-10-15T00:00:00.000Z",
			limit: 10,
		}),
	).toEqual(["j-mid"]);
});

test("read is a deliberate summary within 600 tokens", async () => {
	const { adapter, job } = await setup();
	await job({
		id: "j-big",
		code: "# 長い計算\n" + "x = 1\n".repeat(2000),
		result: {
			value: { rows: "あ".repeat(3000) },
			stdout: "い".repeat(3000),
			artifacts: [{ id: "a", name: "図.png", mime: "image/png", bytes: 1 }],
		},
	});
	await job({
		id: "j-small",
		code: "print(2)",
		result: { value: 2, stdout: "2\n" },
	});
	await job({
		id: "j-fail",
		state: "failed",
		code: "1/0",
		errorCode: "compute_error",
	});
	const big = (await adapter.read("j-big", signal)).text;
	expect(estimateTextTokens(big)).toBeLessThanOrEqual(600);
	expect(big).toContain("計算結果（完了）");
	expect(big).toContain("…（以下省略）");
	const small = (await adapter.read("j-small", signal)).text;
	expect(small).toContain("コード: print(2)");
	expect(small).toContain("値: 2");
	expect(small).not.toContain("省略");
	expect((await adapter.read("j-fail", signal)).text).toContain(
		"エラー: compute_error",
	);
	await expect(adapter.read("nope", signal)).rejects.toThrow("item_not_found");
});
