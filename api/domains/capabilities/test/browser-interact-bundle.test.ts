import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities, migrations, type BundleHost } from "..";
import bundle from "../bundles/browser-interact.bundle.json";
const describeInteractAdapter = () => ({
	owner: "browser",
	operations: new Map(
		["start", "status", "answer", "cancel", "forget"].map(
			(op) =>
				[
					"browser.interact." + op,
					{
						inputSchemaRef:
							"builtin:browserInteract" +
							(op === "start"
								? "Start"
								: op === "answer"
									? "Answer"
									: "Target"),
						effect: op === "status" ? "read" : "write",
					},
				] as const,
		),
	),
	queries: new Set(["query:browser.interact.workspace@1"]),
	inputAdapters: new Map([
		["input:browser.interact-start@1", null],
		["input:browser.interact-answer@1", null],
		["input:browser.interact-control@1", null],
	]),
	projections: new Set(["projection:browser.interact-result@1"]),
	availability: "availability:browser.interact@1",
});
const interactDomainSchemas = { "domain:browser.interact-receipt@1": null };

test("pilot bundle registers immutably, with shared components and no unsupported host contracts", async () => {
	const d = describeInteractAdapter();
	const host: BundleHost = {
		adapters: new Map([["adapter:browser.interact@1", d]]),
		availability: new Set([d.availability]),
		inputAdapters: new Set(d.inputAdapters.keys()),
		projections: d.projections,
		domainSchemas: new Set(Object.keys(interactDomainSchemas)),
	};
	const dir = mkdtempSync(join(tmpdir(), "interact-bundle-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(), { bundleHost: () => host });
	try {
		const check = await store.write((db) =>
			caps.importBundleInTransaction(db, bundle, host, { dryRun: true }),
		);
		expect(check.issues).toEqual([]);
		await store.write((db) => caps.importBundleInTransaction(db, bundle, host));
		await store.write((db) => caps.importBundleInTransaction(db, bundle, host));
		const found = store.read((db) =>
			caps.toolchainBindingInTransaction(db, "toolchain:browser.interact@1"),
		);
		expect(found?.binding.document).toMatchObject({
			execution: "command",
			adapterRef: "adapter:browser.interact@1",
		});
		expect(found?.artifact?.document.variants[0]?.definition).toMatchObject({
			view: "layout",
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
import { openStore } from "../../../infrastructure/sqlite";
