/**
 * Bookkeeping for one voice dialogue, as a pure reducer. React state shows the
 * result; refs hold only handles that live outside React (AudioContext,
 * AbortControllers, promise tails). Every "is this callback still current?"
 * question is answered from this state, so stale work is dropped in one place.
 *
 * Transition table (event → effect on state):
 *
 *   start_requested   idle → starting                 (ignored unless idle)
 *   session_opened    starting → starting + session   (token identifies the session)
 *   start_settled     starting → active | idle        (only for the start in flight)
 *   stopped           any → idle                      (session, current, player cleared)
 *   segment_accepted  sequence++, pending++, current = utterance, delivered cleared
 *   upload_settled    pending--                       (only for the same session)
 *   upload_failed     session failed, current = previous utterance
 *   playback_cancelled player cleared, epoch++        (barge-in, failure, mute, stop)
 *   turn_released     current cleared                 (mute, barge-in over audio, failure)
 *   player_installed  player = this utterance's chunk queue (fresh epoch)
 *   delivered_marked  key added to delivered (dedupes chunks and whole utterances)
 */
export type Session = {
	/** Unique per opened session; closures compare it to detect a stale session. */
	token: number;
	id: string;
	generation: number;
	sequence: number;
	pending: number;
	failed: boolean;
};
export type VoicePhase = "idle" | "starting" | "active";
export type VoiceState = {
	phase: VoicePhase;
	/** The start in flight, 0 when none. */
	startToken: number;
	session: Session | null;
	/** The utterance being awaited or played. */
	current: string | null;
	delivered: ReadonlySet<string>;
	player: { id: string; epoch: number } | null;
	/** Bumps whenever the player is replaced or cancelled. */
	epoch: number;
};
export type VoiceEvent =
	| { type: "start_requested"; token: number }
	| {
			type: "session_opened";
			token: number;
			sessionToken: number;
			id: string;
			generation: number;
	  }
	| { type: "start_settled"; token: number }
	| { type: "stopped" }
	| { type: "segment_accepted"; utteranceId: string }
	| { type: "upload_settled"; sessionToken: number }
	| { type: "upload_failed"; sessionToken: number; previous: string | null }
	| { type: "playback_cancelled" }
	| { type: "turn_released" }
	| { type: "player_installed"; id: string }
	| { type: "delivered_marked"; key: string };

export const initialVoiceState: VoiceState = {
	phase: "idle",
	startToken: 0,
	session: null,
	current: null,
	delivered: new Set(),
	player: null,
	epoch: 0,
};

const cancelled = (state: VoiceState): VoiceState => ({
	...state,
	player: null,
	epoch: state.epoch + 1,
});

export function reduce(state: VoiceState, event: VoiceEvent): VoiceState {
	switch (event.type) {
		case "start_requested":
			if (state.phase !== "idle") return state;
			return { ...state, phase: "starting", startToken: event.token };
		case "session_opened":
			if (state.startToken !== event.token) return state;
			return {
				...state,
				session: {
					token: event.sessionToken,
					id: event.id,
					generation: event.generation,
					sequence: 0,
					pending: 0,
					failed: false,
				},
			};
		case "start_settled":
			if (state.startToken !== event.token) return state;
			return {
				...state,
				startToken: 0,
				phase: state.session ? "active" : "idle",
			};
		case "stopped":
			return {
				...cancelled(state),
				phase: "idle",
				startToken: 0,
				session: null,
				current: null,
			};
		case "segment_accepted":
			if (!state.session) return state;
			return {
				...state,
				session: {
					...state.session,
					sequence: state.session.sequence + 1,
					pending: state.session.pending + 1,
				},
				current: event.utteranceId,
				delivered: new Set(),
			};
		case "upload_settled":
			if (state.session?.token !== event.sessionToken) return state;
			return {
				...state,
				session: { ...state.session, pending: state.session.pending - 1 },
			};
		case "upload_failed":
			if (state.session?.token !== event.sessionToken) return state;
			return {
				...state,
				session: { ...state.session, failed: true },
				current: event.previous,
			};
		case "playback_cancelled":
			return cancelled(state);
		case "turn_released":
			return { ...state, current: null };
		case "player_installed":
			return {
				...state,
				epoch: state.epoch + 1,
				player: { id: event.id, epoch: state.epoch + 1 },
			};
		case "delivered_marked":
			if (state.delivered.has(event.key)) return state;
			return { ...state, delivered: new Set(state.delivered).add(event.key) };
	}
}

/** Work started for `sessionToken` / `utteranceId` may still act on the world. */
export function isCurrent(
	state: VoiceState,
	sessionToken: number,
	utteranceId?: string,
): boolean {
	return (
		state.session?.token === sessionToken &&
		(utteranceId === undefined || state.current === utteranceId)
	);
}

/** A tiny synchronous store: refs hold it, React state mirrors what the UI needs. */
export function createVoiceMachine() {
	let state = initialVoiceState;
	return {
		get: () => state,
		dispatch(event: VoiceEvent): VoiceState {
			state = reduce(state, event);
			return state;
		},
	};
}
export type VoiceMachine = ReturnType<typeof createVoiceMachine>;
