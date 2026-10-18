import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	bindingV1,
	createCapabilities,
	migrations,
	type BundleHost,
	type BundleIssue,
} from "..";
import { bundleFiles } from "../service/bundle-files";

const host = (): BundleHost => ({
	adapters: new Map([
		[
			"adapter:timers@1",
			{
				operations: new Map([
					["timers.start", { inputSchemaRef: "builtin:timerStart" }],
					["timers.list-with-receipt", { inputSchemaRef: "builtin:timerList" }],
					["timers.cancel", { inputSchemaRef: "builtin:timerCancel" }],
					["timers.pause", { inputSchemaRef: "builtin:emptyInput" }],
					["timers.resume", { inputSchemaRef: "builtin:emptyInput" }],
				]),
				queries: new Set([
					"query:timers.setup@1",
					"query:timers.current@1",
					"query:timers.question@1",
				]),
			},
		],
	]),
	availability: new Set(["availability:timers@1"]),
	inputAdapters: new Set(["input:timer-hms@1"]),
	projections: new Set(["projection:timer-result@1"]),
	domainSchemas: new Set(["domain:timers.receipt@1"]),
});

/** The shipped timer command binding as a new revision (a fixture, not a product bundle). */
function commandBundle(agent?: unknown) {
	const timers = structuredClone(
		bundleFiles().find((f) => f.name === "timers.bundle.json")!.raw,
	) as any;
	const binding = structuredClone(timers.bindings.at(-1));
	binding.revision = 99;
	if (agent !== undefined) binding.agent = agent;
	const toolchain = structuredClone(timers.definitions.at(-1));
	toolchain.revision = 99;
	toolchain.bindingRevisionId = "binding:timers.command@99";
	return {
		formatVersion: 1,
		bundleId: "timers-command-agent-fixture",
		pins: timers.pins,
		definitions: [toolchain],
		bindings: [binding],
		artifacts: [],
		schemas: [],
	} as any;
}

async function dry(bundle: unknown): Promise<BundleIssue[]> {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-command-agent-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(["timer"]), {
		bundleHost: host,
	});
	try {
		await caps.seed();
		return (
			await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, host(), { dryRun: true }),
			)
		).issues;
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a command binding takes agent.turn as the policy of its single-shot task, and stays valid without it", () => {
	const command = commandBundle().bindings[0];
	expect(bindingV1.safeParse(command).success).toBe(true);
	const withTurn = {
		...command,
		agent: {
			turn: { maxModelCalls: 12, retries: { default: 1, "timer.start": 0 } },
		},
	};
	const parsed = bindingV1.safeParse(withTurn);
	expect(parsed.success).toBe(true);
	if (parsed.success && parsed.data.execution === "command")
		expect(parsed.data.agent?.turn).toEqual({
			maxModelCalls: 12,
			retries: { default: 1, "timer.start": 0 },
		});
	// Only the turn is a command's: the session's workspace, memory and shared tools are not.
	for (const agent of [
		{},
		{ turn: { maxModelCalls: 0 } },
		{ turn: { maxModelCalls: 13 } },
		{ turn: { retries: { default: 4 } } },
		{ turn: { extra: 1 } },
		{ turn: {}, memory: { recentTurns: 3 } },
		{ turn: {}, workspace: { documentRef: "workspace:x@1" } },
		{ turn: {}, sharedTools: [] },
	])
		expect({
			agent,
			ok: bindingV1.safeParse({ ...command, agent }).success,
		}).toEqual({ agent, ok: false });
});

test("the bundle check accepts the existing command binding with or without agent.turn", async () => {
	expect(await dry(commandBundle())).toEqual([]);
	expect(
		await dry(
			commandBundle({
				turn: { maxModelCalls: 12, retries: { default: 1, "timer.cancel": 2 } },
			}),
		),
	).toEqual([]);
});

test("the bundle check refuses retries that name a tool the binding does not have", async () => {
	const issues = await dry(
		commandBundle({ turn: { retries: { "doc.edit": 1 } } }),
	);
	expect(issues).toEqual([
		expect.objectContaining({
			code: "unknown_reference",
			path: "bindings/0/agent/turn/retries/doc.edit",
		}),
	]);
	expect(
		(await dry(commandBundle({ turn: { maxModelCalls: 99 } })))[0]!.code,
	).toBe("invalid_format");
});
