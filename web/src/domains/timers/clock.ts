export type ClockSnapshot = {
	dueAt: string;
	serverNow: string;
	state: "active" | "elapsed" | "cancelled";
	cancelledAt: string | null;
};

/** Estimated server time from one snapshot. Display ticks must not call the API. */
export function bindServerClock(
	serverNow: string,
	sentAt: number,
	receivedAt: number,
) {
	const parsed = Date.parse(serverNow);
	const baseServer = parsed + (receivedAt - sentAt) / 2;
	return { baseServer, baseMono: receivedAt };
}

export function estimatedServerNow(
	clock: { baseServer: number; baseMono: number },
	monoNow: number,
) {
	return clock.baseServer + (monoNow - clock.baseMono);
}

export function displayRemainingSeconds(
	snapshot: ClockSnapshot,
	estimatedNow: number,
): number {
	if (snapshot.state === "elapsed") return 0;
	const basis =
		snapshot.state === "cancelled"
			? Date.parse(snapshot.cancelledAt ?? snapshot.serverNow)
			: estimatedNow;
	const due = Date.parse(snapshot.dueAt);
	if (!Number.isFinite(due) || !Number.isFinite(basis)) return 0;
	return Math.max(0, Math.ceil((due - basis) / 1000));
}
