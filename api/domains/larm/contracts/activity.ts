/** What a recorder knows about LARM calls that leave no attempt record (attitude judge, embedding). */
export type ActivityObservation = {
	running: number;
	lastSuccessAt: number | null;
	lastFailure: { at: number; reason: string } | null;
};
export type ActivityRecorder = {
	/** Runs the call and records its outcome; a cancelled call records nothing, a timed-out one is a failure. */
	track<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T>;
	observe(): ActivityObservation;
};
