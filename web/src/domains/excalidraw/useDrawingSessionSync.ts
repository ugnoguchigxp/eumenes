import { useCallback, useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import type { DrawingSession } from "../../../../api/domains/excalidraw/contracts";
import type { createCapacityWait } from "../../hooks/capacity-wait";
import { useDrawingSessionStatus } from "./useDrawingSessionStatus";

/**
 * Follows the persisted session status and renews the lease on a canvas gesture. While LARM has no free
 * memory (`wait.waiting()`) no gesture sends anything: only the wait timer connects again, and a gesture
 * LARM refuses starts that timer.
 */
export function useDrawingSessionSync(
	client: EumenesClient,
	input: {
		session: DrawingSession | null;
		/** The session the editor holds, read when a status or gesture arrives. */
		selected: () => DrawingSession | null;
		/** Replaces the session the editor holds. */
		adopt: (value: DrawingSession) => void;
		/** Unsaved or saving work: an idle release is then not announced. */
		editing: () => boolean;
		wait: ReturnType<typeof createCapacityWait>;
		/** Starts the capacity wait for a refusal, sending `again` once after it; false for any other error. */
		refused: (error: unknown, again: () => void) => boolean;
		setStatus: (value: string) => void;
	},
) {
	const latest = useRef(input);
	const activityAt = useRef(0);
	useEffect(() => {
		latest.current = input;
	});
	const receiveStatus = useCallback((value: DrawingSession) => {
		const { selected, adopt, editing, setStatus } = latest.current;
		const held = selected();
		if (held?.id !== value.id || held.state === "closed") return;
		adopt(value);
		if (value.state === "idle" && !editing())
			setStatus("無操作のため接続を解放しました。次の操作で復帰します。");
	}, []);
	useDrawingSessionStatus(client, input.session?.id, receiveStatus);

	return useCallback(async () => {
		async function send(afterWait = false): Promise<void> {
			const { selected, adopt, wait, refused, setStatus } = latest.current;
			const s = selected();
			if (!s || wait.waiting() || Date.now() - activityAt.current < 10000)
				return;
			activityAt.current = Date.now();
			try {
				if (s.state === "idle") setStatus("再接続中です。");
				await client.drawingActivity(s.id);
				wait.reset();
				// The wait message must not outlive the wait, even when the session was not idle.
				if (s.state === "idle" || afterWait) {
					adopt({ ...s, state: "ready" });
					setStatus("再接続しました。");
				}
			} catch (error) {
				// The one timer sends the same activity again; a gesture meanwhile sends nothing.
				if (
					refused(error, () => {
						activityAt.current = 0;
						void send(true);
					})
				)
					return;
				setStatus(
					"再接続が必要です。編集中の内容を保存またはダウンロードしてください。",
				);
			}
		}
		return send();
	}, [client]);
}
