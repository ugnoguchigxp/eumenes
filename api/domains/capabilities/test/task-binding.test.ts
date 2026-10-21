import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { bindingV1, createCapabilities, migrations } from "..";
import { bundleFiles } from "../service/bundle-files";
import { offlineBundleHost } from "../../../application/toolchain/toolchain-adapters";

const bundle = () =>
	structuredClone(
		bundleFiles().find((f) => f.name === "task-execution.bundle.json")!.raw,
	) as { bindings: Array<Record<string, unknown>> };
test("task binding is bounded, has no artifact and rejects unknown execution kinds", () => {
	const doc = bundle().bindings[0]!;
	expect(bindingV1.safeParse(doc).success).toBe(true);
	for (const value of [
		{ ...doc, artifactRevisionId: "artifact:fake@1" },
		{ ...doc, execution: "unknown" },
		{ ...doc, limits: { parentCalls: 99 } },
		{
			...doc,
			timeLimits: { runMs: 10_000, turnMs: 20_000, inferenceMs: 10_000 },
		},
	])
		expect(bindingV1.safeParse(value).success).toBe(false);
});
test("the task bundle registers without a dummy artifact and reseeds immutable revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-task-binding-"));
	const store = openStore(join(dir, "db"), migrations);
	const host = offlineBundleHost();
	const caps = createCapabilities(store, new Set(["task-execution"]), {
		bundleHost: () => host,
	});
	try {
		await caps.seed();
		const result = await store.write((db) =>
			caps.importBundleInTransaction(db, bundle(), host, { dryRun: true }),
		);
		expect(result.issues).toEqual([]);
		const first = store.read((db) =>
			caps.toolchainSetInTransaction(db, "toolchain:task.execute@7"),
		);
		expect(first.binding?.document.execution).toBe("task");
		expect(
			store.read((db) =>
				caps.toolchainBindingInTransaction(db, first.toolchain.revisionId),
			)?.artifact,
		).toBeNull();
		await caps.seed();
		expect(
			store.read(
				(db) =>
					caps.toolchainSetInTransaction(db, "toolchain:task.execute@7")
						.binding,
			),
		).toEqual(first.binding);
		const unsupported = { ...host, adapters: new Map(host.adapters) };
		unsupported.adapters.set("adapter:task-execution@1", {
			operations: new Map(),
			queries: new Set(),
		});
		const refused = await store.write((db) =>
			caps.importBundleInTransaction(db, bundle(), unsupported, {
				dryRun: true,
			}),
		);
		expect(refused.issues.some((i) => i.code === "unregistered_adapter")).toBe(
			true,
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a host with the earlier task result schema upgrades by new revisions and preserves its old binding", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-task-upgrade-")),
		store = openStore(join(dir, "db"), migrations),
		host = offlineBundleHost();
	const caps = createCapabilities(store, new Set(["task-execution"]), {
		bundleHost: () => host,
	});
	try {
		const earlier = bundle() as any;
		const toolchain = earlier.definitions.find(
			(d: any) => d.kind === "toolchain",
		);
		toolchain.revision = 1;
		toolchain.bindingRevisionId = "binding:task.execute@1";
		toolchain.dependencies = ["package:task.execute@1"];
		toolchain.packageRevisionId = "package:task.execute@1";
		const skill = earlier.definitions.find((d: any) => d.kind === "skill");
		skill.revision = 1;
		skill.body = "Earlier frozen instructions";
		const pack = earlier.definitions.find((d: any) => d.kind === "package");
		pack.revision = 1;
		pack.dependencies = ["profile:task.executor@1", "skill:task.executor@1"];
		pack.requiredSkillRevisionIds = ["skill:task.executor@1"];
		earlier.bindings[0].revision = 1;
		earlier.bindings[0].outputSchemaRef = "schema:task.result@1";
		const result = earlier.schemas.find((d: any) => d.id === "task.result");
		result.revision = 1;
		result.schema = {
			type: "object",
			properties: { status: { type: "string" } },
			required: ["status"],
			additionalProperties: false,
		};
		const imported = await store.write((db) =>
			caps.importBundleInTransaction(db, earlier, host),
		);
		expect(imported.issues).toEqual([]);
		const old = store.read(
			(db) =>
				caps.toolchainBindingInTransaction(db, "toolchain:task.execute@1")
					?.binding,
		);
		await store.write((db) =>
			caps.setEnabledInTransaction(db, "toolchain", "task.execute", false),
		);
		await caps.seed();
		await caps.seed();
		expect(
			store.read((db) =>
				caps.getDefinitionInTransaction(db, "toolchain:task.execute@7"),
			),
		).toBeNull();
		await store.write((db) =>
			caps.setEnabledInTransaction(db, "toolchain", "task.execute", true),
		);
		expect(
			store.read(
				(db) =>
					caps.toolchainBindingInTransaction(db, "toolchain:task.execute@1")
						?.binding,
			),
		).toEqual(old);
		expect(
			store.read(
				(db) =>
					caps.toolchainSetInTransaction(db, "toolchain:task.execute@7").binding
						?.document,
			),
		).toMatchObject({ revision: 2, outputSchemaRef: "schema:task.result@2" });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
