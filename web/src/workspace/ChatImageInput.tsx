import { useRef, useState, type ReactNode } from "react";
import { DropdownMenu, ImagePicker } from "@eumenes/design-system";
import { attachmentLimits } from "../../../api/domains/conversation/contracts";
import { Button, Modal } from "../design-system";
import type { WorkspaceState } from "./useWorkspace";
import { CHAT_FILE_ACCEPT, fileSizeText } from "./useChatFiles";

/** A short hint that the image carries detections (sent to the model as reference data). */
function annotationLabel(data: Record<string, unknown>) {
	const objects = Array.isArray(data.objects) ? data.objects : null;
	if (!objects) return "検出情報なし";
	const labels = [
		...new Set(
			objects.flatMap((o) =>
				o &&
				typeof o === "object" &&
				typeof (o as { label?: unknown }).label === "string"
					? [(o as { label: string }).label]
					: [],
			),
		),
	];
	return labels.length
		? `検出: ${labels.slice(0, 4).join(", ")}${labels.length > 4 ? "…" : ""}`
		: "検出: なし";
}

/** Menu glyphs share the composer's line-icon style (folder: device files, stacked frames: library). */
function MenuIcon({ children }: { children: ReactNode }) {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export function ChatImageInput({ state }: { state: WorkspaceState }) {
	const picker = useRef<HTMLInputElement>(null);
	const filePicker = useRef<HTMLInputElement>(null);
	const files = state.attachments.files;
	const [libraryOpen, setLibraryOpen] = useState(false);
	const images = state.attachments;
	const library = images.library;
	const remaining = attachmentLimits.maxImages - images.items.length;
	// A saved image already in the draft is shown but cannot be chosen again.
	const attached = new Set(
		images.items.flatMap((item) =>
			item.source.kind === "library" ? [item.source.imageId] : [],
		),
	);
	const choices = libraryOpen
		? library.images.map((image) =>
				attached.has(image.id)
					? { ...image, disabledReason: "添付済み" }
					: image,
			)
		: [];
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
			<input
				ref={filePicker}
				type="file"
				accept={CHAT_FILE_ACCEPT}
				multiple
				hidden
				aria-label="添付ファイルを選択"
				onChange={(e) => {
					files.add(Array.from(e.target.files ?? []));
					e.target.value = "";
				}}
			/>
			<DropdownMenu
				side="top"
				items={[
					{
						label: "端末の画像を選ぶ…",
						icon: (
							<MenuIcon>
								<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
							</MenuIcon>
						),
						onClick: () => picker.current?.click(),
					},
					{
						label: "画像一覧から選ぶ…",
						icon: (
							<MenuIcon>
								<path d="M18 22H4a2 2 0 0 1-2-2V6" />
								<path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18" />
								<circle cx="12" cy="8" r="2" />
								<rect width="16" height="16" x="6" y="2" rx="2" />
							</MenuIcon>
						),
						onClick: () => {
							library.open();
							setLibraryOpen(true);
						},
					},
					{
						label: "ファイルを選ぶ…（Markdown・PDFなど）",
						icon: (
							<MenuIcon>
								<path d="M6 3h9l4 4v14H6z" />
								<path d="M14 3v5h5" />
							</MenuIcon>
						),
						onClick: () => filePicker.current?.click(),
					},
				]}
				trigger={
					<Button
						type="button"
						variant="secondary"
						size="icon"
						aria-label="ファイルを添付"
						title="ファイルを添付（端末のJPG・PNG・BMP画像、画像一覧、またはMarkdown・PDFなどのファイル）"
						disabled={images.busy || files.busy || state.submit.isPending}
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
				}
			/>
			<Modal
				open={libraryOpen}
				onOpenChange={setLibraryOpen}
				title="画像一覧から添付"
				description="保存した画像を選んで、送信前の添付に加えます。"
				draggable={false}
			>
				{libraryOpen && remaining <= 0 && (
					<output>
						添付は{attachmentLimits.maxImages}
						枚までです。添付を外してから選んでください。
					</output>
				)}
				{libraryOpen && remaining > 0 && (
					<ImagePicker
						savedOnly
						multiple
						maxSelected={remaining}
						images={choices}
						loading={library.loading}
						error={library.error}
						onRefresh={library.refresh}
						onCancel={() => setLibraryOpen(false)}
						onConfirm={(ids) => {
							setLibraryOpen(false);
							images.addLibrary(
								ids.flatMap(
									(id) => library.images.find((image) => image.id === id) ?? [],
								),
							);
						}}
					/>
				)}
			</Modal>
		</>
	);
}

export function ChatImagePreviews({ state }: { state: WorkspaceState }) {
	const images = state.attachments;
	const capability = images.capability;
	const input =
		capability?.primary.source === "larm"
			? capability.primary.chatInput
			: undefined;
	if (!images.items.length && !images.error) return null;
	return (
		<div className="chat-image-input">
			{images.items.length > 0 && (
				<div className="draft-images" aria-label="送信する添付画像">
					{images.items.map((item) => (
						<div key={item.id} className="draft-image">
							<Modal
								title={item.name || "添付画像"}
								description="送信前の画像"
								draggable={false}
								trigger={
									<Button
										type="button"
										variant="ghost"
										aria-label={`${item.name}を確認`}
									>
										<img src={item.url} alt={item.name} />
									</Button>
								}
							>
								<img
									className="attachment-expanded"
									src={item.url}
									alt={item.name}
								/>
							</Modal>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								aria-label={`${item.name}の添付を外す`}
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
			{images.items.length > 0 &&
				capability &&
				capability.primary.source !== "larm" && (
					<small>
						添付画像は選択中のクラウド接続先へ送ります。画像の保持は接続先・アカウントの設定に従います。
					</small>
				)}
			{images.items.length > 0 && capability?.fallback && (
				<small>
					許可済みのクラウド代替先の画像入力：
					{
						(
							{
								supported: "確認済み",
								unsupported: "未対応",
								unknown: "不明",
								failed: "確認失敗",
							} as const
						)[capability.fallback.status]
					}
					。
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

/** The files besides images the next message carries: shared with the agents on send, never shown to the model. */
export function ChatFilePreviews({ state }: { state: WorkspaceState }) {
	const files = state.attachments.files;
	if (!files.items.length && !files.error) return null;
	return (
		<div className="chat-image-input">
			{files.items.length > 0 && (
				<ul className="draft-files" aria-label="送信する添付ファイル">
					{files.items.map((item) => (
						<li key={item.id} className="draft-file">
							<span className="draft-file-name">{item.name}</span>
							<small>{fileSizeText(item.size)}</small>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								aria-label={`${item.name}の添付を外す`}
								disabled={files.busy || state.submit.isPending}
								onClick={() => files.remove(item.id)}
							>
								×
							</Button>
						</li>
					))}
				</ul>
			)}
			{files.items.length > 0 && (
				<small>
					{files.busy
						? "ファイルを送信準備中"
						: "ファイルは会話の一時ファイルとして担当に渡せます（サーバーの再起動で消えます）。"}
				</small>
			)}
			{files.error && (
				<p className="chat-error" role="alert">
					{files.error}
				</p>
			)}
		</div>
	);
}
