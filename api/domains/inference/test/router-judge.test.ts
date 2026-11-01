import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { LarmPort } from "../../larm";
import { defaults } from "../../settings";
import type { Settings } from "../../settings/contracts";
import { createRouterJudge } from "../service/router-judge";

const installationKey = new Uint8Array(32).fill(7);
const derive = (purpose: string) =>
	new Uint8Array(
		createHmac("sha256", installationKey).update(purpose).digest(),
	);

/**
 * The router's port (spec toolchain-router-redesign §3.2): made from the saved router profile while the router is not
 * `off`, made again when the profile or the LARM origin changes, closed at the end; never the intent judge's port.
 */
function harness(router: Partial<Settings["router"]>) {
	let saved = defaults({});
	saved.larm.baseUrl = "http://127.0.0.1:9810";
	saved.router = { ...saved.router, ...router };
	const listeners = new Set<() => void>();
	const made: Array<{ profile: string | undefined; closed: boolean }> = [];
	const clients: Array<string | undefined> = [];
	const judge = createRouterJudge({
		settings: {
			get: () => saved,
			onChange: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			derivedKey: derive,
		},
		options: {
			routerLarmFactory: (s, client) => {
				const record = { profile: s.router.profile, closed: false };
				made.push(record);
				clients.push(client);
				return {
					route: async (input) => ({
						choice: input.criteria[0]!.name,
						probabilities: {},
						scores: null,
						model: `model-of-${s.router.profile}`,
						headRevision: null,
						calibrationRevision: null,
					}),
					routeFields: async () => ({
						choices: {},
						values: null,
						confidence: null,
						model: `model-of-${s.router.profile}`,
						headRevision: null,
					}),
					connect: async () => {},
					close: async () => {
						record.closed = true;
					},
				} as Partial<LarmPort> as LarmPort;
			},
		},
	});
	const change = (next: (s: Settings) => void) => {
		saved = structuredClone(saved);
		next(saved);
		for (const fn of listeners) fn();
	};
	return { judge, made, clients, change };
}
const signal = () => new AbortController().signal;
const input = {
	text: "天気",
	previousAgent: null,
	previousUser: null,
	instructions: "選んでください",
	criteria: [{ name: "weather", description: "天気" }],
};
const fields = {
	text: "天気",
	previousAgent: null,
	previousUser: null,
	choices: {},
	extract: null,
};

test("a router that is on is connected ahead of the first call, once, held, and closed at the end", async () => {
	const h = harness({ mode: "shadow", profile: "router-a" });
	expect(h.made).toEqual([{ profile: "router-a", closed: false }]);
	expect(await h.judge.route(input, signal())).toMatchObject({
		choice: "weather",
		model: "model-of-router-a",
	});
	expect(await h.judge.routeFields(fields, signal())).toMatchObject({
		model: "model-of-router-a",
	});
	expect(h.made).toHaveLength(1);
	expect(h.clients[0]).toMatch(/^eumenes-[0-9a-f]{32}$/);
	await h.judge.close();
	expect(h.made[0]!.closed).toBe(true);
	for (const call of [
		h.judge.route(input, signal()),
		h.judge.routeFields(fields, signal()),
	])
		await expect(call).rejects.toThrow("router_closed");
});

test("with the router off or without a profile no port is made and the caller falls back", async () => {
	const off = harness({ mode: "off", profile: "router-a" });
	const missing = harness({ mode: "on" });
	await expect(off.judge.route(input, signal())).rejects.toThrow(
		"router_unconfigured",
	);
	await expect(off.judge.routeFields(fields, signal())).rejects.toThrow(
		"router_unconfigured",
	);
	await expect(missing.judge.route(input, signal())).rejects.toThrow(
		"router_profile_missing",
	);
	expect([...off.made, ...missing.made]).toEqual([]);
});

test("a changed profile releases the old port and the next call makes the new one; turning it off releases it too", async () => {
	const h = harness({ mode: "on", profile: "router-a" });
	await h.judge.route(input, signal());
	h.change((s) => {
		s.router.profile = "router-b";
	});
	expect(h.made[0]!.closed).toBe(true);
	expect(await h.judge.route(input, signal())).toMatchObject({
		model: "model-of-router-b",
	});
	expect(h.clients[1]).not.toBe(h.clients[0]);
	// A change of a threshold or of other judges' settings keeps the port.
	h.change((s) => {
		s.router.accept = 0.7;
		s.intent.mode = "shadow";
	});
	expect(h.made.map((m) => m.closed)).toEqual([true, false]);
	h.change((s) => {
		s.router.mode = "off";
	});
	expect(h.made.map((m) => m.closed)).toEqual([true, true]);
	await expect(h.judge.route(input, signal())).rejects.toThrow(
		"router_unconfigured",
	);
	await h.judge.close();
});

test("a changed LARM origin makes a new port, and the client is the same after a restart", async () => {
	const first = harness({ mode: "on", profile: "router-a" });
	const restarted = harness({ mode: "on", profile: "router-a" });
	expect(restarted.clients).toEqual(first.clients);
	first.change((s) => {
		s.larm.baseUrl = "http://127.0.0.1:9811";
	});
	expect(first.made[0]!.closed).toBe(true);
	await first.judge.route(input, signal());
	expect(first.made).toHaveLength(2);
	await Promise.all([first, restarted].map((h) => h.judge.close()));
});
