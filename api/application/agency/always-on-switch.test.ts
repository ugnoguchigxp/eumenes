import { expect, test } from "bun:test";
import { alwaysOnFixture, thinkWait } from "./always-on.fixture";
import { createSwitchingAgencyHost } from "./switching-host";
import { waitFor, settle } from "../../infrastructure/wait-for";
import { isAlwaysOnSnapshot } from "../../domains/dialogue";

test("switching drains old think before starting F and can return to one always-on owner", async () => {
	const pending = Promise.withResolvers<ReturnType<typeof thinkWait>>();
	const f = await alwaysOnFixture({
		reply: (_r, n) => (n === 1 ? pending.promise : thinkWait()),
	});
	const host = createSwitchingAgencyHost(f.deps);
	const checked = async (
		name: string,
		condition: () => boolean | Promise<boolean>,
	) => {
		try {
			await waitFor(condition, { timeout: 1000 });
		} catch {
			throw new Error(`switch_phase:${name}`);
		}
	};
	const apply = async (runtime: "F" | "always-on") => {
		const settings = f.h.settings.get();
		settings.agency.runtime = runtime;
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
	};
	try {
		await host.recover();
		host.start();
		await host.attend("ao");
		await f.user("a");
		await f.advance();
		await checked("first think", () => f.requests.length === 1);
		await apply("F");
		await checked("abort old think", () => f.signals[0]!.aborted);
		pending.resolve({
			...thinkWait(),
			action: {
				kind: "speak",
				utterance: "stale after switch",
				toolName: null,
				toolInput: null,
				evidenceRefs: [],
			},
		});
		await checked("F attention", async () => {
			try {
				await host.attend("ao");
				return (
					!!host.inspect("ao") &&
					!isAlwaysOnSnapshot(host.inspect("ao")!.snapshot)
				);
			} catch {
				return false;
			}
		});
		expect(
			f.h.conversation
				.get("ao")
				.messages.some((m) => m.text === "stale after switch"),
		).toBe(false);
		await apply("always-on");
		await checked("AO attend", async () => {
			try {
				await host.attend("ao");
				return isAlwaysOnSnapshot(host.inspect("ao")!.snapshot);
			} catch {
				return false;
			}
		});
		await f.user("b");
		await settle();
		await f.advance();
		await waitFor(() => f.requests.length === 2 && !host.status("ao").busy);
		expect(f.requests.map((r) => r.purpose)).toEqual(["think", "think"]);
	} finally {
		pending.resolve(thinkWait());
		await host.close();
		await f.close();
	}
});
