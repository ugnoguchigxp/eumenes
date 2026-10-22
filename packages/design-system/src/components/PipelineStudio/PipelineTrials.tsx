import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import type {
	PipelineStudioFixtureResult,
	PipelineStudioProbeResult,
	PipelineStudioSelectionResult,
	PipelineStudioTrialData,
	PipelineStudioWorkData,
} from "./types";

type Refusal =
	| { ok: false; issues: Array<{ pointer: string; rule: string }> }
	| { ok: false; code: string };

const codeWording: Record<string, string> = {
	work_busy: "制作中のため、今は試せません。",
	work_not_found: "制作中の下書きが見つかりません。",
	session_expired: "制作の期限が切れました。",
	pipeline_invalid: "下書きが検査を通らないため、試せません。",
};

/** Why a trial gave no result: the check findings of the draft, or a structural code. */
function Refused({ result }: { result: Refusal }) {
	if ("issues" in result)
		return (
			<div role="alert" className="pipeline-studio-refusal">
				<p>下書きが検査を通らないため、試せません。</p>
				<ul aria-label="試験できない理由">
					{result.issues.map((issue, index) => (
						<li key={`${index}:${issue.pointer}:${issue.rule}`}>
							<code>{issue.pointer || "(root)"}</code> {issue.rule}
						</li>
					))}
				</ul>
			</div>
		);
	return (
		<div role="alert" className="pipeline-studio-refusal">
			{codeWording[result.code] ?? "試せませんでした。"}（{result.code}）
		</div>
	);
}

const show = (value: unknown) => {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};
const score = (value: number | null) =>
	value === null ? "—" : value.toFixed(3);

/** A titled trial section: the inputs, then the result under it. */
function TrialSection({
	label,
	hint,
	children,
}: {
	label: string;
	hint: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<section className="pipeline-studio-trial" aria-labelledby={id}>
			<h3 id={id}>{label}</h3>
			<p className="pipeline-studio-note">{hint}</p>
			{children}
		</section>
	);
}

function Waiting() {
	return (
		<output className="pipeline-studio-note" aria-live="polite">
			確認しています
		</output>
	);
}

function ProbeResult({ result }: { result: PipelineStudioProbeResult }) {
	if (!result.ok) return <Refused result={result} />;
	return (
		<>
			<table className="pipeline-studio-table">
				<caption>検索の順位</caption>
				<thead>
					<tr>
						<th scope="col">順位</th>
						<th scope="col">名前</th>
						<th scope="col">類似度</th>
					</tr>
				</thead>
				<tbody>
					{result.candidates.map((row) => (
						<tr
							key={row.toolchainId}
							data-draft={row.draft ? "true" : undefined}
						>
							<td>{row.rank}</td>
							<td>
								{row.title || row.functionName}
								{row.draft && (
									<strong className="pipeline-studio-tag">この案</strong>
								)}
								<code>{row.functionName}</code>
							</td>
							<td>{score(row.similarity)}</td>
						</tr>
					))}
				</tbody>
			</table>
			{result.passages.length > 0 && (
				<ul className="pipeline-studio-passages" aria-label="この案の索引文">
					{result.passages.map((passage, index) => (
						<li key={`${index}:${passage.text}`}>
							<span>{passage.similarity.toFixed(3)}</span>
							{passage.text}
						</li>
					))}
				</ul>
			)}
		</>
	);
}

/** 検索の確認: where the draft ranks among the toolchains for one wording. */
export function ProbePanel({
	trial,
	disabled,
	onProbe,
}: {
	trial: Extract<PipelineStudioTrialData, { kind: "probe" }> | null;
	disabled: boolean;
	onProbe: (query: string) => void;
}) {
	const [query, setQuery] = useState("");
	const id = useId();
	const empty = query.trim() === "";
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!disabled && !empty) onProbe(query.trim());
	};
	return (
		<TrialSection
			label="検索の確認"
			hint="ことばを入れると、この案が検索で何番目に見つかるかを確認できます。"
		>
			<form className="pipeline-studio-form" onSubmit={submit}>
				<label htmlFor={id}>確認することば</label>
				<Input
					id={id}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<Button type="submit" size="sm" disabled={disabled || empty}>
					確認
				</Button>
			</form>
			{trial?.pending ? (
				<Waiting />
			) : (
				trial?.result && <ProbeResult result={trial.result} />
			)}
		</TrialSection>
	);
}

function SelectionResult({
	result,
}: {
	result: PipelineStudioSelectionResult;
}) {
	if (!result.ok) return <Refused result={result} />;
	return (
		<div
			className="pipeline-studio-result"
			data-matched={String(result.matched)}
		>
			<p>
				<strong>
					{result.matched
						? "この案が選ばれました"
						: "この案は選ばれませんでした"}
				</strong>
			</p>
			<dl>
				<dt>選ばれた機能</dt>
				<dd>{result.chosen ? <code>{result.chosen}</code> : "なし"}</dd>
				{result.next && (
					<>
						<dt>次の動き</dt>
						<dd>{result.next}</dd>
					</>
				)}
				{result.inputs && (
					<>
						<dt>渡された入力</dt>
						<dd>
							<code>{show(result.inputs)}</code>
						</dd>
					</>
				)}
				{result.code && (
					<>
						<dt>呼び出しが受け付けられなかった理由</dt>
						<dd>
							<code>{result.code}</code>
						</dd>
					</>
				)}
			</dl>
		</div>
	);
}

