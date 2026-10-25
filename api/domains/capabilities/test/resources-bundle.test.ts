import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations,
	type BundleHost,
	type BundleIssue,
} from "..";
import { bundleFiles } from "../service/bundle-files";

const host: BundleHost = {
	adapters: new Map([
		[
			"adapter:resources@1",
			{
				operations: new Map([
					["resources.manage", { inputSchemaRef: "builtin:resourcesTool" }],
				]),
				queries: new Set<string>(),
				instant: true,
			},
		],
	]),
	availability: new Set(["availability:resources@1"]),
	inputAdapters: new Set<string>(),
	projections: new Set<string>(),
	domainSchemas: new Set<string>(),
};

async function fixture(
	run: (ctx: {
		store: ReturnType<typeof openStore>;
		caps: ReturnType<typeof createCapabilities>;
	}) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-resources-bundle-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(["resources"]), {
		bundleHost: () => host,
	});
	try {
		await caps.seed();
		await run({ store, caps });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the shipped resources bundle is an instant toolchain with one flat tool, no artifact and impact none", async () => {
	await fixture(async ({ store, caps }) => {
		store.read((db) => {
			const toolchain = caps
				.toolchainsInTransaction(db)
				.find((d) => d.id === "resources.manage")!;
			expect(toolchain.functionName).toBe("resources");
			expect(toolchain.minImpact).toBe("none");
			expect(toolchain.artifactRevisionId).toBeUndefined();
			const found = caps.toolchainBindingInTransaction(
				db,
				toolchain.revisionId,
			)!;
			expect(found.binding.document.execution).toBe("instant");
			expect(found.artifact).toBeNull();
		});
	});
});

test("the shipped resources bundle passes the bundle check against the adapter's declaration", async () => {
	await fixture(async ({ store, caps }) => {
		const raw = bundleFiles().find(
			(f) => f.name === "resources.bundle.json",
		)!.raw;
		const result: { issues: BundleIssue[] } = await store.write((db) =>
			caps.importBundleInTransaction(db, raw, host, { dryRun: true }),
		);
		expect(result.issues).toEqual([]);
	});
});
