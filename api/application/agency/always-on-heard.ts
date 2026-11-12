import type { AgendaScope } from "./always-on-scope";

/** A line no screen began to read aloud within this time counts as said when it appeared. */
export const HEARD_GRACE_MS = 3_000;

/** Words of the agent (a reply, a line of its own) a screen may still be reading aloud. */
export type Unheard = {
	/** The message of the conversation. */
	id: string;
	/** A line of the agent's own (not a reply): it was delivered whatever happens to its message. */
	own: boolean;
	/** When it appeared. */
	at: number;
	/** A screen began to read aloud after it appeared (or was reading already). */
	playing: boolean;
	timer: unknown;
	/** Tells the agent the words were said at `at`. */
	said(at: number): void;
};

/**
 * When the agent's words count as said. The reference host shows a line at once, and the gaps of the agent's pacing
 * run from there; here a screen reads the line aloud, so it is said when the reading ends. Until then the scope does
 * not step (see `busy` of the host). With no screen on the conversation, a line is said when it appears.
 */
export function createAgendaHearing(input: {
	now(): number;
	/** A screen shows the conversation. */
	attended(conversationId: string): boolean;
	/** A screen of the conversation is reading aloud. */
	playing(conversationId: string): boolean;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** The grace of a line ended: the host looks again. */
	wake(): void;
	/** Telling the agent failed (the line is no longer waited for). */
	failed(c: AgendaScope, error: unknown): void;
}) {
	const { now } = input;
	function settle(c: AgendaScope, u: Unheard, at: number) {
		c.unheard = c.unheard.filter((x) => x !== u);
		if (u.timer !== undefined) input.clearTimer(u.timer);
		u.timer = undefined;
		try {
			u.said(Math.max(u.at, at));
		} catch (error) {
			// The screens' reports and the feed go on whatever the agent made of the line.
			input.failed(c, error);
		}
	}
	return {
		/** Words of the agent appeared in the conversation: `said` is called once, with the time they were said. */
		appeared(
			c: AgendaScope,
			{ id, at, own }: Pick<Unheard, "id" | "at" | "own">,
			said: (at: number) => void,
		) {
			if (!input.attended(c.id)) {
				said(at);
				return;
			}
			const u: Unheard = {
				id,
				own,
				at,
				playing: input.playing(c.id),
				timer: undefined,
				said,
			};
			c.unheard.push(u);
			if (!u.playing)
				u.timer = input.setTimer(() => {
					u.timer = undefined;
					input.wake();
				}, HEARD_GRACE_MS);
		},
		/** The screens' activity changed, or a grace ended. True when a line was said. */
		check(c: AgendaScope): boolean {
			if (!c.unheard.length) return false;
			const playing = input.playing(c.id);
			const attended = input.attended(c.id);
			let said = false;
			for (const u of c.unheard) {
				if (playing) {
					u.playing = true;
					continue;
				}
				// Read to its end; or nobody read it (no auto speech, muted, the screen left).
				if (u.playing) settle(c, u, now());
				else if (!attended || u.timer === undefined) settle(c, u, u.at);
				else continue;
				said = true;
			}
			return said;
		},
		/** The user spoke, a reply begins or the host closes: what was being read counts as said now. */
		flush(c: AgendaScope, at: number) {
			for (const u of c.unheard) settle(c, u, Math.min(at, now()));
		},
		/** A reply was corrected or retracted before it was heard: the agent is not told of the old words. */
		drop(c: AgendaScope, id: string) {
			const gone = c.unheard.filter((u) => u.id === id && !u.own);
			for (const u of gone) {
				if (u.timer !== undefined) input.clearTimer(u.timer);
				u.timer = undefined;
			}
			c.unheard = c.unheard.filter((u) => !gone.includes(u));
		},
		/** The scope goes: its timers with it. */
		dispose(c: AgendaScope) {
			for (const u of c.unheard)
				if (u.timer !== undefined) input.clearTimer(u.timer);
			c.unheard = [];
		},
	};
}
export type AgendaHearing = ReturnType<typeof createAgendaHearing>;
