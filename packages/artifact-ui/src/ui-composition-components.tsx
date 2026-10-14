import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Textarea,
} from "@eumenes/design-system";
import {
	ArrowLeft,
	LayoutTemplate,
	Monitor,
	Smartphone,
	Sparkles,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import {
	definitionRequests,
	parseDefinition,
	type ArtifactRequest,
	type Resource,
} from "./contracts";
import { ArtifactRenderer } from "./index";
import { useArtifactRuntime } from "./runtime";
import { Feedback, useAction } from "./components";
import {
	UiOptions,
	emptyUiSelection,
	uiSelectionText,
	type UiSelection,
} from "./ui-composition-options";
import "./ui-composition-workspace.css";

export function TextBlockView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "text-block") return null;
	return (
		<section className="aui-text-block">
			<h2>{request.title}</h2>
			{request.body && <p>{request.body}</p>}
		</section>
	);
}
export function InfoCardView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "info-card") return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title}</CardTitle>
			</CardHeader>
			<CardContent>
				<p>{request.body}</p>
			</CardContent>
		</Card>
	);
}

type UiItem = Extract<Resource, { kind: "ui-workspace" }>["items"][number];
function UiGallery({
	items,
	onNew,
	onSelect,
}: {
	items: UiItem[];
	onNew: () => void;
	onSelect: (item: UiItem) => void;
}) {
	return (
		<section className="aui-ui-gallery" aria-label="保存した作品">
			<div className="aui-ui-section-heading">
				<div>
					<h3>保存した作品</h3>
					<p>作品を選ぶと、プレビューと修正画面を開きます。</p>
				</div>
				<Button type="button" variant="secondary" onClick={onNew}>
					新しい作品
				</Button>
			</div>
			{items.length ? (
				<div className="aui-ui-gallery-grid">
					{items.map((item) => (
						<button
							className="aui-ui-gallery-item"
							type="button"
							key={item.id}
							onClick={() => onSelect(item)}
						>
							<span className="aui-ui-gallery-art">
								<LayoutTemplate aria-hidden="true" />
							</span>
							<strong>{item.title || "制作中のUI"}</strong>
							<span>{item.description || item.prompt || "UI作品"}</span>
							<small>
								{item.state === "generating"
									? "制作中"
									: item.state === "failed"
										? "失敗"
										: item.state === "cancelled"
											? "取消済み"
											: new Date(item.updatedAt).toLocaleString("ja-JP")}
							</small>
						</button>
					))}
				</div>
			) : (
				<div className="aui-ui-empty-gallery">
					作品はまだありません。制作画面から最初のUIを作成してください。
				</div>
			)}
		</section>
	);
}

function UiFinish({
	item,
	onPreview,
}: {
	item?: UiItem;
	onPreview: () => void;
}) {
	return (
		<div className="aui-ui-finish">
			<div className="aui-ui-label">7. 仕上がりイメージ</div>
			<button type="button" onClick={onPreview}>
				<span className="aui-ui-finish-art">
					<LayoutTemplate aria-hidden="true" />
				</span>
				<span>
					<strong>{item?.title || "プレビューを見る"}</strong>
					<small>
						{item?.description || "生成したUIをこのArtifactで操作できます。"}
					</small>
				</span>
				<span aria-hidden="true">↗</span>
			</button>
		</div>
	);
}

function UiReturnButton({ onClick }: { onClick: () => void }) {
	return (
		<div className="aui-ui-return">
			<button type="button" onClick={onClick}>
				<ArrowLeft size={16} aria-hidden="true" /> 編集画面に戻る
			</button>
		</div>
	);
}

