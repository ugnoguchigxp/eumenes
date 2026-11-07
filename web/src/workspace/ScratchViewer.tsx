import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { ScratchItemView } from "../../../client/scratch";
import { Button, Modal } from "../design-system";
import { describeError } from "../errorMessages";
import { fileSizeText } from "./useChatFiles";

type Loaded =
	| { kind: "image"; url: string }
	| { kind: "text"; text: string }
	| { kind: "download"; url: string };

const isText = (mime: string) =>
	mime.startsWith("text/") || mime === "application/json";

/**
 * A shared file opened from its chip (spec/server-scratch-cache-design-2026-11-07.md §12): an image is shown, a
 * text (Markdown, CSV, JSON) is shown as it is written, anything else is offered as a download.
 */
export function ScratchViewer({
	client,
	id,
	onClose,
}: {
	client: EumenesClient;
	id: string | null;
	onClose: () => void;
}) {
	const [item, setItem] = useState<ScratchItemView>();
	const [loaded, setLoaded] = useState<Loaded>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		setItem(undefined);
		setLoaded(undefined);
		setError(undefined);
		if (!id) return;
		const abort = new AbortController();
		let objectUrl: string | undefined;
		void (async () => {
			try {
				const meta = await client.scratchItem(id, abort.signal);
				const blob = await client.scratchContent(id, abort.signal);
				if (abort.signal.aborted) return;
				setItem(meta);
				if (isText(meta.mime)) {
					setLoaded({ kind: "text", text: await blob.text() });
					return;
				}
				objectUrl = URL.createObjectURL(blob);
				setLoaded({
					kind: meta.mime.startsWith("image/") ? "image" : "download",
					url: objectUrl,
				});
			} catch (e) {
				if (!abort.signal.aborted) setError(describeError(e));
			}
		})();
		return () => {
			abort.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [client, id]);
	return (
		<Modal
			open={!!id}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={item?.name ?? "一時ファイル"}
			description={
				item
					? `${item.maker}・${fileSizeText(item.bytes)}・サーバーの再起動で消えます`
					: "一時ファイル"
			}
			draggable={false}
		>
			{error && (
				<p role="alert">
					開けませんでした（サーバーの再起動で消えた可能性があります）: {error}
				</p>
			)}
			{!error && !loaded && <span>読み込み中</span>}
			{loaded?.kind === "image" && (
				<img className="scratch-viewer-image" src={loaded.url} alt={item?.name ?? ""} />
			)}
			{loaded?.kind === "text" && (
				<pre className="scratch-viewer-text">{loaded.text}</pre>
			)}
			{loaded?.kind === "download" && item && (
				<Button asChild variant="secondary">
					<a href={loaded.url} download={item.name}>
						ダウンロード
					</a>
				</Button>
			)}
		</Modal>
	);
}
