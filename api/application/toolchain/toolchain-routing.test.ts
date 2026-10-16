import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import {
	createAdapterRegistry,
	type DomainAdapter,
} from "../../domains/tool-runtime";
import { createCapabilities } from "../../domains/capabilities";
import { bundleFiles } from "../../domains/capabilities/service/bundle-files";
import { createToolchainHistory } from "../../domains/toolchain-history";
import { createSchemaProvider, offlineBundleHost } from "./toolchain-adapters";
import { createToolchainRouting } from "./toolchain-routing";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const SESSION_REVISION = "toolchain:timers.manage@5";
const COMMAND_REVISION = "toolchain:timers.manage@4";

/** A session binding over the shipped timer package and artifact (a fixture, not a product bundle). */
function sessionBundle(targetSchemaRef?: string) {
	const timers = structuredClone(
		bundleFiles().find((f) => f.name === "timers.bundle.json")!.raw,
	) as any;
	const command = timers.bindings.at(-1);
	const toolchain = structuredClone(timers.definitions.at(-1));
	toolchain.revision = 5;
	toolchain.bindingRevisionId = "binding:timers.session@1";
	return {
		formatVersion: 1,
		bundleId: "timers-session-fixture",
		pins: timers.pins,
		definitions: [toolchain],
		bindings: [
			{
				kind: "binding",
				id: "timers.session",
				revision: 1,
				execution: "session",
				adapterRef: command.adapterRef,
				availabilityRef: command.availabilityRef,
				tools: command.tools,
				artifactRevisionId: command.artifactRevisionId,
				session: targetSchemaRef ? { targetSchemaRef } : {},
			},
		],
		artifacts: [],
		schemas: [],
	};
}

async function setup(available = true) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-routing-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	const capabilities = createCapabilities(store, new Set(["timer"]), {
		bundleHost: offlineBundleHost,
	});
	await capabilities.seed();
	await store.write((db) => {
		const result = capabilities.importBundleInTransaction(
			db,
			sessionBundle("builtin:timerCancel"),
			offlineBundleHost(),
		);
		expect(result.issues).toEqual([]);
	});
	const adapter = {
		ref: "adapter:timers@1",
		availableInTransaction: () => available,
	} as unknown as DomainAdapter;
	const routing = createToolchainRouting(
		capabilities,
		createToolchainHistory(store),
		async () => undefined,
		createAdapterRegistry([adapter]),
		createSchemaProvider(capabilities),
	);
	const publish = (revisionId: string) =>
		store.write((db) =>
			capabilities.publishToolchainRevisionInTransaction(
				db,
				"timers.manage",
				revisionId,
			),
		);
	return { store, routing, publish };
}

test("a session toolchain's runtime says session and its set carries the binding's contract", async () => {
	const { store, routing } = await setup();
	try {
		store.read((db) => {
			const runtime = routing
				.catalogInTransaction(db)
				.find((c) => c.revisionId === SESSION_REVISION)?.runtime;
			expect(runtime).toMatchObject({
				execution: "session",
				binding: {
					bindingRevisionId: "binding:timers.session@1",
					adapterRef: "adapter:timers@1",
					artifactRevisionId: "artifact:timers.workspace@2",
					available: true,
				},
			});
			const set = routing.sessionSetInTransaction!(db, SESSION_REVISION);
			expect(set).toMatchObject({
				toolchainId: "timers.manage",
				toolchainRevisionId: SESSION_REVISION,
				bindingRevisionId: "binding:timers.session@1",
				adapterRef: "adapter:timers@1",
				artifactRevisionId: "artifact:timers.workspace@2",
				packageRevisionId: "package:timers.manage@1",
				targetSchemaRef: "builtin:timerCancel",
			});
			expect(set.title.length).toBeGreaterThan(0);
			expect(set.profile.length).toBeGreaterThan(0);
			expect(set.skills.length).toBeGreaterThan(0);
			expect(set.tools.map((t) => t.operationName)).toEqual([
				"timers.start",
				"timers.list-with-receipt",
				"timers.cancel",
			]);
			for (const tool of set.tools) {
				expect(tool.schema.type).toBe("object");
				expect(tool.inputSchemaRef.startsWith("builtin:")).toBe(true);
				expect(tool.summary.length).toBeGreaterThan(0);
			}
		});
	} finally {
		await store.close();
	}
});

test("the command set refuses a session toolchain and the session set refuses command and unavailable ones", async () => {
	const { store, routing, publish } = await setup();
	try {
		store.read((db) =>
			expect(() =>
				routing.commandSetInTransaction(db, SESSION_REVISION),
			).toThrow("capability_unavailable"),
		);
		await publish(COMMAND_REVISION);
		store.read((db) => {
			const runtime = routing
				.catalogInTransaction(db)
				.find((c) => c.revisionId === COMMAND_REVISION)?.runtime;
			expect(runtime?.execution).toBe("command");
			expect(() =>
				routing.sessionSetInTransaction!(db, COMMAND_REVISION),
			).toThrow("capability_unavailable");
			expect(
				routing.commandSetInTransaction(db, COMMAND_REVISION).binding,
			).toBeDefined();
			// A revision that is no longer the published one cannot start a session.
			expect(() =>
				routing.sessionSetInTransaction!(db, SESSION_REVISION),
			).toThrow("toolchain_unavailable");
		});
	} finally {
		await store.close();
	}
	const down = await setup(false);
	try {
		down.store.read((db) => {
			expect(() =>
				down.routing.sessionSetInTransaction!(db, SESSION_REVISION),
			).toThrow("capability_unavailable");
			expect(
				down.routing
					.catalogInTransaction(db)
					.find((c) => c.revisionId === SESSION_REVISION)?.runtime.binding
					?.available,
			).toBe(false);
		});
	} finally {
		await down.store.close();
	}
});
