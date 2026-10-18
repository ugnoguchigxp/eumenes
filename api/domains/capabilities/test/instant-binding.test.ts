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

const host = (instant = true): BundleHost => ({
	adapters: new Map([
		[
			"adapter:weather@1",
			{
				operations: new Map([
					["weather.forecast", { inputSchemaRef: "builtin:weatherPlace" }],
				]),
				queries: new Set<string>(),
				instant,
			},
		],
		[
			"adapter:stock@1",
			{
				operations: new Map([
					["stock.quote", { inputSchemaRef: "builtin:stockQuote" }],
				]),
				queries: new Set<string>(),
				instant,
			},
		],
	]),
	availability: new Set(["availability:weather@1", "availability:stock@1"]),
	inputAdapters: new Set<string>(),
	projections: new Set<string>(),
	domainSchemas: new Set<string>(),
});
const shipped = () =>
	structuredClone(
		bundleFiles().find((f) => f.name === "weather-forecast.bundle.json")!.raw,
	) as any;

async function fixture(
	run: (ctx: {
		store: ReturnType<typeof openStore>;
		caps: ReturnType<typeof createCapabilities>;
	}) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-instant-binding-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(["weather", "stock"]), {
		bundleHost: host,
	});
	try {
		await caps.seed();
		await run({ store, caps });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
const dryRun = (
	store: ReturnType<typeof openStore>,
	caps: ReturnType<typeof createCapabilities>,
	bundle: unknown,
	over = host(),
): Promise<{ issues: BundleIssue[]; registered: string[] }> =>
	store.write((db) =>
		caps.importBundleInTransaction(db, bundle, over, { dryRun: true }),
	);

test("the shipped weather bundle is seeded: an instant toolchain with a binding and no artifact", async () => {
	await fixture(async ({ store, caps }) => {
		store.read((db) => {
			const toolchain = caps
				.toolchainsInTransaction(db)
				.find((d) => d.id === "weather.forecast")!;
			expect(toolchain.functionName).toBe("weather_forecast");
			expect(toolchain.artifactRevisionId).toBeUndefined();
			const found = caps.toolchainBindingInTransaction(
				db,
				toolchain.revisionId,
			)!;
			expect(found.binding.document.execution).toBe("instant");
			expect(found.artifact).toBeNull();
			// No screen: the weather toolchain is no entry of the launcher.
			expect(
				caps
					.artifactsInTransaction(db)
					.some((a) => a.toolchainId === "weather.forecast"),
			).toBe(false);
		});
	});
});

test("an instant binding has no field filled from the host's values: its arguments are the model's", async () => {
	await fixture(async ({ store, caps }) => {
		const bundle = shipped();
		bundle.bindings[0].revision = 3;
		bundle.bindings[0].choiceField = "place";
		const toolchain = bundle.definitions.find(
			(d: any) => d.kind === "toolchain",
		);
		toolchain.revision = 3;
		toolchain.bindingRevisionId = "binding:weather.forecast@3";
		const result = await dryRun(store, caps, bundle);
		expect(result.issues.map((i) => i.code)).toContain("invalid_format");
	});
});

test("an adapter that does not answer instant bindings is refused", async () => {
	await fixture(async ({ store, caps }) => {
		const bundle = shipped();
		bundle.bindings[0].revision = 3;
		const toolchain = bundle.definitions.find(
			(d: any) => d.kind === "toolchain",
		);
		toolchain.revision = 3;
		toolchain.bindingRevisionId = "binding:weather.forecast@3";
		const result = await dryRun(store, caps, bundle, host(false));
		expect(result.issues.map((i) => i.code)).toContain("unregistered_adapter");
	});
});

test("an instant toolchain that also names an artifact is refused", async () => {
	await fixture(async ({ store, caps }) => {
		const bundle = shipped();
		const toolchain = bundle.definitions.find(
			(d: any) => d.kind === "toolchain",
		);
		toolchain.revision = 3;
		toolchain.artifactRevisionId = "artifact:timers.workspace@3";
		const result = await dryRun(store, caps, bundle);
		expect(result.issues.map((i) => i.code)).toContain("invalid_toolchain");
	});
});

test("an instant binding takes exactly one tool", () => {
	const bundle = shipped();
	bundle.bindings[0].tools = [];
	return fixture(async ({ store, caps }) => {
		bundle.bindings[0].revision = 3;
		const result = await dryRun(store, caps, bundle);
		expect(result.issues.map((i) => i.code)).toContain("invalid_format");
	});
});

test("the shipped stock bundle is an instant toolchain", async () => {
	await fixture(async ({ store, caps }) => {
		store.read((db) => {
			const toolchain = caps
				.toolchainsInTransaction(db)
				.find((d) => d.id === "stock.quote")!;
			expect(toolchain.functionName).toBe("stock_quote");
			expect(toolchain.artifactRevisionId).toBeUndefined();
			const binding = caps.toolchainBindingInTransaction(
				db,
				toolchain.revisionId,
			)!.binding.document;
			expect(binding.execution).toBe("instant");
		});
	});
});
