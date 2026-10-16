import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import {
	createInferenceAdapter,
	describeInferenceAdapter,
	type InferenceAdapterPorts,
} from "./inference-adapter";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";

let store: SqliteStore | undefined;
let dir = "";
afterEach(async () => {
	await store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

const RESOURCE = crypto.randomUUID();
const CONNECTION = crypto.randomUUID();
function setup() {
	dir = mkdtempSync(join(tmpdir(), "inference-adapter-"));
	store = openStore(join(dir, "db"), migrations);
	const log = {
		launched: [] as string[],
		cancelled: [] as string[],
		started: [] as string[],
	};
	let probes: Array<{ id: string; target: string; status: string }> = [];
	const marks: string[] = [];
	const commit = () => {
		for (const id of marks.splice(0))
			probes = probes.map((p) =>
				p.id === id ? { ...p, status: "cancelling" } : p,
			);
	};
	const ports: InferenceAdapterPorts = {
		probes: () => probes,
		getProbe: (id) => probes.find((p) => p.id === id) ?? null,
		inspect: () => ({ profile: "p", providers: [] }),
		usage: () => [
			{ purpose: "llm", source: "cloud", model: "rejected", accepted: 0 },
			{ purpose: "llm", source: "larm", model: "fixture-model", accepted: 1 },
			{ purpose: "tts", source: "cloud", model: "tts-1", accepted: 1 },
			{ purpose: "llm", source: "cloud", model: "older", accepted: 1 },
		],
		startProbeInTransaction: (_db, target) => {
			if (target !== "larm" && target !== RESOURCE)
				throw new Error("invalid_probe_target");
			log.started.push(target);
			const id = crypto.randomUUID();
			probes = [{ id, target, status: "running" }, ...probes];
			return { id, launch: () => log.launched.push(id) };
		},
		// The mark is written by the transaction: it takes effect only when `commit()` is called.
		cancelProbeInTransaction: (_db, id) => {
			const probe = probes.find((p) => p.id === id);
			if (!probe) throw new Error("probe_not_found");
			if (probe.status !== "running") throw new Error("probe_not_running");
			marks.push(id);
		},
		cancelProbe: (id) => log.cancelled.push(id),
	};
	const adapter = createInferenceAdapter(ports, {
		inTransaction: () => ({
			resources: [
				{
					id: RESOURCE,
					connectionId: CONNECTION,
					purpose: "tts",
					model: "tts-1",
				},
			],
			connections: [{ id: CONNECTION, name: "クラウド", enabled: true }],
		}),
	});
	return {
		store: store,
		adapter,
		log,
		commit,
		setProbes: (p: typeof probes) => (probes = p),
	};
}
type Harness = ReturnType<typeof setup>;
const run = (
	h: Harness,
	operationName: string,
	input: unknown,
	kind: "ui" | "conversation" = "ui",
) => {
	const requestId = crypto.randomUUID();
	return h.store.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName,
			input,
			requestId,
			issuedAt: new Date().toISOString(),
			origin:
				kind === "conversation"
					? {
							kind: "conversation",
							owner: {} as never,
							runId: "r",
							conversationId: "c",
							messageId: "m",
						}
					: { kind: "ui", scope: "scope", actionRequestId: requestId },
		}),
	);
};
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};
const read = (h: Harness, query: string, target?: string) =>
	h.store.read((db) => h.adapter.sourceInTransaction(db, query, target));

test("describe offers the probe operations and the four queries", () => {
	const d = describeInferenceAdapter();
	expect(
		Object.fromEntries([...d.operations].map(([n, o]) => [n, o.effect])),
	).toEqual({
		"inference.probe-start": "write",
		"inference.probe-cancel": "write",
	});
	expect([...d.queries].sort()).toEqual([
		"query:inference.larm@1",
		"query:inference.last-usage@1",
		"query:inference.probe-targets@1",
		"query:inference.probes@1",
	]);
	expect(offlineBundleHost().adapters.get("adapter:inference@1")).toBeDefined();
});

test("a probe starts after the commit, and an unknown target is a safe code", async () => {
	const h = setup();
	const result = await run(h, "inference.probe-start", { target: "larm" });
	expect(h.log.started).toEqual(["larm"]);
	// Nothing runs before the transaction's commit hook.
	expect(h.log.launched).toEqual([]);
	h.adapter.afterCommit!();
	expect(h.log.launched).toEqual([(result.resultRefs[0] as { id: string }).id]);
	h.adapter.afterCommit!();
	expect(h.log.launched).toHaveLength(1);
	await run(h, "inference.probe-start", { target: RESOURCE });
	expect(h.log.started).toEqual(["larm", RESOURCE]);
	expect(
		await codeOf(run(h, "inference.probe-start", { target: "nothing" })),
	).toBe("invalid_probe_target");
	expect(await codeOf(run(h, "inference.probe-start", { target: "a/b" }))).toBe(
		"invalid_input",
	);
	expect(await codeOf(run(h, "inference.probe-start", {}))).toBe(
		"invalid_input",
	);
});

