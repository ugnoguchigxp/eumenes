/**
 * Adapters of the UI studio's content and input views (pricing-card, comparison-table, faq,
 * timeline, stat, number-input, slider, choice, toggle) onto the design system. Inputs read and
 * write the composition's shared state through `useCompositionModel`; without a `model` they
 * still render, disabled, and a stat shows "—" unless its expression needs no names.
 */
import {
	ChoiceGroup,
	ComparisonTable,
	Faq,
	Input,
	PricingCard,
	RangeSlider,
	StatTile,
	Switch,
	Timeline,
} from "@eumenes/design-system";
import { useId, useState } from "react";
import type {
	CompositionModel,
	CompositionValue,
} from "./composition-contracts";
import { evaluateExpression, parseExpression } from "./composition-expressions";
import { emptyValue, formatCompositionValue } from "./composition-format";
import { useCompositionModel } from "./composition-model";
import type { ArtifactRequest } from "./contracts";

export function PricingCardView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "pricing-card") return null;
	return (
		<PricingCard
			plan={request.plan}
			price={request.price}
			period={request.period}
			body={request.body}
			features={request.features}
			ctaLabel={request.ctaLabel}
			highlighted={request.highlighted}
		/>
	);
}

export function ComparisonTableView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "comparison-table") return null;
	return (
		<ComparisonTable
			title={request.title}
			columns={request.columns}
			rows={request.rows}
			highlightColumn={request.highlightColumn}
		/>
	);
}

export function FaqView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "faq") return null;
	return <Faq title={request.title} items={request.items} />;
}

export function TimelineView({ request }: { request: ArtifactRequest }) {
	if (request.view !== "timeline") return null;
	return <Timeline title={request.title} items={request.items} />;
}

const noScope = { get: () => undefined };

/** Evaluates with the composition's state, or with no names at all when it has none. */
function evaluateWith(
	model: CompositionModel | null,
	source: string,
): CompositionValue {
	if (model) return model.evaluate(source);
	const parsed = parseExpression(source);
	return parsed.ok ? evaluateExpression(parsed.ast, noScope) : null;
}

/** A literal `value` is shown as is; an `expr` is evaluated against the state and formatted. */
export function StatView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "stat") return null;
	const value =
		request.value ??
		(request.expr
			? formatCompositionValue(evaluateWith(model, request.expr), {
					format: request.format,
					decimals: request.decimals,
					unit: request.unit,
				})
			: emptyValue);
	return (
		<StatTile
			label={request.label}
			value={value}
			caption={request.caption}
			trend={request.trend}
		/>
	);
}

const rowStyle = { display: "flex", alignItems: "center", gap: "0.5rem" };
const stackStyle = { display: "grid", gap: "0.375rem", minWidth: 0 };

const numberOf = (value: CompositionValue): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * While the user types, the text is kept as typed (`draft`). A complete number is written to
 * the state at once (clamped to this view's min / max, then to the state's); an empty or
 * unparsable text writes nothing, and leaving the field shows the state's value again.
 */
export function NumberInputView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);
	if (request.view !== "number-input") return null;
	const state = model?.state(request.bind);
	const numberState = state?.type === "number" ? state : undefined;
	const min = request.min ?? numberState?.min;
	const max = request.max ?? numberState?.max;
	const step = request.step ?? numberState?.step;
	const current = model ? numberOf(model.value(request.bind)) : undefined;
	const change = (text: string) => {
		setDraft(text);
		if (!model || text.trim() === "") return;
		const parsed = Number(text);
		if (!Number.isFinite(parsed)) return;
		model.set(
			request.bind,
			Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed)),
		);
	};
	return (
		<div style={stackStyle}>
			<label htmlFor={id} style={{ fontSize: "0.875rem", fontWeight: 500 }}>
				{request.label}
			</label>
			<div style={rowStyle}>
				<Input
					id={id}
					type="number"
					inputMode="decimal"
					min={min}
					max={max}
					step={step ?? "any"}
					disabled={!numberState}
					value={draft ?? (current === undefined ? "" : String(current))}
					onChange={(event) => change(event.target.value)}
					onBlur={() => setDraft(null)}
				/>
				{request.unit && (
					<span style={{ whiteSpace: "nowrap", fontSize: "0.875rem" }}>
						{request.unit}
					</span>
				)}
			</div>
		</div>
	);
}

const defaultSliderMin = 0;
const defaultSliderMax = 100;

/** The range comes from the view, else from the state, else 0 to 100. */
export function SliderView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "slider") return null;
	const state = model?.state(request.bind);
	const numberState = state?.type === "number" ? state : undefined;
	const min = request.min ?? numberState?.min ?? defaultSliderMin;
	const rawMax = request.max ?? numberState?.max ?? defaultSliderMax;
	const max = rawMax > min ? rawMax : min + defaultSliderMax;
	const current = model ? numberOf(model.value(request.bind)) : undefined;
	const { format, decimals, unit } = request;
	return (
		<RangeSlider
			label={request.label}
			value={Math.min(max, Math.max(min, current ?? min))}
			min={min}
			max={max}
			step={request.step ?? numberState?.step}
			disabled={!numberState}
			onChange={(next) => model?.set(request.bind, next)}
			formatValue={(n) => formatCompositionValue(n, { format, decimals, unit })}
		/>
	);
}

export function ChoiceView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "choice") return null;
	const value = model?.value(request.bind);
	return (
		<ChoiceGroup
			disabled={model?.state(request.bind)?.type !== "text"}
			label={request.label ?? "選択肢"}
			options={request.options}
			value={typeof value === "string" ? value : ""}
			display={request.display}
			onChange={(next) => model?.set(request.bind, next)}
		/>
	);
}

export function ToggleView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	const id = useId();
	if (request.view !== "toggle") return null;
	const state = model?.state(request.bind);
	return (
		<div style={rowStyle}>
			<Switch
				id={id}
				checked={model?.value(request.bind) === true}
				disabled={state?.type !== "boolean"}
				onCheckedChange={(next) => model?.set(request.bind, next)}
			/>
			<label htmlFor={id} style={{ fontSize: "0.875rem" }}>
				{request.label}
			</label>
		</div>
	);
}
