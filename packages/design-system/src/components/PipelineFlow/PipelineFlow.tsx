import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";
import type { PipelineFlowData, PipelineFlowIssue } from "./types";
import "./PipelineFlow.css";

export type PipelineFlowProps = {
	/** The draft as a flow; null while the draft is empty or does not read as a pipeline. */
	flow: PipelineFlowData | null;
	/** The check findings; those under `/steps/<n>` and `/answer` are shown on their step. */
	issues?: PipelineFlowIssue[];
	className?: string;
	onHandoff?: (stepId: string) => void;
	handoffs?: Record<string, string[]>;
	handoffDisabled?: boolean;
};

const stepPointer = /^\/steps\/(\d+)(?:\/|$)/;

/** Where a value comes from: an input of the pipeline, or an earlier step. */
function Reads({
	inputs,
	reads,
	knownInputs,
	knownSteps,
}: {
	inputs: string[];
	reads: string[];
	knownInputs: ReadonlySet<string>;
	knownSteps: ReadonlySet<string>;
}) {
	if (inputs.length === 0 && reads.length === 0) return null;
	return (
		<ul className="pipeline-flow-reads" aria-label="読む値">
			{inputs.map((name) => (
				<li
					key={`input:${name}`}
					data-origin="input"
					data-unresolved={knownInputs.has(name) ? undefined : "true"}
				>
					<ArrowLeft size={12} aria-hidden="true" />
					入力 <code>{name}</code>
				</li>
			))}
			{reads.map((id) => (
				<li
					key={`step:${id}`}
					data-origin="step"
					data-unresolved={knownSteps.has(id) ? undefined : "true"}
				>
					<ArrowLeft size={12} aria-hidden="true" />
					手順 <code>{id}</code>
				</li>
			))}
		</ul>
	);
}

function Findings({ issues }: { issues: PipelineFlowIssue[] }) {
	if (issues.length === 0) return null;
	return (
		<ul className="pipeline-flow-issues" aria-label="この手順の指摘">
			{issues.map((issue, index) => (
				<li key={`${index}:${issue.pointer}:${issue.rule}`}>
					<code>{issue.pointer}</code> {issue.rule}
				</li>
			))}
		</ul>
	);
}

/**
 * The steps of a pipeline in order: which inputs and earlier steps each step reads, which toolchain it
 * hands to, and the check findings that belong to it. Presentational only.
 */
export function PipelineFlow({
	flow,
	issues = [],
	className,
	onHandoff,
	handoffs,
	handoffDisabled,
}: PipelineFlowProps) {
	const grouped = useMemo(() => {
		const byStep = new Map<number, PipelineFlowIssue[]>();
		const answer: PipelineFlowIssue[] = [];
		for (const issue of issues) {
			const index = stepPointer.exec(issue.pointer)?.[1];
			if (index !== undefined) {
				const list = byStep.get(Number(index)) ?? [];
				list.push(issue);
				byStep.set(Number(index), list);
			} else if (
				issue.pointer === "/answer" ||
				issue.pointer.startsWith("/answer/")
			)
				answer.push(issue);
		}
		return { byStep, answer };
	}, [issues]);
	if (!flow)
		return (
			<p className={cn("pipeline-flow-empty", className)}>
				流れを表示できる定義がまだありません。
			</p>
		);
	const knownInputs = new Set(flow.inputs.map((input) => input.name));
	return (
		<ol
			className={cn("pipeline-flow", className)}
			aria-label="パイプラインの流れ"
		>
			<li className="pipeline-flow-node" data-node="inputs">
				<header>
					<strong>入力</strong>
				</header>
				{flow.inputs.length === 0 ? (
					<p className="pipeline-flow-note">入力はありません。</p>
				) : (
					<ul className="pipeline-flow-inputs" aria-label="入力の一覧">
						{flow.inputs.map((input) => (
							<li key={input.name}>
								<code>{input.name}</code>
								<span>{input.type}</span>
								<span>{input.required ? "必須" : "任意"}</span>
							</li>
						))}
					</ul>
				)}
			</li>
			{flow.steps.map((step, index) => {
				const found = grouped.byStep.get(index) ?? [];
				const before = new Set(flow.steps.slice(0, index).map((s) => s.id));
				return (
					<li
						key={`${index}:${step.id}`}
						className="pipeline-flow-node"
						data-node="step"
						data-kind={step.kind}
						data-invalid={found.length > 0 ? "true" : undefined}
					>
						<header>
							<span className="pipeline-flow-number">{index + 1}</span>
							<strong>{step.title || step.id}</strong>
							<span className="pipeline-flow-kind">
								{step.kind === "toolchain" ? "道具" : "抽出"}
							</span>
						</header>
						<p className="pipeline-flow-meta">
							<code>{step.id}</code>
							{step.toolchain && (
								<>
									{" → "}
									<code>{step.toolchain}</code>
								</>
							)}
						</p>
						<Reads
							inputs={step.inputs}
							reads={step.reads}
							knownInputs={knownInputs}
							knownSteps={before}
						/>
						<Findings issues={found} />
						{handoffs?.[step.id]?.map((label, i) => (
							<p className="pipeline-flow-note" key={i}>
								{label}
							</p>
						))}
						{step.kind === "toolchain" && onHandoff && (
							<Button
								size="sm"
								variant="outline"
								disabled={handoffDisabled}
								data-handoff-step={step.id}
								onClick={() => onHandoff(step.id)}
							>
								渡すものを編集
							</Button>
						)}
					</li>
				);
			})}
			{flow.answer && (
				<li
					className="pipeline-flow-node"
					data-node="answer"
					data-invalid={grouped.answer.length > 0 ? "true" : undefined}
				>
					<header>
						<strong>回答</strong>
					</header>
					<Reads
						inputs={flow.answer.inputs}
						reads={flow.answer.reads}
						knownInputs={knownInputs}
						knownSteps={new Set(flow.steps.map((s) => s.id))}
					/>
					<Findings issues={grouped.answer} />
				</li>
			)}
		</ol>
	);
}
