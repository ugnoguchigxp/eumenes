import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../Button";
import { PipelineFlow } from "../PipelineFlow";
import type { PipelineStudioWorkData } from "./types";
import {
	handoffDocument,
	materialLabel,
	parseFixedValue,
	type PipelineMaterial,
	type PipelineMediaLibrary,
} from "./handoff-types";
import { HandoffMediaPicker } from "./HandoffMediaPicker";
import { HandoffValuePicker } from "./HandoffValuePicker";
import "./PipelineHandoff.css";

export type PipelineHandoffProps = {
	work: PipelineStudioWorkData;
	stepId: string;
	pending: boolean;
	library?: PipelineMediaLibrary;
	onLibrary: (
		kind: "image" | "music" | null,
		query?: string,
		more?: boolean,
	) => void;
	onApply: (text: string, revision: number) => Promise<boolean> | void;
	onClose: () => void;
};

/** A local modal, replaced by a picker inside the same artifact. No viewport portal or nested modal. */
export function PipelineHandoff({
	work,
	stepId,
	pending,
	library,
	onLibrary,
	onApply,
	onClose,
}: PipelineHandoffProps) {
	const [base] = useState({
		source: work.source,
		revision: work.revision,
		workRef: work.workRef,
	});
	const document = handoffDocument(base.source)!;
	const step = document.steps.find((item) => item.id === stepId)!;
	const [materials, setMaterials] = useState<PipelineMaterial[]>(
		step.materials ?? [],
	);
	const [source, setSource] = useState("saved");
	const [screen, setScreen] = useState<
		"modal" | "image" | "music" | "steps" | "inputs"
	>("modal");
	const [body, setBody] = useState(""),
		[fixed, setFixed] = useState(""),
		[prompt, setPrompt] = useState("request");
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const dialog = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const stale =
		base.workRef !== work.workRef || base.revision !== work.revision;
	const locked = pending || saving || work.busy || stale;
	const unselected = body.length > 0 || fixed.length > 0;
	const dirty =
		JSON.stringify(materials) !== JSON.stringify(step.materials ?? []);
	const canSave = !locked && dirty && !unselected && materials.length <= 16;
	const add = (value: PipelineMaterial) => {
		if (
			!materials.some((item) => JSON.stringify(item) === JSON.stringify(value))
		)
			setMaterials([...materials, value]);
		setError("");
	};
	const back = () => {
		onLibrary(null);
		setScreen("modal");
	};
	const close = () => {
		onLibrary(null);
		onClose();
	};
	useEffect(() => {
		if (screen === "modal")
			dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
	}, [screen]);
	useHandoffKeys(dialog, screen === "modal", saving, close);
	const save = async () => {
		if (!canSave) return;
		const value = JSON.parse(base.source);
		const target = value.steps.find(
			(item: { id: string }) => item.id === stepId,
		);
		if (materials.length) target.materials = materials;
		else delete target.materials;
		setSaving(true);
		try {
			if (await onApply(JSON.stringify(value, null, 2), base.revision)) close();
			else setError("反映できませんでした。内容を確認して再度お試しください。");
		} catch {
			setError("反映できませんでした。選択内容は保持しています。");
		} finally {
			setSaving(false);
		}
	};
	const status = editStatus(stale, work.busy, error, unselected);
	if (screen === "steps" || screen === "inputs")
		return (
			<HandoffValuePicker
				document={document}
				stepId={stepId}
				inputs={screen === "inputs"}
				onSelect={(value) => {
					add(value);
					back();
				}}
				onCancel={back}
			/>
		);
	if (screen === "image" || screen === "music")
		return (
			<HandoffMediaPicker
				kind={screen}
				library={library}
				query={query}
				setQuery={setQuery}
				onLibrary={onLibrary}
				onSelect={add}
				onBack={back}
			/>
		);

	return (
		<section className="pipeline-handoff-stage">
			<div className="pipeline-handoff-background" aria-hidden="true">
				<PipelineFlow flow={work.flow} />
			</div>
			<div className="pipeline-handoff-overlay">
				<div
					ref={dialog}
					role="dialog"
					aria-modal="false"
					aria-labelledby={titleId}
					className="pipeline-handoff-dialog"
				>
					<header>
						<h3 id={titleId}>渡すものを編集</h3>
						<Button
							size="sm"
							variant="ghost"
							disabled={saving}
							aria-label="受け渡しの編集を閉じる"
							onClick={close}
						>
							×
						</Button>
					</header>
					<fieldset className="pipeline-handoff-body" disabled={locked}>
						<p className="pipeline-studio-note">渡し先：{step.title}</p>
						<label>
							参照元
							<select
								value={source}
								onChange={(event) => setSource(event.target.value)}
							>
								<option value="saved">保存した画像・楽曲</option>
								<option value="body">本文を入力</option>
								<option value="prompt">プロンプトを使う</option>
								<option value="steps">前の手順の結果</option>
								<option value="inputs">実行時の入力</option>
								<option value="constant">固定の値</option>
							</select>
						</label>
						{source === "saved" && (
							<div className="pipeline-handoff-entries">
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										setScreen("image");
										onLibrary("image");
									}}
								>
									画像を選ぶ ›
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										setScreen("music");
										onLibrary("music", query);
									}}
								>
									楽曲を選ぶ ›
								</Button>
							</div>
						)}
						{source === "body" && (
							<>
								<label>
									渡す本文
									<textarea
										rows={3}
										value={body}
										maxLength={16000}
										onChange={(event) => setBody(event.target.value)}
										placeholder="文章や直接渡したいプロンプト"
									/>
								</label>
								<Button
									size="sm"
									variant="outline"
									disabled={!body.length}
									onClick={() => {
										add({ kind: "text", text: body });
										setBody("");
									}}
								>
									この本文を選ぶ
								</Button>
							</>
						)}
						{source === "prompt" && (
							<>
								<label>
									どのプロンプトを渡すか
									<select
										value={prompt}
										onChange={(event) => setPrompt(event.target.value)}
									>
										<option value="request">実行時の依頼文（全文）</option>
										{document.steps
											.slice(0, document.steps.indexOf(step) + 1)
											.filter((item) => item.kind === "toolchain")
											.map((item) => (
												<option key={item.id} value={`step:${item.id}`}>
													{item.title}のプロンプト（原文）
												</option>
											))}
									</select>
								</label>
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										add(
											prompt === "request"
												? { kind: "request" }
												: { kind: "prompt", stepId: prompt.slice(5) },
										)
									}
								>
									このプロンプトを選ぶ
								</Button>
							</>
						)}
						{(source === "steps" || source === "inputs") && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => setScreen(source)}
							>
								項目を選ぶ ›
							</Button>
						)}
						{source === "constant" && (
							<>
								<label>
									固定の値（JSON）
									<textarea
										value={fixed}
										rows={2}
										onChange={(event) => setFixed(event.target.value)}
										placeholder={'例：0、false、null、["項目"]'}
									/>
								</label>
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										try {
											add({ kind: "value", value: parseFixedValue(fixed) });
											setFixed("");
										} catch {
											setError("JSONの形式を確認してください。");
										}
									}}
								>
									この値を選ぶ
								</Button>
							</>
						)}
						<SelectedMaterials
							materials={materials}
							document={document}
							onRemove={(index) =>
								setMaterials(materials.filter((_, i) => i !== index))
							}
						/>
						{materials.length > 16 && (
							<p role="alert">渡せる資料は16件までです。</p>
						)}
						{status && <p role="alert">{status}</p>}
					</fieldset>
					<footer>
						<Button
							size="sm"
							variant="outline"
							disabled={saving}
							onClick={close}
						>
							キャンセル
						</Button>
						<Button size="sm" disabled={!canSave} onClick={() => void save()}>
							反映
						</Button>
					</footer>
				</div>
			</div>
		</section>
	);
}

