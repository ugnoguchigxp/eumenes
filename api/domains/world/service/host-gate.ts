/**
 * The host-side startup gate of World. It starts CLOSED when a lifecycle
 * (journal + restore) is wired in and is opened only by a successful
 * `recoverWorld()`; any failure keeps (or puts) it closed. While closed,
 * only protective operations (forget, invalidate, restore) and Memory-side
 * work run: nothing reads or writes World content. This is separate from
 * World's own per-Scope gate inside the database.
 */
export type WorldHostGate = {
	isOpen(): boolean;
	/** Why it is closed, or null while open. */
	reason(): string | null;
	close(reason: string): void;
	open(): void;
};

export function createWorldHostGate(
	initial: "open" | "closed" = "closed",
): WorldHostGate {
	let reason: string | null = initial === "closed" ? "RECOVERY_REQUIRED" : null;
	return {
		isOpen: () => reason === null,
		reason: () => reason,
		close(next) {
			reason = next;
		},
		open() {
			reason = null;
		},
	};
}
