import { expect, test } from "bun:test";
import { agendaFixture } from "./always-on.fixture";
import { createAlwaysOnHost } from "./always-on-host";
import { createRebuildingAgencyHost } from "./rebuilding-host";
import { agendaSettingsKey } from "./always-on-settings";
import { waitFor, settle } from "../../infrastructure/wait-for";
import type { Settings } from "../../domains/settings";

type Change = [name: string, mutate: (settings: Settings) => void];

/** The settings the always-on host reads: a saved change of one of them makes the next host. */
const rebuilding: Change[] = [
	[
		"agency.thinkResourceId",
		(s) => void (s.agency.thinkResourceId = crypto.randomUUID()),
	],
	["agency.speechIntervalSec", (s) => void (s.agency.speechIntervalSec = 60)],
	["agency.interests", (s) => void (s.agency.interests = ["旅行"])],
	["agency.emotion", (s) => void (s.agency.emotion = !s.agency.emotion)],
	[
		"agency.actions.enabled",
		(s) =>
			void (s.agency.actions = {
				enabled: !(s.agency.actions?.enabled ?? true),
				maxConcurrent: 1,
				dailyLimit: 3,
			}),
	],
	["general.agentName", (s) => void (s.general.agentName = "別の名前")],
	["general.userName", (s) => void (s.general.userName = "別の呼び名")],
	["general.persona", (s) => void (s.general.persona = "sage")],
];

/** Everything else the settings hold: the host does not read it, so its state in memory stays. */
const kept: Change[] = [
	["general.reasoningEffort", (s) => void (s.general.reasoningEffort = "high")],
	["general.theme", (s) => void (s.general.theme = "dark")],
	["general.asrLanguages", (s) => void (s.general.asrLanguages = ["en"])],
	["general.subtitles", (s) => void (s.general.subtitles.enabled = false)],
	["agency.debugMode", (s) => void (s.agency.debugMode = true)],
	[
		"agency.actions.maxConcurrent / dailyLimit",
		(s) =>
			void (s.agency.actions = {
				enabled: s.agency.actions?.enabled ?? true,
				maxConcurrent: 4,
				dailyLimit: 40,
			}),
	],
	["world.enabled", (s) => void (s.world.enabled = !s.world.enabled)],
	["router", (s) => void (s.router.structureTimeoutMs += 1000)],
	["larm.baseUrl", (s) => void (s.larm.baseUrl = "http://localhost:9")],
	["voice.outputVolume", (s) => void (s.voice.outputVolume = 0.3)],
];

test("each section of the settings is fixed as rebuilding the always-on host or leaving it running", async () => {
	const f = await agendaFixture();
	let made = 0;
	const host = createRebuildingAgencyHost(f.deps, (deps) => {
		made++;
		return createAlwaysOnHost(deps);
	});
	const apply = async (mutate: Change[1]) => {
		const settings = f.h.settings.get();
		mutate(settings);
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		await settle();
	};
	try {
		await host.recover();
		host.start();
		await host.attend("ao");
		expect(made).toBe(1);
		for (const [name, mutate] of kept) {
			const before = made;
			const key = agendaSettingsKey(f.h.settings.get());
			await apply(mutate);
			// A change that is not the host's leaves the key as it was, and the host is not made again.
			expect(agendaSettingsKey(f.h.settings.get()), name).toBe(key);
			expect(made, name).toBe(before);
		}
		for (const [name, mutate] of rebuilding) {
			const before = made;
			const key = agendaSettingsKey(f.h.settings.get());
			await apply(mutate);
			expect(agendaSettingsKey(f.h.settings.get()), name).not.toBe(key);
			await waitFor(() => made === before + 1);
			expect(made, name).toBe(before + 1);
			// The next host serves at once.
			expect((await host.attend("ao")).activeConversationId).toBe("ao");
		}
		// Saving a setting again as it was is no change at all.
		const before = made;
		await apply(() => {});
		expect(made).toBe(before);
	} finally {
		await host.close();
		await f.close();
	}
});

test("a closed host is not rebuilt by a later change", async () => {
	const f = await agendaFixture();
	let made = 0;
	const host = createRebuildingAgencyHost(f.deps, (deps) => {
		made++;
		return createAlwaysOnHost(deps);
	});
	try {
		await host.recover();
		host.start();
		const settings = f.h.settings.get();
		settings.general.agentName = "改名後";
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		await waitFor(() => made === 2);
		await host.close();
		const closed = f.h.settings.get();
		closed.general.persona = "maid";
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: closed.revision,
			settings: closed,
			keys: [],
		});
		await settle();
		expect(made).toBe(2);
	} finally {
		await f.close();
	}
});
