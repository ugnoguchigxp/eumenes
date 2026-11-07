import { useCallback, useEffect, useRef, useState } from "react";
import { Plate, PlateContent } from "platejs/react";
import {
	createMarkdownEditor,
	importMarkdown,
	serializeMarkdown,
	exportWarning,
} from "./editor";
import { MarkdownToolbar } from "./toolbar";
import type { MarkdownCurrent, MarkdownWorkspaceProps } from "./types";
import "./markdown-workspace.css";

const signature = (title: string, document: unknown) =>
	JSON.stringify({ title, document });
function download(text: string, name: string) {
	const url = URL.createObjectURL(
		new Blob([text], { type: "text/markdown;charset=utf-8" }),
	);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function MarkdownWorkspace(props: MarkdownWorkspaceProps) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<section className="ds-markdown-workspace" aria-label="Markdown文書">
			<header className="ds-markdown-header">
				<strong>Markdown</strong>
				<div>
					<button
						disabled={props.pending}
						onClick={() =>
							void props.onNew("無題", {
								formatVersion: 1,
								nodes: [{ type: "p", children: [{ text: "" }] }],
								originalMarkdown: null,
							})
						}
					>
						新規
					</button>
					<button
						disabled={props.pending}
						onClick={() => input.current?.click()}
					>
						Markdownを読込
					</button>
					<button disabled={props.pending} onClick={props.onLibrary}>
						Doclingから開く
					</button>
					{props.sessionState === "active" && (
						<button onClick={props.onReturn}>通常の会話へ</button>
					)}
					{props.sessionState === "suspended" && (
						<button onClick={props.onResume}>共同編集を再開</button>
					)}
				</div>
			</header>
			<input
				ref={input}
				hidden
				type="file"
				accept=".md,.markdown,text/markdown,text/plain"
				onChange={async (e) => {
					const file = e.target.files?.[0];
					if (!file) return;
					if (file.size > 262144) {
						window.alert("Markdownは256 KB以内で読み込んでください。");
						return;
					}
					const text = await file.text();
					await props.onNew(
						file.name.replace(/\.(md|markdown)$/i, "") || "無題",
						importMarkdown(text),
					);
					e.target.value = "";
				}}
			/>
			{props.documents.length > 0 && (
				<select
					className="ds-markdown-documents"
					aria-label="作業中の文書"
					value={props.current?.id ?? ""}
					onChange={(e) => props.onSelect(e.target.value)}
				>
					<option value="" disabled>
						文書を選択
					</option>
					{props.documents.map((d) => (
						<option key={d.id} value={d.id}>
							{d.title}
						</option>
					))}
				</select>
			)}
			{props.library.length > 0 && (
				<div className="ds-markdown-library" aria-label="Doclingの文書">
					{props.library.map((item) => (
						<button
							key={item.sourceId}
							disabled={props.pending}
							onClick={() => props.onOpen(item.sourceId)}
						>
							{item.title}
						</button>
					))}
				</div>
			)}
			{props.current ? (
				<DocumentEditor
					key={props.current.id}
					{...props}
					current={props.current}
				/>
			) : (
				<div className="ds-markdown-empty">
					文書を作成するか、MarkdownやDocling
					Deskの文書を開いてください。会話から文書のどの部分でも編集を依頼できます。
				</div>
			)}
			{props.message && <output aria-live="polite">{props.message}</output>}
		</section>
	);
}
function DocumentEditor(
	props: MarkdownWorkspaceProps & { current: MarkdownCurrent },
) {
	const recovery =
		props.recovery?.documentId === props.current.id ? props.recovery : null;
	const initial = recovery?.document ?? props.current.document;
	const [editor] = useState(() => createMarkdownEditor(initial));
	const [title, setTitle] = useState(recovery?.title ?? props.current.title);
	const base = useRef(recovery?.baseRevision ?? props.current.revision);
	const [dirty, setDirty] = useState(!!recovery),
		dirtyRef = useRef(!!recovery);
	const [conflict, setConflict] = useState(
		!!recovery && recovery.baseRevision !== props.current.revision,
	);
	const [composing, setComposing] = useState(false),
		composingRef = useRef(false);
	const [source, setSource] = useState(false);
	const original = useRef(initial.originalMarkdown);
	const [originalMarkdown, setOriginalMarkdown] = useState(
		initial.originalMarkdown,
	);
	const shown = useRef(JSON.stringify(editor.children));
	const submitted = useRef<string | null>(null),
		saveIntent = useRef<{ signature: string; markdown: string } | null>(null);
	const acknowledged = useRef<{ signature: string; revision: number } | null>(
		null,
	);
	const latest = useRef(props);
	useEffect(() => {
		latest.current = props;
	}, [props]);
	const name = useRef(title);
	useEffect(() => {
		name.current = title;
	}, [title]);
	const getDocument = useCallback(
		() => ({
			formatVersion: 1 as const,
			nodes: editor.children,
			originalMarkdown: original.current,
		}),
		[editor],
	);
	const persist = useCallback(
		() =>
			latest.current.onDraft({
				documentId: props.current.id,
				baseRevision: base.current,
				title: name.current,
				document: getDocument(),
			}),
		[props.current.id, getDocument],
	);
	const changed = () => {
		dirtyRef.current = true;
		setDirty(true);
		persist();
	};
	useEffect(() => {
		const remote = props.current;
		if (remote.revision <= base.current) return;
		const sig = signature(remote.title, remote.document);
		if (submitted.current === sig) {
			base.current = remote.revision;
			submitted.current = null;
			setConflict(false);
			const same = signature(name.current, getDocument()) === sig;
			dirtyRef.current = !same;
			setDirty(!same);
			if (same) props.onDraft(null);
			else persist();
			acknowledged.current = { signature: sig, revision: remote.revision };
			return;
		}
		if (dirtyRef.current || composingRef.current) {
			setConflict(true);
			return;
		}
		base.current = remote.revision;
		original.current = remote.document.originalMarkdown;
		setOriginalMarkdown(original.current);
		editor.tf.setValue(structuredClone(remote.document.nodes));
		shown.current = JSON.stringify(editor.children);
		setTitle(remote.title);
		setConflict(false);
	}, [props, composing, editor, getDocument, persist]);
	useEffect(() => {
		const intent = saveIntent.current;
		const applied = acknowledged.current;
		if (props.pending || !intent || applied?.signature !== intent.signature)
			return;
		saveIntent.current = null;
		void props.onSave(props.current.id, applied.revision, intent.markdown);
	}, [props]);
	async function apply(save: boolean) {
		if (composingRef.current || conflict) return;
		const trimmed = title.trim();
		if (!trimmed) return;
		name.current = trimmed;
		setTitle(trimmed);
		const document = getDocument(),
			sig = signature(trimmed, document);
		if (!dirty) {
			if (save)
				await props.onSave(
					props.current.id,
					base.current,
					serializeMarkdown(editor),
				);
			return;
		}
		submitted.current = sig;
		if (save)
			saveIntent.current = {
				signature: sig,
				markdown: serializeMarkdown(editor),
			};
		if (
			!(await props.onApply({
				documentId: props.current.id,
				baseRevision: base.current,
				title: trimmed,
				document,
			}))
		) {
			submitted.current = null;
			saveIntent.current = null;
		}
	}
	return (
		<>
			<div className="ds-markdown-documentbar">
				<input
					aria-label="文書名"
					maxLength={200}
					value={title}
					onChange={(e) => {
						name.current = e.target.value;
						setTitle(e.target.value);
						changed();
					}}
				/>
				<span aria-live="polite">
					{composing
						? "日本語入力中"
						: conflict
							? "更新の競合あり"
							: dirty
								? "入力中の変更あり"
								: props.current.saveState === "unknown"
									? "保存結果の確認が必要"
									: props.current.saveState === "saving"
										? "Doclingに保存中…"
										: props.current.dirty
											? "作業用下書き"
											: "Doclingに保存済み"}
				</span>
				<button
					disabled={
						props.pending || composing || conflict || !title.trim() || !dirty
					}
					onClick={() => void apply(false)}
				>
					下書きに反映
				</button>
				<button
					disabled={
						props.pending ||
						composing ||
						conflict ||
						!title.trim() ||
						!props.archiveAvailable ||
						props.current.saveState === "saving" ||
						props.current.saveState === "unknown"
					}
					onClick={() => void apply(true)}
				>
					Doclingに保存
				</button>
			</div>
			{conflict && (
				<div className="ds-markdown-notice" role="alert">
					別の編集が先に反映されています。入力中の内容は保持しています。Markdownを書き出して残すか、変更を破棄して最新の文書を読み込んでください。
					<button
						onClick={() => {
							if (
								!window.confirm(
									"入力中の変更を破棄して、最新の文書を読み込みますか？",
								)
							)
								return;
							const r = latest.current.current!;
							base.current = r.revision;
							original.current = r.document.originalMarkdown;
							setOriginalMarkdown(original.current);
							editor.tf.setValue(structuredClone(r.document.nodes));
							shown.current = JSON.stringify(editor.children);
							setTitle(r.title);
							dirtyRef.current = false;
							setDirty(false);
							setConflict(false);
							props.onDraft(null);
						}}
					>
						最新を読み込む
					</button>
				</div>
			)}
			{props.current.saveError && (
				<div className="ds-markdown-notice" role="alert">
					Doclingへの保存を確認できませんでした。作業用下書きは保持しています。Doclingの内容を確認してください。
					<button
						disabled={props.pending}
						onClick={() => props.onReconcile(props.current.id)}
					>
						保存状態を確認
					</button>
					{props.current.saveError === "markdown_archive_conflict" &&
						" Docling側で文書が変更されています。"}
				</div>
			)}
			<Plate
				editor={editor}
				onValueChange={() => {
					const json = JSON.stringify(editor.children);
					if (shown.current === json) return;
					shown.current = json;
					changed();
				}}
			>
				<MarkdownToolbar editor={editor} disabled={composing} />
				<PlateContent
					aria-label="文書本文"
					className="ds-markdown-content"
					spellCheck={false}
					onCompositionStart={() => {
						composingRef.current = true;
						setComposing(true);
					}}
					onCompositionEnd={() => {
						composingRef.current = false;
						setComposing(false);
						if (dirtyRef.current) persist();
					}}
				/>
			</Plate>
			<footer className="ds-markdown-footer">
				<span>
					{props.busy
						? "共同編集の応答待ち"
						: "文書のどの部分でも会話から編集を依頼できます"}
				</span>
				<button onClick={() => setSource(!source)}>Markdownを確認</button>
				<button
					onClick={() =>
						download(serializeMarkdown(editor), `${title || "無題"}.md`)
					}
				>
					Markdownを書出
				</button>
				{originalMarkdown !== null && (
					<button
						onClick={() =>
							download(originalMarkdown!, `${title || "無題"}-取込原文.md`)
						}
					>
						取込原文
					</button>
				)}
			</footer>
			<small className="ds-markdown-warning">{exportWarning}</small>
			{source && (
				<textarea
					aria-label="書出しMarkdown（確認用）"
					className="ds-markdown-source"
					readOnly
					value={serializeMarkdown(editor)}
				/>
			)}
		</>
	);
}
