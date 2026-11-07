import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { FixedDefinition, Prepared } from "../../capabilities";
import { scratchWrite } from "../../capabilities";
import type { ChildExecution } from "../../tool-runtime";
import type { Task } from "../contracts";
import { workerContext } from "../service/context";
import { EvidenceCatalog } from "../service/evidence-catalog";
import { hostBindings } from "../service/host-tools";
import {
	allowedUris,
	checkLinks,
	saveResources,
} from "../service/resource-access";
import type { RuntimeContext } from "../service/runtime-context";

/** The host tools every conversation worker gets (spec/server-scratch-cache-design-2026-11-07.md §9). */
const tool = (id: string, revision: number): FixedDefinition =>
	({
		kind: "tool",
		id,
		revisionId: `tool:${id}@${revision}`,
		hash: id,
		generation: 1,
		title: id,
		summary: id,
		schemaKey: id === "scratch.write" ? "scratchWrite" : "resourceRead",
	}) as FixedDefinition;
const prepared = (over: Partial<Prepared["package"]> = {}, deps: FixedDefinition[] = []) =>
	({
		package: {
			id: "history.research",
			title: "詳しいWeb調査",
			backend: "history",
			profileRevisionId: "profile:p@1",
			requiredSkillRevisionIds: ["skill:s@1"],
			toolRevisionIds: deps.map((d) => d.revisionId),
			...over,
		},
		dependencies: [
			{ revisionId: "profile:p@1", hash: "p", body: "profile" },
			{ revisionId: "skill:s@1", hash: "s", body: "skill" },
			...deps,
		],
		input: { question: "依頼" },
	}) as Prepared;
const ctx = (ports: { resources?: boolean; sharedWrite?: boolean }) =>
	({
		deps: {
			capabilities: {
				activeToolInTransaction: (_db: unknown, id: string) =>
					tool(id, id === "resource.read" ? 2 : 1),
			},
			...(ports.resources ? { resources: { read: async () => ({ ok: true, text: "" }) } } : {}),
			...(ports.sharedWrite
				? { sharedWrite: { write: async () => ({ ok: true, uri: "", bytes: 0 }) } }
				: {}),
		},
	}) as unknown as RuntimeContext;
const execution = { source: { conversationId: "main" } } as ChildExecution;
const ids = (list: ReturnType<typeof hostBindings>) => list.map((b) => b.tool.id);

test("a conversation worker gets resource.read and scratch.write from the host", () => {
	const db = new Database(":memory:");
	expect(ids(hostBindings(ctx({ resources: true, sharedWrite: true }), db, prepared(), execution))).toEqual([
		"resource.read",
		"scratch.write",
	]);
	// Without a conversation the written file would belong to none: only the read is offered.
	expect(ids(hostBindings(ctx({ resources: true, sharedWrite: true }), db, prepared(), undefined))).toEqual([
		"resource.read",
	]);
	// Without the ports, neither.
	expect(hostBindings(ctx({}), db, prepared(), execution)).toEqual([]);
});

test("a package that lists a host tool keeps its own binding; a guided web worker gets none", () => {
	const db = new Database(":memory:");
	const own = tool("resource.read", 2);
	expect(
		ids(hostBindings(ctx({ resources: true, sharedWrite: true }), db, prepared({}, [own]), execution)),
	).toEqual(["scratch.write"]);
	expect(
		hostBindings(
			ctx({ resources: true, sharedWrite: true }),
			db,
			prepared({ schemaKey: "guidedResearch" } as never),
			execution,
		),
	).toEqual([]);
});

test("what the worker wrote is shown in the next step and may be returned in finish.links", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, resources_json TEXT)");
	db.query("INSERT INTO agent_tasks (id) VALUES ('t1')").run();
	const written = "eumenes://scratch/2c1d7a40-0000-4000-8000-000000000001";
	saveResources(db, "t1", {
		writes: [
			{ name: "価格表.md", ok: true, uri: written, bytes: 8123 },
			{ name: "大きすぎる.md", ok: false, code: "scratch_too_large" },
		],
	});
	const allowed = allowedUris(db, { observationsInTransaction: () => [] } as never, "t1", execution);
	expect(allowed.has(written)).toBe(true);
	expect(checkLinks([written], allowed)).toEqual([written]);
	const stored = db
		.query("SELECT resources_json FROM agent_tasks WHERE id='t1'")
		.get() as { resources_json: string };
	const task = {
		deadline: 180000,
		model_calls: 1,
		input_json: JSON.stringify({ execution: { source: {}, refs: [] } }),
		resources_json: stored.resources_json,
	} as Task;
	const { messages } = workerContext(task, prepared(), [], [], [], new EvidenceCatalog(), 0);
	const materials = messages.find((m) => m.content.includes("sharedWrites"))!;
	expect(
		JSON.parse(materials.content.slice(materials.content.indexOf("{"))).sharedWrites,
	).toEqual([
		{ name: "価格表.md", uri: written, bytes: 8123 },
		{ name: "大きすぎる.md", errorCode: "scratch_too_large" },
	]);
});

test("the scratch.write input takes a text format, a display name and at most 1 MiB of characters", () => {
	expect(scratchWrite.safeParse({ name: "表.md", mime: "text/markdown", text: "| a |" }).success).toBe(true);
	expect(scratchWrite.safeParse({ name: "x.html", mime: "text/html", text: "<p>" }).success).toBe(false);
	expect(scratchWrite.safeParse({ name: " ", mime: "text/plain", text: "a" }).success).toBe(false);
	expect(scratchWrite.safeParse({ name: "a", mime: "text/plain", text: "" }).success).toBe(false);
});
