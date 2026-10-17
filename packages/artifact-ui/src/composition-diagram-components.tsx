import {
	Diagram,
	type DiagramElement,
	StepGuide,
} from "@eumenes/design-system";
import type {
	CompositionModel,
	DiagramElement as DiagramSpec,
} from "./composition-contracts";
import { formatCompositionValue } from "./composition-format";
import { useCompositionModel } from "./composition-model";
import type { ArtifactRequest } from "./contracts";

type NumberOrExpression = number | string;
type Pair = readonly [NumberOrExpression, NumberOrExpression];

/** A number, or an expression worked out by the model; NaN when it cannot be (the part then skips the element). */
function toNumber(
	value: NumberOrExpression,
	model: CompositionModel | null,
): number {
	if (typeof value === "number") return value;
	if (!model) return Number.NaN;
	const result = model.evaluate(value);
	return typeof result === "number" ? result : Number.NaN;
}

function optionalNumber(
	value: NumberOrExpression | undefined,
	model: CompositionModel | null,
): number | undefined {
	return value === undefined ? undefined : toNumber(value, model);
}

function toPoints(points: readonly Pair[], model: CompositionModel | null) {
	return points.map(
		([x, y]) => [toNumber(x, model), toNumber(y, model)] as const,
	);
}

/** The current step of the diagram; undefined when it has no step (every element is then shown). */
function currentStep(
	stepBind: string | undefined,
	model: CompositionModel | null,
): number | undefined {
	if (!stepBind || !model) return undefined;
	const value = model.value(stepBind);
	return typeof value === "number" && Number.isFinite(value)
		? Math.trunc(value)
		: undefined;
}

function toElement(
	spec: DiagramSpec,
	model: CompositionModel | null,
	step: number | undefined,
): DiagramElement {
	const base = {
		...(spec.color ? { color: spec.color } : {}),
		visible:
			step === undefined || !spec.steps ? true : spec.steps.includes(step),
		highlighted:
			step !== undefined && spec.highlightAt
				? spec.highlightAt.includes(step)
				: false,
	};
	switch (spec.type) {
		case "shape":
			return {
				...base,
				type: "shape",
				shape: spec.shape,
				x: toNumber(spec.x, model),
				y: toNumber(spec.y, model),
				w: toNumber(spec.w, model),
				h: toNumber(spec.h, model),
				rotate: optionalNumber(spec.rotate, model),
				filled: spec.filled,
				label: spec.label,
			};
		case "polygon":
			return {
				...base,
				type: "polygon",
				points: toPoints(spec.points, model),
				rotate: optionalNumber(spec.rotate, model),
				origin: spec.origin ? toPoints([spec.origin], model)[0] : undefined,
				filled: spec.filled,
			};
		case "polyline":
			return {
				...base,
				type: "polyline",
				points: toPoints(spec.points, model),
				dashed: spec.dashed,
			};
		case "line":
		case "arrow":
			return {
				...base,
				type: spec.type,
				x1: toNumber(spec.x1, model),
				y1: toNumber(spec.y1, model),
				x2: toNumber(spec.x2, model),
				y2: toNumber(spec.y2, model),
				dashed: spec.dashed,
				label: spec.label,
			};
		case "label": {
			const text =
				spec.text ??
				formatCompositionValue(spec.expr ? model?.evaluate(spec.expr) : null);
			return {
				...base,
				type: "label",
				x: toNumber(spec.x, model),
				y: toNumber(spec.y, model),
				text,
				size: spec.size,
				align: spec.align,
			};
		}
		case "angle":
			return {
				...base,
				type: "angle",
				x: toNumber(spec.x, model),
				y: toNumber(spec.y, model),
				from: toNumber(spec.from, model),
				to: toNumber(spec.to, model),
				radius: toNumber(spec.radius, model),
				label: spec.label,
			};
	}
}

export function DiagramView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "diagram") return null;
	const step = currentStep(request.stepBind, model);
	return (
		<Diagram
			title={request.title}
			caption={request.caption}
			aspect={request.aspect}
			elements={request.elements.map((spec) => toElement(spec, model, step))}
		/>
	);
}

export function StepperView({ request }: { request: ArtifactRequest }) {
	const model = useCompositionModel();
	if (request.view !== "stepper") return null;
	const { bind } = request;
	// Shared with the model only when the bound state exists and can be written; otherwise the part keeps its own step.
	const shared = bind && model && model.state(bind) ? model.value(bind) : null;
	const controlled = bind && model && typeof shared === "number";
	return (
		<StepGuide
			title={request.title}
			steps={request.steps}
			step={controlled ? shared : undefined}
			onStepChange={controlled ? (next) => model.set(bind, next) : undefined}
		/>
	);
}
