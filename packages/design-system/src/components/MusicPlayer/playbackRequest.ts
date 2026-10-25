/**
 * Starting playback from code (a screen command, a resource chip) without a click on the
 * player: mounted players register here, a request finds the one showing the track and
 * starts it. The promise rejects with the media element's own error, so a browser that
 * refuses to play without a user gesture shows up as `NotAllowedError`.
 */
type PlayerEntry = { trackId: string; start: () => Promise<void> };

const players: PlayerEntry[] = [];
const waiting = new Set<() => void>();

export const PLAYER_WAIT_MS = 8_000;

/** Registers a mounted player; returns the removal. */
export function registerPlayer(entry: PlayerEntry): () => void {
	players.push(entry);
	for (const wake of waiting) wake();
	return () => {
		const index = players.indexOf(entry);
		if (index >= 0) players.splice(index, 1);
	};
}

/** The most recently mounted player of the track (or any player when no track is named). */
function findPlayer(trackId: string | undefined) {
	for (let i = players.length - 1; i >= 0; i--) {
		const player = players[i]!;
		if (trackId === undefined || player.trackId === trackId) return player;
	}
	return undefined;
}

/**
 * Starts the player showing `trackId`, waiting for it to mount (its audio may still be loading).
 * Rejects with `Error("player_unavailable")` when none appears in time.
 */
export function requestPlayback(
	trackId?: string,
	timeoutMs = PLAYER_WAIT_MS,
): Promise<void> {
	const found = findPlayer(trackId);
	if (found) return found.start();
	return new Promise<void>((resolve, reject) => {
		const finish = (action: () => void) => {
			clearTimeout(timer);
			waiting.delete(check);
			action();
		};
		const check = () => {
			const player = findPlayer(trackId);
			if (player) finish(() => player.start().then(resolve, reject));
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error("player_unavailable"))),
			timeoutMs,
		);
		waiting.add(check);
	});
}
