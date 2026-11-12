import { useEffect, useRef, useState } from "react";
import "./canvas-workbench.css";

export function CanvasWorkbench({
	title,
	conversationId,
}: {
	title: string;
	conversationId?: string;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (
				event.origin === location.origin &&
				event.source === frame.current?.contentWindow &&
				event.data?.type === "eumenes-canvas-mode"
			)
				setExpanded(event.data.mode === "fill");
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, []);
	const query = conversationId
		? "?" + new URLSearchParams({ conversationId })
		: "";
	return (
		<iframe
			ref={frame}
			className={
				expanded
					? "canvas-workbench canvas-workbench-expanded"
					: "canvas-workbench"
			}
			src={"/api/canvas/workbench/index.html" + query}
			title={title}
			allow="fullscreen 'self'"
			allowFullScreen
		/>
	);
}
