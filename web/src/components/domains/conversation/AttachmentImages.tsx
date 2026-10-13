import { useEffect, useState } from "react";
import type { Attachment } from "../../../../../api/domains/conversation/contracts";
import type { EumenesClient } from "../../../../../client";
import { Button, Modal } from "../../../design-system";
import { describeError } from "../../../errorMessages";

function AttachmentImage({
	client,
	attachment,
}: {
	client: EumenesClient;
	attachment: Attachment;
}) {
	const [url, setUrl] = useState<string>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		const abort = new AbortController();
		let objectUrl: string | undefined;
		void client
			.attachmentPreview(attachment.conversationId, attachment.id, abort.signal)
			.then((blob) => {
				if (abort.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch((e) => {
				if (!abort.signal.aborted) setError(describeError(e));
			});
		return () => {
			abort.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [client, attachment.conversationId, attachment.id]);
	if (error) return <p role="alert">画像を取得できません: {error}</p>;
	return url ? (
		<Modal
			title={attachment.name || "添付画像"}
			description="送信した画像"
			draggable={false}
			trigger={
				<Button
					type="button"
					variant="ghost"
					aria-label={`${attachment.name || "添付画像"}を拡大`}
				>
					<img src={url} alt={attachment.name || "添付画像"} />
				</Button>
			}
		>
			<img
				className="attachment-expanded"
				src={url}
				alt={attachment.name || "添付画像"}
			/>
		</Modal>
	) : (
		<span>画像を読み込み中</span>
	);
}
export function AttachmentImages({
	client,
	attachments,
}: {
	client: EumenesClient;
	attachments: Attachment[];
}) {
	return (
		<div className="message-images">
			{attachments.map((a) => (
				<AttachmentImage key={a.id} client={client} attachment={a} />
			))}
		</div>
	);
}
