import { useState } from "react";
import { Button } from "../Button";
import type {
	PipelineHandoffDocument,
	PipelineMaterial,
} from "./handoff-types";

/** Candidate paths come from the document and its actual fixture data, never guessed by the UI. */
export function HandoffValuePicker({
	document,
	stepId,
	inputs,
	onSelect,
	onCancel,
}: {
	document: PipelineHandoffDocument;
	stepId: string;
	inputs: boolean;
	onSelect: (material: PipelineMaterial) => void;
	onCancel: () => void;
}) {
	const [selected, setSelected] = useState<number>();
	const index = document.steps.findIndex((step) => step.id === stepId);
	const choices: Array<{
		label: string;
		material: PipelineMaterial;
		sample?: unknown;
	}> = [];
	if (inputs) {
		for (const [name, input] of Object.entries(document.inputs))
			if (input.required || input.default !== undefined)
				choices.push({
					label: input.description || name,
					material: { kind: "reference", reference: `inputs.${name}` },
					sample: input.default,
				});
	} else {
		for (const step of document.steps.slice(0, index)) {
			const sample = document.tests
				?.map((test) => test.stepResults?.[step.id])
				.find(Boolean);
			choices.push({
				label: `${step.title} ／ 結果全体`,
				material: { kind: "result", stepId: step.id },
				sample,
			});
			if (step.kind === "extract") {
				choices.push({
					label: `${step.title} ／ 値`,
					material: { kind: "reference", reference: `steps.${step.id}.value` },
					sample: sample?.value,
				});
			} else {
				choices.push({
					label: `${step.title} ／ 説明`,
					material: {
						kind: "reference",
						reference: `steps.${step.id}.summary`,
					},
					sample: sample?.summary,
				});
				if (sample?.output !== undefined) {
					const walk = (value: unknown, path: string[]) => {
						choices.push({
							label: `${step.title} ／ ${path.join(" ／ ")}`,
							material: {
								kind: "reference",
								reference: `steps.${step.id}.${path.join(".")}`,
							},
							sample: value,
						});
						if (
							// output plus the six keys supported by pipeline references.
							path.length < 7 &&
							value !== null &&
							typeof value === "object" &&
							!Array.isArray(value)
						)
							for (const [key, child] of Object.entries(value))
								if (/^[A-Za-z0-9_-]{1,64}$/.test(key))
									walk(child, [...path, key]);
					};
					walk(sample.output, ["output"]);
				}
			}
		}
	}
	const choice = selected !== undefined ? choices[selected] : undefined;
	return (
		<section
			className="pipeline-handoff-picker"
			aria-label={inputs ? "入力項目を選ぶ" : "手順の結果を選ぶ"}
		>
			<header>
				<Button variant="outline" size="sm" onClick={onCancel}>
					戻る
				</Button>
				<h3>{inputs ? "入力項目を選ぶ" : "手順の結果を選ぶ"}</h3>
			</header>
			{choices.length === 0 && <p>選べる項目はありません。</p>}
			<div className="pipeline-handoff-options">
				{choices.map((item, i) => (
					<button
						type="button"
						key={JSON.stringify(item.material)}
						aria-pressed={selected === i}
						onClick={() => setSelected(i)}
					>
						{item.label}
					</button>
				))}
			</div>
			{choice && (
				<details>
					<summary>内容を確認</summary>
					<p>
						{choice.sample === undefined
							? "値は実行時に決まります。"
							: "試験例です。実行時はその回の結果を渡します。"}
					</p>
					{choice.sample !== undefined && (
						<pre>
							{typeof choice.sample === "string"
								? choice.sample
								: JSON.stringify(choice.sample, null, 2)}
						</pre>
					)}
				</details>
			)}
			<footer>
				<Button variant="outline" size="sm" onClick={onCancel}>
					キャンセル
				</Button>
				<Button
					size="sm"
					disabled={!choice}
					onClick={() => choice && onSelect(choice.material)}
				>
					この項目を使う
				</Button>
			</footer>
		</section>
	);
}
