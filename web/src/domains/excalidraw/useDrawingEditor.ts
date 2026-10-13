import { useDrawingEditorLifecycle } from "./useDrawingEditorLifecycle";
import { reconnectDrawingSession, downloadScene } from "./editor-session";
import { useDrawingSessionStatus } from "./useDrawingSessionStatus";
import { useCallback, useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import type {
	Drawing,
	Scene,
	DrawingSession,
} from "../../../../api/domains/excalidraw/contracts";
import type { DrawingDraft } from "./drafts";
import { useDrawingDraftProtection } from "./useDrawingDraftProtection";
export function useDrawingEditor(
	client: EumenesClient,
	referenceId: string,
	revision?: number,
	conversationId = "main",
) {
	const [drawing, setDrawing] = useState<Drawing | null>(null),
		[session, setSession] = useState<DrawingSession | null>(null);
	const [title, setTitle] = useState(""),
		[status, setStatus] = useState("Excalidrawを準備中です。"),
		[error, setError] = useState("");
	const [busy, setBusy] = useState(true),
		[canvasEpoch, setCanvasEpoch] = useState(0);
	const current = useRef<Drawing | null>(null),
		selected = useRef<DrawingSession | null>(null),
		dirty = useRef(false),
		saving = useRef(false);
	const pending = useRef<DrawingDraft | null>(null),
		latest = useRef<{ title: string; scene: Scene } | null>(null),
		timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activityAt = useRef(0),
		initializing = useRef(true);
	const drafts = useDrawingDraftProtection(
		referenceId,
		current,
		latest,
		pending,
		setError,
	);
	const { hasDraft, protect, check } = drafts;

	const apply = useCallback(
		(doc: Drawing) => {
			initializing.current = true;
			current.current = doc;
			latest.current = { title: doc.title, scene: doc.scene };
			setDrawing(doc);
			setTitle(doc.title);
			setCanvasEpoch((v) => v + 1);
			check();
			setStatus(`保存済み（版 ${doc.revision}）`);
		},
		[check],
	);
	const lifecycle = useDrawingEditorLifecycle({
		client,
		referenceId,
		revision,
		conversationId,
		onReady: (ready, doc) => {
			selected.current = ready;
			setSession(ready);
			apply(doc);
			setBusy(false);
		},
		onError: (message) => {
			setError(message);
			setStatus("起動失敗");
			setBusy(false);
		},
		beforeLeave: () => {
			const unsaved = !!(dirty.current || pending.current || saving.current);
			if (unsaved) protect();
			return unsaved;
		},
		onHide: () => {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			if (selected.current)
				selected.current = { ...selected.current, state: "closed" };
		},
		onResume: reconnect,
		onDispose: () => {
			if (timer.current) clearTimeout(timer.current);
		},
	});
	const receiveStatus = useCallback((value: DrawingSession) => {
		if (
			selected.current?.id !== value.id ||
			selected.current.state === "closed"
		)
			return;
		selected.current = value;
		if (value.state === "idle" && !dirty.current && !saving.current)
			setStatus("無操作のため接続を解放しました。次の操作で復帰します。");
	}, []);
	useDrawingSessionStatus(client, session?.id, receiveStatus);

	const activity = useCallback(async () => {
		const s = selected.current;
		if (!s || Date.now() - activityAt.current < 10000) return;
		activityAt.current = Date.now();
		try {
			if (s.state === "idle") setStatus("再接続中です。");
			await client.drawingActivity(s.id);
			if (s.state === "idle") {
				selected.current = { ...s, state: "ready" };
				setStatus("再接続しました。");
			}
		} catch {
			setStatus(
				"再接続が必要です。編集中の内容を保存またはダウンロードしてください。",
			);
		}
	}, [client]);
	async function save() {
		if (
			saving.current ||
			!dirty.current ||
			!current.current ||
			!latest.current ||
			!selected.current
		)
			return;
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		saving.current = true;
		setBusy(true);
		setStatus("保存中です。");
		const candidate = pending.current ?? {
			...latest.current,
			key: crypto.randomUUID(),
			referenceId,
			expectedRevision: current.current.revision,
		};
		pending.current = candidate;
		protect();
		try {
			const { key } = candidate;
			const body = {
				title: candidate.title,
				scene: candidate.scene,
				expectedRevision: candidate.expectedRevision,
			};
			const doc = await client.saveDrawing(selected.current.id, body, key);
			pending.current = null;
			current.current = doc;
			setSession((s) => (s ? { ...s, revision: doc.revision } : s));
			dirty.current =
				JSON.stringify(latest.current) !==
				JSON.stringify({ title: candidate.title, scene: candidate.scene });
			if (dirty.current) {
				protect();
				setError("");
				setStatus("未保存の変更があります。");
				timer.current = setTimeout(() => void save(), 1000);
			} else {
				drafts.clearSaved();
				setStatus(`保存済み（版 ${doc.revision}）`);
			}
		} catch {
			const preserved = protect();
			setError(
				preserved
					? "保存に失敗しました。下書きを保持しています。「保存」で同じ操作を再送できます。版が競合した場合は編集中の図をダウンロードしてください。"
					: "保存に失敗し、下書きも保持できません。画面を閉じず、編集中の図をダウンロードしてください。",
			);
			setStatus("保存失敗");
		} finally {
			saving.current = false;
			setBusy(false);
		}
	}
	function changeScene(scene: Scene) {
		if (latest.current) change({ title: latest.current.title, scene });
	}
	function changeTitle(title: string) {
		initializing.current = false;
		if (latest.current) change({ title, scene: latest.current.scene });
	}
	function change(next: { title: string; scene: Scene }) {
		if (initializing.current) {
			initializing.current = false;
			latest.current = next;
			return;
		}
		if (JSON.stringify(latest.current) === JSON.stringify(next)) return;
		void activity();
		latest.current = next;
		setTitle(next.title);
		dirty.current = true;
		protect();
		setStatus("未保存の変更があります。");
		if (timer.current) clearTimeout(timer.current);
		// A failed candidate must be retried explicitly with the same key, before newer edits.
		if (!pending.current) timer.current = setTimeout(() => void save(), 1000);
	}
	async function reconnect() {
		const signal = AbortSignal.any([
			lifecycle.signal(),
			AbortSignal.timeout(180000),
		]);
		setBusy(true);
		setError("");
		setStatus("再接続中です。");
		try {
			if (!selected.current) {
				window.location.reload();
				return;
			}
			const s = await reconnectDrawingSession(
				client,
				selected.current,
				{
					referenceId,
					conversationId,
					revision: current.current?.revision ?? revision,
				},
				signal,
				lifecycle.accept,
			);
			selected.current = s;
			setSession(s);
			// Reconnection must never overwrite the unsaved scene in the canvas.
			if (!dirty.current && !pending.current) {
				const doc = await client.drawingDocument(s.id, signal);
				if (!signal.aborted) apply(doc);
			} else setStatus("再接続しました。未保存の図を保存できます。");
		} catch {
			if (signal.aborted) return;
			setError(
				"再接続できませんでした。画面を閉じず、編集中の内容を保存またはダウンロードしてください。",
			);
		} finally {
			setBusy(false);
		}
	}
	function restore() {
		const value = drafts.read();
		if (!value || !current.current) return;
		initializing.current = true;
		pending.current = value.pending ? { ...value.pending, referenceId } : value;
		latest.current = { title: value.title, scene: value.scene };
		dirty.current = true;
		setTitle(value.title);
		setDrawing({ ...current.current, title: value.title, scene: value.scene });
		setCanvasEpoch((v) => v + 1);
		setStatus("下書きを復元しました。保存時に版の競合を確認します。");
	}

	async function close() {
		if (dirty.current || pending.current || saving.current) {
			protect();
			setError(
				"未保存の変更があります。保存またはダウンロードしてから閉じてください。",
			);
			return;
		}
		if (selected.current) await client.releaseDrawing(selected.current.id);
		window.location.hash = "";
	}
	return {
		drawing,
		session,
		title,
		status,
		error,
		busy,
		hasDraft,
		canvasEpoch,
		activity,
		change,
		changeTitle,
		changeScene,
		save,
		reconnect,
		restore,
		download: () => downloadScene(latest.current),
		close,
	};
}
