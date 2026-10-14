import { useEffect, useRef, useState } from "react";
import {
	Menu,
	Maximize2,
	Minimize2,
	Plus,
	RefreshCw,
	FileImage,
	Download,
	RotateCcw,
	X,
} from "lucide-react";
import { Button } from "../Button";
import { Input } from "../Input";
import { useDrawingFrame } from "./useDrawingFrame";
import "./drawing.css";
export {
	isDrawingFrameState,
	type DrawingFrameState,
	type DrawingFrameCommand,
} from "./frame-protocol";
export type DrawingWorkspaceProps = {
	title?: string;
	status: string;
	error?: string;
	busy?: boolean;
	references: Array<{ id: string; title: string; revision: number }>;
	previews?: Record<string, string>;
	url?: string;
	onNew: () => void;
	onOpen: (id: string) => void;
	onRefresh: () => void;
	onBrowse?: (open: boolean) => void | Promise<unknown>;
};
/** Auth and storage stay in the existing editor; this host owns only layout and frame controls. */
export function DrawingWorkspace(p: DrawingWorkspaceProps) {
	const frame = useDrawingFrame(p.url, p.onRefresh);
	const [menu, setMenu] = useState(false),
		[fullscreen, setFullscreen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null),
		first = useRef<HTMLButtonElement>(null);
	const f = frame.state;
	const [title, setTitle] = useState("");
	const pendingTitle = useRef<string | null>(null),
		titleReference = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (f?.referenceId !== titleReference.current) {
			titleReference.current = f?.referenceId;
			pendingTitle.current = null;
		}
		if (pendingTitle.current === f?.title) pendingTitle.current = null;
		if (pendingTitle.current === null) setTitle(f?.title ?? "");
	}, [f?.referenceId, f?.title]);
	const busy = p.busy || f?.busy;
	async function browse(open: boolean) {
		setMenu(open);
		await p.onBrowse?.(open);
		if (!open) trigger.current?.focus();
	}
	useEffect(() => {
		if (menu) first.current?.focus();
	}, [menu]);
	useEffect(() => {
		const change = () =>
			setFullscreen(document.fullscreenElement === frame.root.current);
		document.addEventListener("fullscreenchange", change);
		return () => document.removeEventListener("fullscreenchange", change);
	}, [frame.root]);
	async function choose(id?: string) {
		if (id && id === f?.referenceId) {
			browse(false);
			return;
		}
		if (!(await frame.leave())) return;
		await browse(false);
		if (id) p.onOpen(id);
		else p.onNew();
	}
	async function expand() {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await frame.root.current?.requestFullscreen();
		} catch {
			/* The ordinary artifact remains usable when fullscreen is unavailable. */
		}
	}
	return (
		<section
			ref={frame.root}
			aria-label={p.title ?? "図を描く・編集する"}
			className="ds-drawing-workspace"
		>
			<header className="dw-header">
				<Button
					ref={trigger}
					variant="outline"
					size="sm"
					aria-haspopup="menu"
					aria-expanded={menu}
					onClick={() => browse(!menu)}
				>
					<Menu size={16} />
					図一覧
				</Button>
				{f ? (
					<Input
						className="dw-title"
						maxLength={200}
						aria-label="図の名前"
						value={title}
						onChange={(e) => {
							pendingTitle.current = e.target.value;
							setTitle(e.target.value);
							frame.send("title", e.target.value);
						}}
						disabled={busy}
					/>
				) : (
					<span className="dw-title">図を描く・編集する</span>
				)}
				<output
					className="dw-status"
					role="status"
					title={f?.status ?? p.status}
				>
					{f?.status ?? p.status}
				</output>
				{f && (
					<Button size="sm" onClick={() => frame.send("save")} disabled={busy}>
						保存
					</Button>
				)}
				<Button
					variant="ghost"
					size="icon"
					aria-label={fullscreen ? "全画面を終了" : "全画面で編集"}
					onClick={() => void expand()}
				>
					{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
				</Button>
			</header>
			{(p.error || f?.error || frame.error) && (
				<p role="alert" className="dw-error">
					{frame.error || f?.error || p.error}
				</p>
			)}
			{menu && (
				<>
					<button
						className="dw-backdrop"
						aria-label="図一覧を閉じる"
						onClick={() => browse(false)}
					/>
					<div
						className="dw-menu"
						role="menu"
						aria-label="図一覧"
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								browse(false);
							}
						}}
					>
						<header>
							<strong>図一覧</strong>
							<Button
								variant="ghost"
								size="icon"
								aria-label="図一覧を閉じる"
								onClick={() => browse(false)}
							>
								<X size={16} />
							</Button>
						</header>
						<Button
							ref={first}
							variant="outline"
							size="sm"
							role="menuitem"
							disabled={busy}
							onClick={() => void choose()}
						>
							<Plus size={16} />
							新しい図を作成
						</Button>
						<div className="dw-items">
							{p.references.map((r) => (
								<button
									key={r.id}
									role="menuitem"
									className="dw-item"
									disabled={busy}
									aria-current={f?.referenceId === r.id ? "true" : undefined}
									onClick={() => void choose(r.id)}
								>
									<span className="dw-thumbnail">
										{p.previews?.[`${r.id}:${r.revision}`] ? (
											<img src={p.previews[`${r.id}:${r.revision}`]} alt="" />
										) : (
											<FileImage size={22} />
										)}
									</span>
									<span className="dw-item-title">{r.title}</span>
								</button>
							))}
						</div>
						{!p.references.length && <p>保存済みの図はありません。</p>}
						<Button
							variant="ghost"
							size="sm"
							role="menuitem"
							disabled={p.busy}
							onClick={p.onRefresh}
						>
							<RefreshCw size={14} />
							一覧を更新
						</Button>
					</div>
				</>
			)}
			<div className="dw-canvas">
				{frame.displayed ? (
					<iframe
						ref={frame.iframe}
						key={frame.displayed}
						src={frame.displayed}
						title="Excalidraw編集画面"
						allow="fullscreen"
					/>
				) : (
					<div className="dw-empty">
						<FileImage size={36} />
						<p>
							{p.busy
								? "編集画面を準備しています。"
								: "図一覧から、新しい図または保存した図を選んでください。"}
						</p>
					</div>
				)}
			</div>
			{f && (
				<footer className="dw-footer">
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => frame.send("reconnect")}
					>
						<RefreshCw size={14} />
						再接続
					</Button>
					{f.hasDraft && (
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => frame.send("restore")}
						>
							<RotateCcw size={14} />
							下書きを復元
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => frame.send("download")}
					>
						<Download size={14} />
						ダウンロード
					</Button>
				</footer>
			)}
		</section>
	);
}
export type DrawingEditorFrameProps = {
	title: string;
	status: string;
	error?: string;
	busy: boolean;
	hasDraft: boolean;
	onTitle: (title: string) => void;
	onSave: () => void;
	onReconnect: () => void;
	onRestore: () => void;
	onDownload: () => void;
	onClose: () => void;
	children?: import("react").ReactNode;
};
export function DrawingEditorFrame(p: DrawingEditorFrameProps) {
	return (
		<main className="dw-standalone" aria-label="Excalidraw編集画面">
			<header className="dw-header">
				<Input
					className="dw-title"
					maxLength={200}
					aria-label="図の名前"
					value={p.title}
					onChange={(e) => p.onTitle(e.target.value)}
					disabled={p.busy}
				/>
				<Button size="sm" onClick={p.onSave} disabled={p.busy}>
					保存
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={p.onReconnect}
					disabled={p.busy}
				>
					再接続
				</Button>
				{p.hasDraft && (
					<Button size="sm" onClick={p.onRestore} disabled={p.busy}>
						下書きを復元
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={p.onDownload}>
					ダウンロード
				</Button>
				<Button variant="ghost" size="sm" onClick={p.onClose}>
					閉じる
				</Button>
				<output role="status" className="dw-status">
					{p.status}
				</output>
			</header>
			{p.error && (
				<p role="alert" className="dw-error">
					{p.error}
				</p>
			)}
			<section className="dw-canvas">{p.children}</section>
		</main>
	);
}
