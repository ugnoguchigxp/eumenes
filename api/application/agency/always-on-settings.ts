import { fixedInput } from "./input";
import type { AgencySettings, HostPersona } from "./host-types";

/**
 * The settings the always-on host reads, and nothing else. A saved settings change rebuilds the host (its state in
 * memory is dropped) only when this key moves, and the host's own digest (what a checkpoint and a speech line are
 * checked against) is this key: a setting the host does not read cannot stale either.
 *
 * Every read of `deps.settings` in the agenda path is here:
 * - `agency.thinkResourceId`: the connection of the agenda's own calls (the scope and the goal steps).
 * - `agency.speechIntervalSec`: how soon the agent may speak again (given to the agent when its scope is made).
 * - `agency.interests`: the standing interests in the agent's persona and in the reply's system.
 * - `agency.emotion`: whether a reply and a line carry a feeling.
 * - `agency.actions.enabled`: whether the agenda may start work (shown in the status, and the dialogue's budget).
 * - `general.agentName`, `general.userName`, `general.persona`: the agent's voice.
 * `agency.debugMode`, `agency.actions.maxConcurrent/dailyLimit` and every
 * other section (the thinking level, the voice, the screen, connections, the router, the world) are read by other
 * parts at the time they are used, never captured here.
 */
export function agendaSettings(settings: {
	agency: AgencySettings;
	general: HostPersona;
}) {
	const { agency, general } = settings;
	return {
		thinkResourceId: agency.thinkResourceId ?? null,
		speechIntervalSec: agency.speechIntervalSec ?? null,
		interests: agency.interests,
		emotion: agency.emotion,
		actionsEnabled: agency.actions?.enabled ?? true,
		agentName: general.agentName,
		userName: general.userName,
		persona: general.persona,
	};
}

export const agendaSettingsKey = (settings: {
	agency: AgencySettings;
	general: HostPersona;
}) => fixedInput(agendaSettings(settings)).sources[0]!;
