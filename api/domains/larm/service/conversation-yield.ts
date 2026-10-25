/**
 * Background calls on the conversation's connection (the ContextWindow layout specification, section 8.2): they
 * yield to the user. A conversation call or speech being transcribed aborts them (`larm_preempted`).
 */
export function createConversationYield() {
	const running = new Set<AbortController>();
	return {
		/** A background call's own abort, held while it runs. */
		enter() {
			const controller = new AbortController();
			running.add(controller);
			return {
				signal: controller.signal,
				leave: () => running.delete(controller),
			};
		},
		preempt() {
			for (const controller of running)
				controller.abort(new Error("larm_preempted"));
		},
	};
}
