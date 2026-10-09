import { expect, test } from "vitest";
import {
	createVoiceMachine,
	initialVoiceState,
	isCurrent,
	reduce,
	type VoiceEvent,
} from "../hooks/machine";

function run(...events: VoiceEvent[]) {
	return events.reduce(reduce, initialVoiceState);
}
const open = (token = 1, sessionToken = 10): VoiceEvent[] => [
	{ type: "start_requested", token },
	{ type: "session_opened", token, sessionToken, id: "s", generation: 1 },
	{ type: "start_settled", token },
];

test("a session starts, becomes active and ignores a second start", () => {
	const starting = run({ type: "start_requested", token: 1 });
	expect(starting.phase).toBe("starting");
	expect(reduce(starting, { type: "start_requested", token: 2 })).toBe(
		starting,
	);
	const active = run(...open());
	expect(active.phase).toBe("active");
	expect(active.session).toMatchObject({ id: "s", sequence: 0, pending: 0 });
});

test("stopping during a start cancels it: the late settle changes nothing", () => {
	const stopped = run(
		{ type: "start_requested", token: 1 },
		{ type: "stopped" },
		{
			type: "session_opened",
			token: 1,
			sessionToken: 1,
			id: "s",
			generation: 1,
		},
	);
	expect(stopped.session).toBeNull();
	expect(reduce(stopped, { type: "start_settled", token: 1 }).phase).toBe(
		"idle",
	);
});

test("an accepted segment becomes the current turn and clears delivered chunks", () => {
	const state = run(
		...open(),
		{ type: "delivered_marked", key: "old:0" },
		{ type: "segment_accepted", utteranceId: "u1" },
	);
	expect(state.current).toBe("u1");
	expect(state.delivered.size).toBe(0);
	expect(state.session).toMatchObject({ sequence: 1, pending: 1 });
	expect(isCurrent(state, 10, "u1")).toBe(true);
	expect(isCurrent(state, 10, "u0")).toBe(false);
});

test("barge-in over playing audio drops the player and releases the turn", () => {
	const base = run(
		...open(),
		{ type: "segment_accepted", utteranceId: "u1" },
		{ type: "player_installed", id: "u1" },
	);
	const interrupted = [
		{ type: "playback_cancelled" },
		{ type: "turn_released" },
	].reduce((state, event) => reduce(state, event as VoiceEvent), base);
	expect(interrupted.player).toBeNull();
	expect(interrupted.current).toBeNull();
	expect(interrupted.epoch).toBeGreaterThan(base.epoch);
	// Candidate speech over silence keeps the turn that is still being awaited.
	const silent = reduce(base, { type: "playback_cancelled" });
	expect(silent.player).toBeNull();
	expect(silent.current).toBe("u1");
});

test("a stale chunk queue is recognised by its epoch after a newer install or cancel", () => {
	const first = run(...open(), { type: "player_installed", id: "u1" });
	const queueEpoch = first.player!.epoch;
	const replaced = reduce(first, { type: "player_installed", id: "u2" });
	expect(replaced.player!.epoch).not.toBe(queueEpoch);
	const cancelled = reduce(first, { type: "playback_cancelled" });
	expect(cancelled.player).toBeNull();
});

test("chunks and utterances are delivered once", () => {
	const once = run({ type: "delivered_marked", key: "u1:0" });
	expect(reduce(once, { type: "delivered_marked", key: "u1:0" })).toBe(once);
	expect(once.delivered.has("u1:0")).toBe(true);
});

test("a failed upload restores the previous turn, fails the session and drops stale uploads of other sessions", () => {
	const state = run(
		...open(),
		{ type: "segment_accepted", utteranceId: "u1" },
		{ type: "segment_accepted", utteranceId: "u2" },
		{ type: "player_installed", id: "u1" },
	);
	const failed = reduce(state, {
		type: "upload_failed",
		sessionToken: 10,
		previous: "u1",
	});
	expect(failed.session?.failed).toBe(true);
	expect(failed.current).toBe("u1");
	expect(failed.player).toEqual(state.player);
	expect(
		reduce(state, { type: "upload_failed", sessionToken: 99, previous: null }),
	).toBe(state);
	const settled = reduce(failed, { type: "upload_settled", sessionToken: 10 });
	expect(settled.session?.pending).toBe(1);
	expect(reduce(failed, { type: "upload_settled", sessionToken: 99 })).toBe(
		failed,
	);
});

test("muting releases the turn without touching the player", () => {
	const state = run(
		...open(),
		{ type: "segment_accepted", utteranceId: "u1" },
		{ type: "player_installed", id: "u1" },
	);
	const released = reduce(state, { type: "turn_released" });
	expect(released.current).toBeNull();
	expect(released.player).toEqual(state.player);
});

test("stop returns to idle and the machine serves synchronous reads", () => {
	const machine = createVoiceMachine();
	for (const event of open()) machine.dispatch(event);
	machine.dispatch({ type: "segment_accepted", utteranceId: "u1" });
	expect(machine.get().session?.pending).toBe(1);
	machine.dispatch({ type: "stopped" });
	expect(machine.get()).toMatchObject({
		phase: "idle",
		session: null,
		current: null,
	});
});