export function UiWorkspaceView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const runtime = useArtifactRuntime();
	const inputId = useId();
	const headerRef = useRef<HTMLElement>(null);
	const data = action.resource;
	const [tab, setTab] = useState<"create" | "preview" | "gallery">("create");
	const previousTab = useRef(tab);
	useLayoutEffect(() => {
		if (previousTab.current === tab) return;
		previousTab.current = tab;
		headerRef.current?.scrollIntoView({ block: "start" });
	}, [tab]);
	const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
	const [selection, setSelection] = useState<UiSelection>(emptyUiSelection);
	const [prompt, setPrompt] = useState("");
	const [edited, setEdited] = useState(false);
	const [selectionPending, setSelectionPending] = useState(false);
	const [motifId, setMotifId] = useState("");
	if (request.view !== "ui-workspace" || data?.kind !== "ui-workspace")
		return null;
	const selected = data.items.find((item) => item.id === data.selectedId);
	const updateSelection = (next: UiSelection) => {
		setSelection(next);
		if (edited) setSelectionPending(true);
		else setPrompt(uiSelectionText(next, !!motifId));
	};
	const changeMotif = (id: string) => {
		setMotifId(id);
		if (edited) setSelectionPending(true);
		else setPrompt(uiSelectionText(selection, !!id));
	};
	const selectItem = (item: (typeof data.items)[number]) => {
		setPrompt(item.prompt ?? "");
		setEdited(true);
		setSelectionPending(false);
		setMotifId(item.motifId ?? "");
		setTab("preview");
		void action.send("ui-select", { id: item.id });
	};
	const newItem = () => {
		setSelection(emptyUiSelection);
		setPrompt("");
		setEdited(false);
		setSelectionPending(false);
		setMotifId("");
		setTab("create");
		void action.send("ui-select", { id: "" });
	};
	const backToCreate = () => {
		setTab("create");
	};
	let needsForm = false;
	if (selected?.definition) {
		try {
			needsForm = definitionRequests(
				parseDefinition(JSON.stringify(selected.definition)),
			).some((part) => part.view === "form");
		} catch {
			needsForm = true;
		}
	}
	const preview =
		selected?.state === "ready" &&
		selected.definition &&
		(!needsForm || runtime.snapshot["composition-form"]?.kind === "form");
	return (
		<div className="aui-ui-workspace">
			<header className="aui-ui-header" ref={headerRef}>
				<div className="aui-ui-header-title">
					<h2>{request.title ?? "UI自由制作"}</h2>
					<p>イメージを選び、動くUIを作成します。</p>
				</div>
				<button
					className="aui-ui-library-link"
					type="button"
					onClick={() => setTab("gallery")}
					aria-current={tab === "gallery" ? "page" : undefined}
				>
					作品 <span>{data.items.length}</span>
				</button>
			</header>
			<div className="aui-ui-tabs" role="tablist" aria-label="UI自由制作の画面">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "create"}
					onClick={() => setTab("create")}
				>
					作る
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "preview"}
					onClick={() => setTab("preview")}
				>
					プレビュー
				</button>
			</div>
			{tab === "gallery" ? (
				<UiGallery items={data.items} onNew={newItem} onSelect={selectItem} />
			) : (
				<div className="aui-ui-main" data-tab={tab}>
					{tab === "preview" && (
						<section
							className="aui-ui-preview-panel"
							aria-label="作品のプレビュー"
						>
							<div className="aui-ui-panel-head">
								<div>
									<span className="aui-ui-step">01 / PREVIEW</span>
									<h3>プレビュー</h3>
								</div>
								<div className="aui-ui-device">
									<button
										type="button"
										aria-pressed={device === "desktop"}
										onClick={() => setDevice("desktop")}
									>
										<Monitor size={16} aria-hidden="true" /> デスクトップ
									</button>
									<button
										type="button"
										aria-pressed={device === "mobile"}
										onClick={() => setDevice("mobile")}
									>
										<Smartphone size={16} aria-hidden="true" /> モバイル
									</button>
								</div>
							</div>
							<div className="aui-ui-preview-stage">
								<div
									className={`aui-ui-preview-canvas aui-ui-preview-${device}`}
								>
									{selected?.state === "generating" ? (
										<div className="aui-ui-preview-empty">
											<Sparkles aria-hidden="true" />
											<strong>UIを制作しています</strong>
											<span>完成するとここに表示されます。</span>
										</div>
									) : selected?.state === "failed" ? (
										<div className="aui-ui-preview-empty" role="alert">
											<strong>制作に失敗しました</strong>
											<span>指示を直して再試行してください。</span>
										</div>
									) : selected?.state === "cancelled" ? (
										<div className="aui-ui-preview-empty">
											制作を取り消しました。
										</div>
									) : preview ? (
										<ArtifactRenderer
											key={`${selected.id}:${selected.generation}`}
											definition={JSON.stringify(selected.definition)}
											runtime={runtime}
										/>
									) : (
										<div className="aui-ui-preview-empty">
											<LayoutTemplate aria-hidden="true" />
											<strong>ここに作品を表示します</strong>
											<span>作りたいUIを指定して生成してください。</span>
										</div>
									)}
								</div>
							</div>
							{selected && (
								<div className="aui-ui-preview-footer">
									<span>{selected.title || "制作中のUI"}</span>
									<button type="button" onClick={newItem}>
										＋ 新しい作品
									</button>
								</div>
							)}
							<UiReturnButton onClick={backToCreate} />
						</section>
					)}
					{tab === "create" && (
						<section className="aui-ui-editor" aria-label="UI制作">
							<div className="aui-ui-panel-head">
								<div>
									<span className="aui-ui-step">02 / CREATE</span>
									<h3>どんなUIにしますか？</h3>
									<p>用途やイメージを選ぶと、プロンプトに反映されます。</p>
								</div>
							</div>
							<form
								className="aui-ui-editor-form"
								onSubmit={(event) => {
									event.preventDefault();
									if (!prompt.trim() || action.pending) return;
									void action
										.send("ui-generate", {
											prompt: prompt.trim(),
											motifId,
											projectId: selected?.id ?? "",
										})
										.then((accepted) => {
											if (accepted) setTab("preview");
										});
								}}
							>
								{request.starterPrompts?.length ? (
									<div className="aui-ui-starters">
										<span>まず試す</span>
										{request.starterPrompts.map((starter) => (
											<button
												key={starter.label}
												type="button"
												onClick={() => {
													setPrompt(starter.prompt);
													setEdited(true);
													setSelectionPending(false);
												}}
											>
												{starter.label} <span aria-hidden="true">↗</span>
											</button>
										))}
									</div>
								) : null}
								<UiOptions
									selection={selection}
									onSelection={updateSelection}
									images={data.images}
									motifId={motifId}
									onMotif={changeMotif}
								/>
								<div className="aui-ui-control aui-ui-prompt-control">
									<div className="aui-ui-label aui-ui-prompt-heading">
										<label htmlFor={`${inputId}-prompt`}>
											6. UI制作プロンプト
										</label>
										<Button
											type="button"
											variant="secondary"
											disabled={!uiSelectionText(selection, !!motifId)}
											onClick={() => {
												setPrompt(uiSelectionText(selection, !!motifId));
												setEdited(false);
												setSelectionPending(false);
											}}
										>
											選択内容を反映
										</Button>
									</div>
									<Textarea
										id={`${inputId}-prompt`}
										value={prompt}
										required
										maxLength={4000}
										placeholder="作りたい画面の内容や動きを自由に書いてください"
										onChange={(event) => {
											setPrompt(event.target.value);
											setEdited(true);
											setSelectionPending(false);
										}}
									/>
									<div className="aui-ui-prompt-meta">
										<span>
											{selectionPending
												? "選択内容に変更があります。反映すると現在の文章を置き換えます。"
												: "選択内容をもとにした文章を編集できます。"}
										</span>
										<span>{prompt.length} / 4000</span>
									</div>
								</div>
								<UiFinish item={selected} onPreview={() => setTab("preview")} />
								<div className="aui-ui-actions">
									<Button
										type="submit"
										disabled={action.pending || !prompt.trim()}
									>
										<Sparkles size={16} aria-hidden="true" />
										{action.pending
											? "受付中"
											: selected
												? "この作品を更新"
												: "UIを生成"}
									</Button>
								</div>
								{selected?.state === "generating" && (
									<Button
										type="button"
										variant="secondary"
										disabled={action.pending}
										onClick={() =>
											void action.send("ui-cancel", { projectId: selected.id })
										}
									>
										制作を取り消す
									</Button>
								)}
								<Feedback message={action.message} />
							</form>
						</section>
					)}
				</div>
			)}
		</div>
	);
}