/** 選択の試験: which function the first round chooses for one utterance (nothing is run). */
export function SelectPanel({
	trial,
	disabled,
	onSelect,
}: {
	trial: Extract<PipelineStudioTrialData, { kind: "select" }> | null;
	disabled: boolean;
	onSelect: (utterance: string) => void;
}) {
	const [utterance, setUtterance] = useState("");
	const id = useId();
	const empty = utterance.trim() === "";
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!disabled && !empty) onSelect(utterance.trim());
	};
	return (
		<TrialSection
			label="選択の試験"
			hint="ユーザーの発話で、会話がこの案を選ぶかを確かめます。実行はしません。"
		>
			<form className="pipeline-studio-form" onSubmit={submit}>
				<label htmlFor={id}>発話</label>
				<Input
					id={id}
					value={utterance}
					onChange={(event) => setUtterance(event.target.value)}
				/>
				<Button type="submit" size="sm" disabled={disabled || empty}>
					選択を試す
				</Button>
			</form>
			{trial?.pending ? (
				<Waiting />
			) : (
				trial?.result && <SelectionResult result={trial.result} />
			)}
		</TrialSection>
	);
}

function FixtureResult({ result }: { result: PipelineStudioFixtureResult }) {
	if (!result.ok) return <Refused result={result} />;
	const { outcome } = result;
	return (
		<div
			className="pipeline-studio-result"
			data-passed={String(outcome.passed)}
		>
			<p role="status">
				<strong>{outcome.passed ? "合格" : "不合格"}</strong>
			</p>
			{outcome.failures.length > 0 && (
				<ul aria-label="外れた点">
					{outcome.failures.map((failure, index) => (
						<li key={`${index}:${failure.path}:${failure.code}`}>
							<code>{failure.path}</code> {failure.code}
							{failure.expected !== undefined && (
								<span>
									期待 <code>{show(failure.expected)}</code>
								</span>
							)}
							{failure.actual !== undefined && (
								<span>
									実際 <code>{show(failure.actual)}</code>
								</span>
							)}
						</li>
					))}
				</ul>
			)}
			{outcome.steps.length > 0 && (
				<ol className="pipeline-studio-run" aria-label="各手順の依頼">
					{outcome.steps.map((step, index) => (
						<li key={`${index}:${step.id}`}>
							<code>{step.id}</code>
							{step.fault && (
								<span className="pipeline-studio-fault">{step.fault}</span>
							)}
							{step.request !== undefined && (
								<pre className="pipeline-studio-code">
									<code>{step.request}</code>
								</pre>
							)}
							{step.materials?.length ? (
								<details>
									<summary>渡す資料 {step.materials.length}件</summary>
									{step.materials.map((material, i) => (
										<div key={i}>
											<strong>{material.label}</strong>
											<pre className="pipeline-studio-code">
												{show(material.value)}
											</pre>
										</div>
									))}
								</details>
							) : null}
							{step.arguments !== undefined && (
								<code>{show(step.arguments)}</code>
							)}
						</li>
					))}
				</ol>
			)}
			{outcome.answer !== undefined && (
				<pre className="pipeline-studio-code" aria-label="回答">
					<code>{outcome.answer}</code>
				</pre>
			)}
		</div>
	);
}

/** 試験運転: one fixture case of the draft, run without toolchains. */
export function FixturePanel({
	tests,
	trial,
	disabled,
	onFixture,
}: {
	tests: PipelineStudioWorkData["tests"];
	trial: Extract<PipelineStudioTrialData, { kind: "fixture" }> | null;
	disabled: boolean;
	onFixture: (test: number) => void;
}) {
	const [chosen, setChosen] = useState<number | null>(null);
	const id = useId();
	const selected =
		tests.find((test) => test.index === chosen)?.index ?? tests[0]?.index;
	return (
		<TrialSection
			label="試験運転"
			hint="下書きの試験例を、道具を使わずに流して確かめます。"
		>
			{tests.length === 0 ? (
				<p className="pipeline-studio-note">試験例がまだありません。</p>
			) : (
				<form
					className="pipeline-studio-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (!disabled && selected !== undefined) onFixture(selected);
					}}
				>
					<label htmlFor={id}>試験例</label>
					<select
						id={id}
						className="pipeline-studio-select"
						value={selected}
						onChange={(event) => setChosen(Number(event.target.value))}
					>
						{tests.map((test) => (
							<option key={test.index} value={test.index}>
								{test.index + 1}. {test.utterance}
							</option>
						))}
					</select>
					<Button type="submit" size="sm" disabled={disabled}>
						試験運転を実行
					</Button>
				</form>
			)}
			{trial?.pending ? (
				<Waiting />
			) : (
				trial?.result && <FixtureResult result={trial.result} />
			)}
		</TrialSection>
	);
}