function trapTab(event: KeyboardEvent, dialog: HTMLDivElement | null) {
	if (event.key === "Tab") {
		const controls = [
			...(dialog?.querySelectorAll<HTMLElement>(
				"button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary",
			) ?? []),
		].filter((item) => item.getClientRects().length);
		const first = controls[0],
			last = controls.at(-1);
		if (event.shiftKey && globalThis.document.activeElement === first) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && globalThis.document.activeElement === last) {
			event.preventDefault();
			first?.focus();
		}
	}
}

function SelectedMaterials({
	materials,
	document,
	onRemove,
}: {
	materials: PipelineMaterial[];
	document: import("./handoff-types").PipelineHandoffDocument;
	onRemove: (index: number) => void;
}) {
	return (
		<>
			{materials.length > 0 && (
				<details
					className="pipeline-handoff-selected"
					open={materials.length <= 2}
				>
					<summary>選択したもの {materials.length}件</summary>
					{materials.map((item, index) => (
						<div key={index}>
							<span>{materialLabel(item, document)}</span>
							<Button
								size="sm"
								variant="ghost"
								aria-label={`${materialLabel(item, document)}を外す`}
								onClick={() => onRemove(index)}
							>
								×
							</Button>
						</div>
					))}
				</details>
			)}
		</>
	);
}

function editStatus(
	stale: boolean,
	busy: boolean,
	error: string,
	unselected: boolean,
) {
	return stale
		? "ほかの更新がありました。閉じて最新の内容から編集し直してください。"
		: busy
			? "制作中のため、今は反映できません。"
			: error ||
				(unselected
					? "未追加の入力があります。本文・固定の値を選択に加えるか、入力欄を空にしてください。"
					: "");
}

function useHandoffKeys(
	dialog: import("react").RefObject<HTMLDivElement | null>,
	active: boolean,
	saving: boolean,
	close: () => void,
) {
	useEffect(() => {
		const element = dialog.current;
		if (!active || !element) return;
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !saving) {
				event.stopPropagation();
				close();
			}
			if (event.key === "Tab") trapTab(event, element);
		};
		element.addEventListener("keydown", handler);
		return () => element.removeEventListener("keydown", handler);
	}, [dialog, active, saving, close]);
}
