import { useCallback, useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import type { DrawingSession } from "../../../../api/domains/excalidraw/contracts";
import { useDrawingSessionStatus } from "./useDrawingSessionStatus";

/**
 * Follows the persisted session status and renews the lease on a canvas gesture. While LARM has no free
 * memory (`waiting`) no gesture sends anything: only the wait timer connects again.
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
		waiting: () => boolean;
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
		const { selected, adopt, waiting, setStatus } = latest.current;
		const s = selected();
		if (!s || waiting() || Date.now() - activityAt.current < 10000) return;
		activityAt.current = Date.now();
		try {
			if (s.state === "idle") setStatus("再接続中です。");
			await client.drawingActivity(s.id);
			if (s.state === "idle") {
				adopt({ ...s, state: "ready" });
				setStatus("再接続しました。");
			}
		} catch {
			setStatus(
				"再接続が必要です。編集中の内容を保存またはダウンロードしてください。",
			);
		}
	}, [client]);
}
