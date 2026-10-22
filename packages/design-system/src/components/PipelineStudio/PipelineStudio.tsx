import {
	CornerUpLeft,
	Play,
	RefreshCw,
	Send,
	Sparkles,
	Square,
	X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";
import { PipelineFlow } from "../PipelineFlow";
import { PipelineChecks } from "./PipelineChecks";
import { PipelineSource } from "./PipelineSource";
import { FixturePanel, ProbePanel, SelectPanel } from "./PipelineTrials";
import type {
	PipelineSourceDiff,
	PipelineStudioTrialData,
	PipelineStudioWorkData,
} from "./types";
import "./PipelineStudio.css";
import { PipelineHandoff } from "./PipelineHandoff";
import {
	handoffDocument,
	materialLabel,
	type PipelineMediaLibrary,
} from "./handoff-types";

export type PipelineStudioProps = {
	title?: string;
	loading?: boolean;
	/** The screen's data could not be read. */
	error?: string;
	/** The draft being made; null when there is none yet. */
	work: PipelineStudioWorkData | null;
	/** What the last change touched in the source. */
	diff?: PipelineSourceDiff | null;
	/** Published pipelines, newest first. */
	history?: Array<{ toolchainId: string; title: string }>;
	session?: { state: "active" | "suspended"; expiresAt: string } | null;
	stoppable?: boolean;
	/** The last trial on this screen. */
	trial?: PipelineStudioTrialData | null;
	/** A host action is in flight. */
	pending?: boolean;
	/** The last receipt: a refused source apply is shown beside the editor. */
	result?: { status: string; message: string };
	onApply: (text: string, revision: number) => Promise<boolean> | void;
	onPublish: (revision: number) => void;
	onProbe: (query: string) => void;
	onSelect: (utterance: string) => void;
	onFixture: (test: number) => void;
	/** Open a published pipeline; "" returns to the draft. */
	onOpen?: (toolchainId: string) => void;
	onRefresh?: () => void;
	onReturn?: () => void;
	onResume?: () => void;
	onClose?: () => void;
	onStop?: () => void;
	className?: string;
	library?: PipelineMediaLibrary;
	onLibrary?: (
		kind: "image" | "music" | null,
		query?: string,
		more?: boolean,
	) => void;
};

const draftOption = "__draft__";
const idle = { status: "accepted", message: "" };

function expiryLabel(expiresAt: string) {
	const date = new Date(expiresAt);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleString("ja-JP", {
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

/** Why publishing is not available, or null when it is. */
function publishBlock(work: PipelineStudioWorkData) {
	if (work.busy) return "制作中のため、今は公開できません。";
	if (work.issues.length > 0) return "検査の指摘を直すと公開できます。";
	if (!work.dirty) return "公開済みの内容から変更がありません。";
	return null;
}

function PublishBar({
	work,
	pending,
	onPublish,
}: {
	work: PipelineStudioWorkData;
	pending: boolean;
	onPublish: (revision: number) => void;
}) {
	const block = publishBlock(work);
	return (
		<section className="pipeline-studio-publish" aria-label="公開">
			<div>
				<Button
					type="button"
					size="sm"
					disabled={block !== null || pending}
					onClick={() => onPublish(work.revision)}
				>
					<Send size={14} aria-hidden="true" />
					公開
				</Button>
				{block && <span className="pipeline-studio-note">{block}</span>}
			</div>
			<p className="pipeline-studio-note">
				{work.published ? (
					<>
						公開済み: <code>{work.published.functionName}</code> ・ revision{" "}
						{work.published.revision}
					</>
				) : (
					"まだ公開していません。"
				)}
			</p>
		</section>
	);
}

function Notices({
	work,
	session,
	stoppable,
	pending,
	onResume,
	onStop,
}: Pick<
	PipelineStudioProps,
	"session" | "stoppable" | "onResume" | "onStop"
> & {
	work: PipelineStudioWorkData | null;
	pending: boolean;
}) {
	const suspended = session?.state === "suspended";
	const expiry = session ? expiryLabel(session.expiresAt) : "";
	return (
		<>
			{work?.busy && (
				<div className="pipeline-studio-progress">
					<output aria-live="polite">
						<Sparkles size={14} aria-hidden="true" />{" "}
						制作しています。完成すると反映されます。
					</output>
					{stoppable && onStop && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={pending}
							onClick={onStop}
						>
							<Square size={14} aria-hidden="true" />
							停止
						</Button>
					)}
				</div>
			)}
			{suspended && (
				<p className="pipeline-studio-notice">
					<strong>一時保留{expiry ? `（${expiry}まで）` : ""}</strong>
					<span>
						公開するまで保存されません。サーバーの再起動や期限切れで破棄されます。
					</span>
					{onResume && (
						<Button
							type="button"
							size="sm"
							disabled={pending}
							onClick={onResume}
						>
							<Play size={14} aria-hidden="true" />
							編集を再開
						</Button>
					)}
				</p>
			)}
		</>
	);
}

function stateLabel(work: PipelineStudioWorkData | null) {
	if (!work) return "";
	if (!work.published) return "未公開";
	return work.dirty ? "未公開の変更あり" : "公開済み";
}

/**
 * The task pipeline studio: the pipeline's JSON source, its flow, the check findings, the search
 * check, the selection test, the fixture trial run and publishing. Presentational: the host supplies
 * the data and receives every operation as a callback.
 */
export function PipelineStudio({
	title = "パイプライン制作",
	loading = false,
	error,
	work,
	diff = null,
	history = [],
	session = null,
	stoppable = false,
	trial = null,
	pending = false,
	result = idle,
	onApply,
	onPublish,
	onProbe,
	onSelect,
	onFixture,
	onOpen,
	onRefresh,
	onReturn,
	onResume,
	onClose,
	onStop,
	className,
	library,
	onLibrary,
}: PipelineStudioProps) {
	const [handoff, setHandoff] = useState<string>();
	const panel = useRef<HTMLDivElement>(null);
	if (!work && handoff) setHandoff(undefined);
	const heading = useId();
	const flowHeading = useId();
	const checkHeading = useId();
	const busy = !!work?.busy;
	const document = work ? handoffDocument(work.source) : null;
	// A trial is one at a time; the draft is read by the host, so it needs a draft and no running trial.
	const trialLocked = !work || pending || !!trial?.pending;
	const trialOf = <K extends PipelineStudioTrialData["kind"]>(kind: K) =>
		(trial?.kind === kind ? trial : null) as Extract<
			PipelineStudioTrialData,
			{ kind: K }
		> | null;
	if (handoff && work && document)
		return (
			<PipelineHandoff
				key={handoff}
				work={work}
				stepId={handoff}
				pending={pending}
				library={library}
				onLibrary={onLibrary ?? (() => {})}
				onApply={onApply}
				onClose={() => {
					setHandoff(undefined);
					requestAnimationFrame(() =>
						panel.current
							?.querySelector<HTMLButtonElement>(
								`[data-handoff-step="${handoff}"]`,
							)
							?.focus(),
					);
				}}
			/>
		);
	return (
		<div
			ref={panel}
			className={cn("pipeline-studio", className)}
			data-busy={busy ? "true" : undefined}
		>
			<header className="pipeline-studio-bar">
				<div className="pipeline-studio-title">
					<h2 id={heading}>{work?.title || title}</h2>
					{work && (
						<span className="pipeline-studio-state">{stateLabel(work)}</span>
					)}
				</div>
				<div
					className="pipeline-studio-actions"
					role="toolbar"
					aria-label="パイプライン制作の操作"
				>
					{onOpen && history.length > 0 && (
						<select
							className="pipeline-studio-select"
							aria-label="公開済みのパイプライン"
							value=""
							disabled={pending}
							onChange={(event) =>
								onOpen(
									event.target.value === draftOption ? "" : event.target.value,
								)
							}
						>
							<option value="" disabled>
								公開済みを開く
							</option>
							{work && <option value={draftOption}>編集中の案</option>}
							{history.map((item) => (
								<option key={item.toolchainId} value={item.toolchainId}>
									{item.title || item.toolchainId}
								</option>
							))}
						</select>
					)}
					{onRefresh && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label="表示を更新"
							title="表示を更新"
							disabled={pending}
							onClick={onRefresh}
						>
							<RefreshCw size={16} aria-hidden="true" />
						</Button>
					)}
					{session?.state === "active" && onReturn && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={pending}
							onClick={onReturn}
						>
							<CornerUpLeft size={14} aria-hidden="true" />
							会話に戻る
						</Button>
					)}
					{session && onClose && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={pending}
							onClick={onClose}
						>
							<X size={14} aria-hidden="true" />
							閉じる
						</Button>
					)}
				</div>
			</header>
			{loading ? (
				<output className="pipeline-studio-empty" aria-live="polite">
					読み込んでいます
				</output>
			) : error ? (
				<div className="pipeline-studio-empty" role="alert">
					{error}
				</div>
			) : (
				<>
					<Notices
						work={work}
						session={session}
						stoppable={stoppable}
						pending={pending}
						onResume={onResume}
						onStop={onStop}
					/>
					{work ? (
						<>
							<PublishBar work={work} pending={pending} onPublish={onPublish} />
							<div className="pipeline-studio-main">
								<section className="pipeline-studio-panel" aria-label="定義">
									<h3>定義</h3>
									<PipelineSource
										work={work}
										diff={diff}
										pending={pending}
										result={result}
										onApply={onApply}
									/>
								</section>
								<div className="pipeline-studio-side">
									<section
										className="pipeline-studio-panel"
										aria-labelledby={flowHeading}
									>
										<h3 id={flowHeading}>流れ</h3>
										<PipelineFlow
											flow={work.flow}
											issues={work.issues}
											onHandoff={document ? setHandoff : undefined}
											handoffDisabled={busy || pending}
											handoffs={
												document
													? Object.fromEntries(
															document.steps.map((step) => [
																step.id,
																(step.materials ?? []).map((item) =>
																	materialLabel(item, document),
																),
															]),
														)
													: undefined
											}
										/>
									</section>
									<section
										className="pipeline-studio-panel"
										aria-labelledby={checkHeading}
									>
										<h3 id={checkHeading}>検査</h3>
										<PipelineChecks issues={work.issues} />
									</section>
								</div>
							</div>
							<div className="pipeline-studio-trials">
								<ProbePanel
									trial={trialOf("probe")}
									disabled={trialLocked}
									onProbe={onProbe}
								/>
								<SelectPanel
									trial={trialOf("select")}
									disabled={trialLocked}
									onSelect={onSelect}
								/>
								<FixturePanel
									tests={work.tests}
									trial={trialOf("fixture")}
									disabled={trialLocked}
									onFixture={onFixture}
								/>
							</div>
						</>
					) : (
						<div className="pipeline-studio-empty">
							<strong>ここにパイプラインを表示します</strong>
							<span>
								会話で作りたい手順を伝えてください。公開済みのパイプラインは上のメニューから開けます。
							</span>
						</div>
					)}
				</>
			)}
		</div>
	);
}
