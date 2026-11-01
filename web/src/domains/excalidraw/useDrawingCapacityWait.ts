import { useCallback } from "react";
import {
	capacityTimeoutMessage,
	capacityWaitingMessage,
} from "@eumenes/design-system";
import { capacityBusyOf, useCapacityWait } from "../../hooks/capacity-wait";

/** The editor's part of the LARM capacity wait: its one timer and the messages it shows. */
export function useDrawingCapacityWait(
	setStatus: (value: string) => void,
	setError: (value: string) => void,
) {
	const { wait, waiting } = useCapacityWait();
	const onWaiting = useCallback(() => {
		setError("");
		setStatus(capacityWaitingMessage);
	}, [setError, setStatus]);
	/**
	 * For a failed start: a capacity refusal starts the wait (`again` is sent once after it) and returns
	 * true; any other error counts the wait anew and returns false.
	 */
	function refused(error: unknown, again: () => void, expiredStatus?: string) {
		const busy = capacityBusyOf(error);
		if (!busy) {
			wait.reset();
			return false;
		}
		if (wait.refuse(busy.retryAfterMs, again) === "waiting") onWaiting();
		else {
			setError(capacityTimeoutMessage);
			if (expiredStatus) setStatus(expiredStatus);
		}
		return true;
	}
	return { wait, waiting, onWaiting, refused };
}
