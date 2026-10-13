import { useRef } from "react";
import { Button, Modal } from "../design-system";
import type { WorkspaceState } from "./useWorkspace";

export function ChatImageInput({ state }: { state: WorkspaceState }) {
	const picker = useRef<HTMLInputElement>(null);
	const images = state.attachments;
	const input = state.status.data?.larm.chatInput;
	return (
		<div className="chat-image-input">
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
				onClick={() => picker.current?.click()}
				disabled={images.busy || state.submit.isPending}
			>
				画像を添付
			</Button>
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
