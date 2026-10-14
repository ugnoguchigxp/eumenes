import { useCallback, useRef, useState, type RefObject } from "react";
import type {
	Drawing,
	Scene,
} from "../../../../api/domains/excalidraw/contracts";
import { drawingDrafts, makeDrawingDraft, type DrawingDraft } from "./drafts";
/** `key` is read at call time: a new drawing's draft id becomes its reference on first save. */
export function useDrawingDraftProtection(
	key: () => string,
	current: RefObject<Drawing | null>,
	latest: RefObject<{ title: string; scene: Scene } | null>,
	pending: RefObject<DrawingDraft | null>,
	setError: (message: string) => void,
) {
	const [hasDraft, setHasDraft] = useState(false);
	// Access can itself throw when browser storage is disabled. Keep it inside guarded calls.
	const drafts = useRef(
		drawingDrafts({
			getItem: (key) => window.sessionStorage.getItem(key),
			setItem: (key, value) => window.sessionStorage.setItem(key, value),
			removeItem: (key) => window.sessionStorage.removeItem(key),
		}),
	);
	const protect = useCallback(() => {
		if (!current.current || !latest.current) return false;
		try {
			drafts.current.write(
				makeDrawingDraft(
					key(),
					current.current.revision,
					latest.current,
					pending.current,
				),
			);
			setHasDraft(true);
			return true;
		} catch {
			setError(
				"下書きをブラウザに保持できません。保存が完了するまで画面を閉じず、編集中の図をダウンロードしてください。",
			);
			return false;
		}
	}, [key, current, latest, pending, setError]);
	const read = useCallback(() => {
		try {
			return drafts.current.read(key());
		} catch {
			setError(
				"下書きを読み込めませんでした。編集中の図をダウンロードして保護してください。",
			);
			return null;
		}
	}, [key, setError]);
	const check = useCallback(() => {
		setHasDraft(!!read());
	}, [read]);
	function clearSaved() {
		try {
			drafts.current.remove(key());
			setHasDraft(false);
			setError("");
		} catch {
			setHasDraft(true);
			setError(
				"図は保存済みですが、ブラウザの下書きを削除できませんでした。古い下書きを復元すると版が競合する場合があります。",
			);
		}
	}
	return { hasDraft, protect, read, check, clearSaved };
}
