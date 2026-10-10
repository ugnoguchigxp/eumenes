import { type ExtractionHandler } from "./extraction-types";
import {
	SLOT_BUSY,
	FOREGROUND_CANCELLED,
	FOREGROUND_UNCONFIRMED,
} from "./extraction-shared";
import type { ExtractionCtx } from "./extraction-ctx";

export function createExecute(
	ctx: ExtractionCtx,
): Pick<ExtractionHandler, "execute" | "classify"> {
	const {
		options,
		inference,
		budgetMs,
		confirmMs,
		hook,
		foregroundActive,
		slotListeners,
		slot,
	} = ctx;

	return {
		async execute(input, context) {
			// Concurrency 1 at this layer too: an earlier call that was cancelled
			// but never confirmed still occupies the Local slot.
			if (slot.inFlight) throw new Error(SLOT_BUSY);
			// The foreground may have started between prepare and now: do not even
			// start the model call.
			if (foregroundActive()) throw new Error(FOREGROUND_CANCELLED);
			const budget = AbortSignal.timeout(budgetMs);
			const foreground = new AbortController();
			// A foreground start cancels the running call at once (no polling, no sleep).
			const unsubscribe = options.foreground?.subscribe?.(() => {
				if (foregroundActive())
					foreground.abort(new Error(FOREGROUND_CANCELLED));
			});
			const signal = AbortSignal.any([
				context.signal,
				budget,
				foreground.signal,
			]);
			const call = inference.executeControl(
				input.requestId,
				input.messages,
				signal,
			);
			const settled = call.then(
				() => undefined,
				() => undefined,
			);
			slot.inFlight = settled;
			void settled.then(() => {
				unsubscribe?.();
				if (slot.inFlight === settled) {
					slot.inFlight = null;
					// Only a call that REALLY ended frees the slot; tell whoever waits for it.
					for (const listener of slotListeners) {
						try {
							listener();
						} catch {
							// a listener never disturbs the handler
						}
					}
				}
			});
			// Cancel -> confirm: after the budget the call must END (confirmed)
			// before this attempt is reported as timed out.
			const confirmation = new Promise<"unconfirmed">((resolve) => {
				const start = () => {
					const timer = setTimeout(() => resolve("unconfirmed"), confirmMs);
					timer.unref?.();
					void settled.then(() => clearTimeout(timer));
				};
				if (signal.aborted) start();
				else signal.addEventListener("abort", start, { once: true });
			});
			try {
				const receipt = await Promise.race([
					call,
					confirmation.then(() => {
						throw new Error(
							foreground.signal.aborted && !context.signal.aborted
								? FOREGROUND_UNCONFIRMED
								: "extract_cancel_unconfirmed",
						);
					}),
				]);
				hook("executed", input.jobId);
				const value = receipt.value;
				return {
					receipt,
					text:
						typeof value === "string" ? value : new TextDecoder().decode(value),
				};
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message === "extract_cancel_unconfirmed" ||
						error.message === FOREGROUND_UNCONFIRMED)
				)
					throw error;
				// The foreground wins over the budget when both fired: the input is
				// not at fault and no failure is counted.
				if (foreground.signal.aborted && !context.signal.aborted)
					throw new Error(FOREGROUND_CANCELLED);
				if (budget.aborted && !context.signal.aborted)
					throw new Error("extract_timeout");
				throw error;
			}
		},

		classify(error) {
			// A cancel nobody confirmed is final for this job (the slot stays held
			// until the provider really ends the call). A cancel the provider
			// confirmed for the foreground is retried as a NEW attempt.
			return error instanceof Error &&
				(error.message === "extract_cancel_unconfirmed" ||
					error.message === FOREGROUND_UNCONFIRMED)
				? "fail"
				: "retry";
		},
	};
}
