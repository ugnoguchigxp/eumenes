/** An interaction deadline, not a speech or language classifier. */
export const AUTOMATIC_INPUT_MS = 10_000;
export type InputHold = "edited" | "delayed" | "disconnected" | null;
export type RecognitionCandidate = { id: string };

/** Synchronous ownership checks also fence callbacks scheduled before the next React render. */
export function createInputSession(now = () => performance.now()) {
	let hold: InputHold = null;
	let current: { id: string; endedAt: number | null; done: boolean } | null =
		null;
	const pending = new Map<string, number>();
	let lastSubmitted: string | null = null;
	return {
		reset() {
			hold = null;
			current = null;
			pending.clear();
			lastSubmitted = null;
		},
		begin(id: string) {
			this.expire();
			current = { id, endedAt: null, done: false };
		},
		end(id: string) {
			this.expire();
			current = { id, endedAt: now(), done: false };
			pending.set(id, current.endedAt!);
			lastSubmitted = id;
			if (pending.size > 16) {
				hold ??= "delayed";
				pending.delete(pending.keys().next().value!);
			}
		},
		discardCapture() {
			const id = lastSubmitted;
			current = id
				? { id, endedAt: pending.get(id) ?? now(), done: !pending.has(id) }
				: null;
			return id;
		},
		receive(id: string) {
			this.expire();
			// The current accepted transcript includes the earlier unsent segments.
			if (current?.id === id) {
				current.done = true;
				pending.clear();
			} else pending.delete(id);
		},
		hold(reason: Exclude<InputHold, null>) {
			if (reason === "edited") hold = reason;
			else hold ??= reason;
		},
		expire() {
			if (
				[...pending.values()].some(
					(endedAt) => now() - endedAt >= AUTOMATIC_INPUT_MS,
				)
			)
				hold ??= "delayed";
		},
		canCommit(id: string) {
			this.expire();
			return (
				current?.id === id && current.done && current.endedAt !== null && !hold
			);
		},
		reason() {
			this.expire();
			return hold;
		},
		isRecognizing: () => !!current && current.endedAt !== null && !current.done,
		isCapturing: () => !!current && current.endedAt === null,
		submittedId: () => lastSubmitted,
	};
}
export type InputSession = ReturnType<typeof createInputSession>;
