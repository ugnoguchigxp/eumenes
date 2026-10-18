import { useRef } from "react";
import { Button, Modal } from "../design-system";
import type { WorkspaceState } from "./useWorkspace";

/** A short hint that the image carries detections (sent to the model as reference data). */
function annotationLabel(data: Record<string, unknown>) {
	const objects = Array.isArray(data.objects) ? data.objects : null;
	if (!objects) return "検出情報なし";
	const labels = [
		...new Set(
			objects.flatMap((o) =>
				o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string"
					? [(o as { label: string }).label]
					: [],
			),
		),
	];
	return labels.length ? `検出: ${labels.slice(0, 4).join(", ")}${labels.length > 4 ? "…" : ""}` : "検出: なし";
}

export function ChatImageInput({ state }: { state: WorkspaceState }) {
	const picker = useRef<HTMLInputElement>(null);
	const images = state.attachments;
	return (
		<>
			<input
				ref={picker}
				type="file"
				accept="image/jpeg,image/png,image/bmp,.jpg,.jpeg,.png,.bmp"
				multiple
				hidden
				aria-label="添付画像を選択"
				onChange={(e) => {
					images.add(Array.from(e.target.files ?? []));
					e.target.value = "";
				}}
			/>
			<Button
				type="button"
				variant="secondary"
				size="icon"
				aria-label="ファイルを添付"
				title="ファイルを添付（現在はJPG・PNG・BMP画像に対応）"
				onClick={() => picker.current?.click()}
				disabled={images.busy || state.submit.isPending}
			>
				<svg
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 16V4m-4 4 4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
				</svg>
			</Button>
		</>
	);
}

export function ChatImagePreviews({ state }: { state: WorkspaceState }) {
	const images = state.attachments;
	const input = state.status.data?.larm.chatInput;
	if (!images.items.length && !images.error) return null;
	return (
		<div className="chat-image-input">
			{images.items.length > 0 && (
				<div className="draft-images" aria-label="送信する添付画像">
					{images.items.map((item) => (
						<div key={item.id} className="draft-image">
							<Modal
								title={item.file.name || "添付画像"}
								description="送信前の画像"
								draggable={false}
								trigger={
									<Button
										type="button"
										variant="ghost"
										aria-label={`${item.file.name}を確認`}
									>
										<img src={item.url} alt={item.file.name} />
									</Button>
								}
							>
								<img
									className="attachment-expanded"
									src={item.url}
									alt={item.file.name}
								/>
							</Modal>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								aria-label={`${item.file.name}の添付を外す`}
								disabled={images.busy || state.submit.isPending}
								onClick={() => images.remove(item.id)}
							>
								×
							</Button>
							{item.saved?.annotation && (
								<span className="draft-image-note">
									{annotationLabel(item.saved.annotation.data)}
								</span>
							)}
						</div>
					))}
				</div>
			)}
			{images.items.length > 0 && (
				<small>
					{images.busy
						? "画像を送信準備中"
						: "添付画像は送信ボタンで送ります。透明部分は白背景に合成します。"}
				</small>
			)}
			{images.items.length > 0 && input?.retention.requestPayloadStored && (
				<small>
					LARMの推論監査に画像が保存されます（最長
					{Math.ceil(input.retention.maxRetentionSeconds / 86400)}日
					{input.retention.encrypted ? "・暗号化" : ""}）。
				</small>
			)}
			{images.error && (
				<p className="chat-error" role="alert">
					{images.error}
				</p>
			)}
		</div>
	);
}
