import { expect, test } from "bun:test";
import { run } from "../../../../cli/commands/router";
import type { CliArgs, CliIo } from "../../../../cli/commands/types";

/** The router's command: it reads and patches the settings through the client and refuses what it cannot parse. */
function harness() {
	const patches: unknown[] = [];
	const shown: unknown[] = [];
	const io = {
		client: {
			routerSettings: async () => ({ mode: "off" }),
			configureRouter: async (patch: unknown) => {
				patches.push(patch);
				return patch;
			},
		},
		show: (value: unknown) => shown.push(value),
		error: () => {},
	} as unknown as CliIo;
	const call = (...positional: string[]) => run({ positional } as CliArgs, io);
	return { call, patches, shown };
}

test("status reads the settings, and clear-profile removes the profile", async () => {
	const h = harness();
	expect(await h.call("status")).toBe(0);
	expect(await h.call()).toBe(0);
	expect(h.shown).toEqual([{ mode: "off" }, { mode: "off" }]);
	await h.call("clear-profile");
	expect(h.patches).toEqual([{ profile: null }]);
});

test("set sends the entry, the structure resource, the profile and the numbers as typed values", async () => {
	const h = harness();
	await h.call("set", "entry", "routeStructured");
	await h.call("set", "structureResource", "none");
	await h.call("set", "profile", "router-p");
	await h.call("set", "timeoutMs", "1500");
	await h.call("set", "accept", "0.7");
	await h.call("set", "feedbackWeight", "0");
	expect(h.patches).toEqual([
		{ entry: "routeStructured" },
		{ structureResourceId: null },
		{ profile: "router-p" },
		{ timeoutMs: 1500 },
		{ accept: 0.7 },
		{ feedbackWeight: 0 },
	]);
});

test("an unknown mode, field or number, or a missing value, is a usage error and sends nothing", async () => {
	const h = harness();
	for (const args of [
		["set", "mode", "on"],
		["set", "entry", "direct"],
		["set", "threshold", "0.5"],
		["set", "accept", "high"],
		["set", "accept", ""],
		["set", "accept"],
		["reset"],
	])
		await expect(h.call(...args)).rejects.toThrow("usage: router");
	expect(h.patches).toEqual([]);
});
