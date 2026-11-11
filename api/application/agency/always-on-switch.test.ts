import { expect, test } from "bun:test";
import { agendaFixture, composeSay } from "./always-on.fixture";
import { createSwitchingAgencyHost } from "./switching-host";
import { waitFor, settle } from "../../infrastructure/wait-for";
import { isAgendaSnapshot } from "../../domains/dialogue";

test("switching drains the old plan before starting F and can return to one always-on owner", async () => {
	const pending = Promise.withResolvers<unknown>();
	const f = await agendaFixture({
		script: (kind, _request, n) =>
			kind === "plan" && n === 1
				? pending.promise
				: kind === "compose"
					? composeSay("stale after switch")
					: undefined,
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
		await checked("first plan", () => f.requests.length === 1);
		await apply("F");
		await checked("abort old plan", () => f.signals[0]!.aborted);
		pending.resolve({
			add: [
				{
					kind: "talk",
					text: "stale",
					refs: ["a"],
					value: 5,
					reason: "fixture",
					topic: "stale",
				},
			],
			drop: [],
			focus: "",
		});
		await checked("F attention", async () => {
			try {
				await host.attend("ao");
				return (
					!!host.inspect("ao") &&
					!isAgendaSnapshot(host.inspect("ao")!.snapshot)
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
				return isAgendaSnapshot(host.inspect("ao")!.snapshot);
			} catch {
				return false;
			}
		});
		await f.user("b");
		await settle();
		await f.advance();
		await waitFor(() => f.requests.length === 2 && !host.status("ao").busy);
		expect(f.kinds).toEqual(["plan", "plan"]);
	} finally {
		pending.resolve({ add: [], drop: [], focus: "" });
		await host.close();
		await f.close();
	}
});