test("only a running probe can be cancelled, and the cancel happens after the commit", async () => {
	const h = setup();
	const running = crypto.randomUUID();
	const done = crypto.randomUUID();
	h.setProbes([
		{ id: running, target: "larm", status: "running" },
		{ id: done, target: "larm", status: "succeeded" },
	]);
	await run(h, "inference.probe-cancel", { id: running });
	// Nothing is aborted before the commit hook.
	expect(h.log.cancelled).toEqual([]);
	// A cancel whose transaction rolled back left no mark: the hook aborts nothing, now or later.
	h.adapter.afterCommit!();
	expect(h.log.cancelled).toEqual([]);
	h.adapter.afterCommit!();
	expect(h.log.cancelled).toEqual([]);
	// A committed cancel is marked, and only then is the probe aborted.
	await run(h, "inference.probe-cancel", { id: running });
	h.commit();
	h.adapter.afterCommit!();
	expect(h.log.cancelled).toEqual([running]);
	h.adapter.afterCommit!();
	expect(h.log.cancelled).toEqual([running]);
	expect(await codeOf(run(h, "inference.probe-cancel", { id: done }))).toBe(
		"probe_not_running",
	);
	expect(
		await codeOf(run(h, "inference.probe-cancel", { id: crypto.randomUUID() })),
	).toBe("probe_not_found");
});

test("conversations cannot start or cancel probes", async () => {
	const h = setup();
	for (const [name, input] of [
		["inference.probe-start", { target: "larm" }],
		["inference.probe-cancel", { id: crypto.randomUUID() }],
	] as const)
		expect(await codeOf(run(h, name, input, "conversation"))).toBe(
			"capability_unavailable",
		);
	expect(await codeOf(run(h, "inference.unknown", {}))).toBe(
		"capability_unavailable",
	);
	expect(h.log.started).toEqual([]);
});

test("sources give the probes, the targets with their input, the LARM details and the last use", () => {
	const h = setup();
	const id = crypto.randomUUID();
	h.setProbes([{ id, target: "larm", status: "running" }]);
	const named = { id, target: "larm", status: "running", label: "LARM" };
	expect(read(h, "query:inference.probes@1")!.data).toEqual({
		probes: [named],
	});
	expect(read(h, "query:inference.probes@1", id)!.data).toEqual({
		probes: [named],
	});
	// A probe of a model that is gone still has a name.
	const gone = crypto.randomUUID();
	h.setProbes([{ id: gone, target: crypto.randomUUID(), status: "failed" }]);
	expect(
		(
			read(h, "query:inference.probes@1")!.data as {
				probes: Array<{ label: string }>;
			}
		).probes[0]!.label,
	).toBe("削除されたモデル");
	h.setProbes([{ id: RESOURCE, target: RESOURCE, status: "succeeded" }]);
	expect(
		(
			read(h, "query:inference.probes@1")!.data as {
				probes: Array<{ label: string }>;
			}
		).probes[0]!.label,
	).toBe("クラウド / tts-1");
	h.setProbes([{ id, target: "larm", status: "running" }]);
	expect(read(h, "query:inference.probes@1", crypto.randomUUID())).toBeNull();
	const targets = read(h, "query:inference.probe-targets@1")!.data as {
		targets: Array<{
			id: string;
			label: string;
			purpose: string | null;
			enabled: boolean;
		}>;
	};
	expect(targets.targets).toEqual([
		{ id: "larm", label: "LARM", purpose: null, enabled: true },
		{ id: RESOURCE, label: "クラウド / tts-1", purpose: "tts", enabled: true },
	]);
	expect(read(h, "query:inference.probe-targets@1", "larm")).not.toBeNull();
	expect(read(h, "query:inference.probe-targets@1", "gone")).toBeNull();
	expect(
		h.adapter.targetInput("query:inference.probe-targets@1", RESOURCE, 0),
	).toEqual({
		target: RESOURCE,
	});
	expect(h.adapter.targetInput("query:inference.probes@1", id, 0)).toEqual({
		id,
	});
	expect(read(h, "query:inference.larm@1")!.data).toEqual({
		profile: "p",
		providers: [],
	});
	expect(read(h, "query:inference.last-usage@1")!.data).toEqual({
		llm: { source: "larm", model: "fixture-model" },
		asr: null,
		tts: { source: "cloud", model: "tts-1" },
	});
	expect(read(h, "query:inference.nothing@1")).toBeNull();
});
