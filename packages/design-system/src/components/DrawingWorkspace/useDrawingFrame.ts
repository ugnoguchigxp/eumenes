import { useEffect, useRef, useState } from "react";
import {
	isDrawingFrameOf,
	isDrawingFrameState,
	type DrawingFrameCommand,
	type DrawingFrameState,
} from "./frame-protocol";

/** Keep an unsaved editor mounted when another result is offered or a tab is closed. */
export function useDrawingFrame(url: string | undefined, refresh: () => void) {
	const root = useRef<HTMLElement>(null);
	const iframe = useRef<HTMLIFrameElement>(null);
	const [displayed, setDisplayed] = useState<string>();
	const [state, setState] = useState<DrawingFrameState>();
	const [error, setError] = useState("");
	const callbacks = useRef(refresh);
	const version = useRef<number | undefined>(undefined);
	const waiting = useRef(new Map<string, (allowed: boolean) => void>());
	useEffect(() => {
		callbacks.current = refresh;
	}, [refresh]);
	function send(
		action: DrawingFrameCommand["action"],
		value?: string,
		requestId = crypto.randomUUID(),
	) {
		iframe.current?.contentWindow?.postMessage(
			{ type: "eumenes:drawing-command", action, requestId, value },
			window.location.origin,
		);
		return requestId;
	}
	async function leave() {
		if (!iframe.current || !state?.loaded) return true;
		const requestId = crypto.randomUUID();
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				waiting.current.delete(requestId);
				setError("編集画面を確認できません。再接続してから操作してください。");
				resolve(false);
			}, 4000);
			waiting.current.set(requestId, (allowed) => {
				clearTimeout(timer);
				if (!allowed)
					setError(
						"未保存の変更があります。保存またはダウンロードしてから操作してください。",
					);
				else setError("");
				resolve(allowed);
			});
			send("leave", undefined, requestId);
		});
	}
	const controls = useRef({ leave });
	useEffect(() => {
		controls.current = { leave };
	});
	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (
				event.origin !== window.location.origin ||
				event.source !== iframe.current?.contentWindow
			)
				return;
			const value: unknown = event.data;
			if (isDrawingFrameState(value)) {
				if (!isDrawingFrameOf(iframe.current, value.referenceId)) return;
				setState(value);
				if (!value.dirty && !value.error) setError("");
				if (value.revision && value.revision !== version.current) {
					version.current = value.revision;
					callbacks.current();
				}
			} else if (value && typeof value === "object") {
				const reply = value as Record<string, unknown>;
				if (
					reply.type !== "eumenes:drawing-leave" ||
					typeof reply.requestId !== "string" ||
					typeof reply.allowed !== "boolean"
				)
					return;
				waiting.current.get(reply.requestId)?.(reply.allowed);
				waiting.current.delete(reply.requestId);
			}
		};
		window.addEventListener("message", receive);
		const pending = waiting.current;
		return () => {
			window.removeEventListener("message", receive);
			for (const finish of pending.values()) finish(false);
			pending.clear();
		};
	}, []);
	useEffect(() => {
		if (!url || url === displayed) return;
		let cancelled = false;
		void controls.current.leave().then((allowed) => {
			if (!cancelled && allowed) {
				setState(undefined);
				version.current = undefined;
				setDisplayed(url);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [url, displayed]);
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (state?.dirty) {
				event.preventDefault();
				event.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, [state?.dirty]);
	useEffect(() => {
		const tab = root.current?.closest("[data-artifact-tab]");
		if (!tab) return;
		const beforeClose = (event: Event) => {
			event.preventDefault();
			const close = (event as CustomEvent<{ close: () => void }>).detail.close;
			void controls.current.leave().then((allowed) => {
				if (allowed) close();
			});
		};
		tab.addEventListener("eumenes:artifact-close", beforeClose);
		return () => tab.removeEventListener("eumenes:artifact-close", beforeClose);
	}, []);
	return { root, iframe, displayed, state, error, send, leave };
}
