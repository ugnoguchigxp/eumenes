/**
 * Views of the UI studio's compositions beyond text, cards and forms: pictures, marketing and
 * content parts, the composition's shared state (`model`) with expressions, inputs and outputs,
 * formulas, a calculator and diagrams. Expressions are strings of the composition expression
 * language (composition-expressions.ts); they are parsed and checked, never run as code.
 */
import { z } from "zod";
import { picsumThemeNames } from "./picsum-themes";

const noSource = z.never().optional();
/** Views without a heading still name `title` (absent), as every registered view does. */
const noTitle = z.never().optional();
const text = (max: number) => z.string().min(1).max(max);
const buttonLabel = text(160);
/** An expression of the composition expression language. */
export const expression = z.string().trim().min(1).max(1200);
/** A name of the composition's state or of one of its computed values. */
export const modelName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/);
const numberOrExpression = z.union([z.number(), expression]);

// --- pictures ---
export const imageAspects = [
	"landscape",
	"square",
	"portrait",
	"wide",
] as const;
export const placeholderTones = ["accent", "neutral", "warm", "cool"] as const;
export const imageSpec = z.discriminatedUnion("provider", [
	z.strictObject({
		provider: z.literal("picsum"),
		theme: z.enum(picsumThemeNames),
		seed: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
			.optional(),
		alt: text(480),
		grayscale: z.boolean().optional(),
		blur: z.number().int().min(0).max(10).optional(),
	}),
	z.strictObject({
		provider: z.literal("placeholder"),
		tone: z.enum(placeholderTones).optional(),
		alt: z.string().max(480).optional(),
	}),
]);
export type ImageSpec = z.infer<typeof imageSpec>;
const aspect = z.enum(imageAspects).optional();
const cardVariant = z.enum(["vertical", "horizontal"]).optional();

// --- shared state ---
const stateDefinition = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("number"),
		initial: z.number(),
		min: z.number().optional(),
		max: z.number().optional(),
		step: z.number().positive().optional(),
	}),
	z.strictObject({ type: z.literal("boolean"), initial: z.boolean() }),
	z.strictObject({ type: z.literal("text"), initial: z.string().max(480) }),
]);
export type StateDefinition = z.infer<typeof stateDefinition>;
const seriesDefinition = z.strictObject({
	series: z.strictObject({
		from: numberOrExpression,
		to: numberOrExpression,
		initial: numberOrExpression.optional(),
		/** Uses `i` (the current x) and `prev` (the previous y, `initial` at the start). */
		expr: expression,
	}),
});
const computedDefinition = z.union([expression, seriesDefinition]);
export type ComputedDefinition = z.infer<typeof computedDefinition>;
const atMost = (max: number) => (value: Record<string, unknown>) =>
	Object.keys(value).length <= max;
/** Held by the outermost layout only (checked by `validateComposition`). */
export const compositionModel = z.strictObject({
	state: z
		.record(modelName, stateDefinition)
		.refine(atMost(32), "at most 32 states")
		.optional(),
	computed: z
		.record(modelName, computedDefinition)
		.refine(atMost(32), "at most 32 computed values")
		.optional(),
});
export type CompositionModelDefinition = z.infer<typeof compositionModel>;
export const valueFormats = [
	"number",
	"integer",
	"yen",
	"percent",
	"text",
] as const;
const valueDisplay = {
	format: z.enum(valueFormats).optional(),
	decimals: z.number().int().min(0).max(6).optional(),
	unit: z.string().min(1).max(80).optional(),
};

// --- token colors of diagrams and the icons of feature cards ---
export const diagramColors = [
	"accent",
	"ink",
	"muted",
	"positive",
	"negative",
	"warning",
] as const;
export const featureIcons = [
	"sparkles",
	"star",
	"heart",
	"shield",
	"lock",
	"zap",
	"leaf",
	"sun",
	"moon",
	"cloud",
	"truck",
	"package",
	"gift",
	"shopping-cart",
	"credit-card",
	"tag",
	"clock",
	"calendar",
	"map-pin",
	"phone",
	"mail",
	"message-circle",
	"users",
	"user",
	"award",
	"trending-up",
	"bar-chart",
	"settings",
	"check-circle",
	"globe",
	"coffee",
	"camera",
	"music",
	"book",
	"rocket",
] as const;

const exactlyOne =
	<T extends Record<string, unknown>>(
		keys: [keyof T, keyof T],
		message: string,
	) =>
	(value: T, ctx: z.RefinementCtx) => {
		if ((value[keys[0]] === undefined) === (value[keys[1]] === undefined))
			ctx.addIssue({ code: "custom", message });
	};

// --- diagram elements (coordinates 0–100; numbers may be expressions) ---
const point = z.tuple([numberOrExpression, numberOrExpression]);
const steps = z
	.array(z.number().int().min(0).max(47))
	.min(1)
	.max(48)
	.optional();
const elementBase = {
	color: z.enum(diagramColors).optional(),
	/** Step numbers (0-based) at which the element is shown; always shown when absent. */
	steps,
	/** Step numbers at which the element is emphasised. */
	highlightAt: steps,
};
const diagramLabel = z.string().min(1).max(320).optional();
export const diagramElement = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("shape"),
		shape: z.enum(["rect", "ellipse"]),
		x: numberOrExpression,
		y: numberOrExpression,
		w: numberOrExpression,
		h: numberOrExpression,
		/** Degrees, around the shape's centre. */
		rotate: numberOrExpression.optional(),
		filled: z.boolean().optional(),
		label: diagramLabel,
		...elementBase,
	}),
	z.strictObject({
		type: z.literal("polygon"),
		points: z.array(point).min(3).max(96),
		rotate: numberOrExpression.optional(),
		/** Rotation centre; the polygon's bounding-box centre when absent. */
		origin: point.optional(),
		filled: z.boolean().optional(),
		...elementBase,
	}),
	z.strictObject({
		type: z.literal("polyline"),
		points: z.array(point).min(2).max(192),
		dashed: z.boolean().optional(),
		...elementBase,
	}),
	z.strictObject({
		type: z.enum(["line", "arrow"]),
		x1: numberOrExpression,
		y1: numberOrExpression,
		x2: numberOrExpression,
		y2: numberOrExpression,
		dashed: z.boolean().optional(),
		label: diagramLabel,
		...elementBase,
	}),
	z
		.strictObject({
			type: z.literal("label"),
			x: numberOrExpression,
			y: numberOrExpression,
			text: z.string().min(1).max(320).optional(),
			/** A text expression shown instead of `text`, e.g. `format(d, "number") + " km"`. */
			expr: expression.optional(),
			size: z.enum(["sm", "md", "lg"]).optional(),
			align: z.enum(["start", "middle", "end"]).optional(),
			...elementBase,
		})
		.superRefine(exactlyOne(["text", "expr"], "label needs text or expr")),
	z.strictObject({
		type: z.literal("angle"),
		x: numberOrExpression,
		y: numberOrExpression,
		/** Degrees, counter-clockwise from the positive x axis. */
		from: numberOrExpression,
		to: numberOrExpression,
		radius: numberOrExpression,
		label: diagramLabel,
		...elementBase,
	}),
]);
export type DiagramElement = z.infer<typeof diagramElement>;

const chartPoint = z.strictObject({
	x: z.union([z.number(), z.string().min(1).max(160)]),
	y: z.number(),
});
const tableCell = z.union([z.string().max(480), z.number()]);

/** View schemas added to `viewRegistry`. */
export const compositionViewRegistry = {
	hero: {
		name: "Hero",
		label: "ヒーロー",
		schema: z
			.strictObject({
				view: z.literal("hero"),
				source: noSource,
				variant: z.enum(["centered", "split", "background"]).optional(),
				eyebrow: text(240).optional(),
				title: text(480),
				body: z.string().max(1600).optional(),
				primaryLabel: buttonLabel.optional(),
				secondaryLabel: buttonLabel.optional(),
				image: imageSpec.optional(),
				overlay: z.enum(["dark", "light", "accent"]).optional(),
				align: z.enum(["start", "center"]).optional(),
				height: z.enum(["md", "lg"]).optional(),
			})
			.superRefine((r, ctx) => {
				if ((r.variant === "split" || r.variant === "background") && !r.image)
					ctx.addIssue({ code: "custom", message: `${r.variant} needs image` });
			}),
	},
	image: {
		name: "ContentImage",
		label: "画像",
		schema: z.strictObject({
			view: z.literal("image"),
			source: noSource,
			title: noTitle,
			image: imageSpec,
			aspect,
			caption: z.string().max(800).optional(),
			rounded: z.boolean().optional(),
		}),
	},
	"media-card": {
		name: "MediaCard",
		label: "画像付きカード",
		schema: z.strictObject({
			view: z.literal("media-card"),
			source: noSource,
			variant: cardVariant,
			image: imageSpec,
			aspect,
			eyebrow: text(240).optional(),
			title: text(480),
			body: z.string().max(1600).optional(),
		}),
	},
	"product-card": {
		name: "ProductCard",
		label: "商品カード",
		schema: z.strictObject({
			view: z.literal("product-card"),
			source: noSource,
			title: noTitle,
			variant: cardVariant,
			image: imageSpec.optional(),
			name: text(320),
			/** Display text, e.g. "¥3,980"; totals are computed with `stat`. */
			price: text(160),
			compareAtPrice: text(160).optional(),
			badge: z.enum(["new", "sale", "limited", "soldout"]).optional(),
			body: z.string().max(1200).optional(),
			rating: z.number().min(0).max(5).multipleOf(0.5).optional(),
		}),
	},
	"feature-card": {
		name: "FeatureCard",
		label: "特長カード",
		schema: z.strictObject({
			view: z.literal("feature-card"),
			source: noSource,
			icon: z.enum(featureIcons).optional(),
			title: text(480),
			body: z.string().max(1600).optional(),
		}),
	},
	testimonial: {
		name: "Testimonial",
		label: "お客様の声",
		schema: z.strictObject({
			view: z.literal("testimonial"),
			source: noSource,
			title: noTitle,
			quote: text(1600),
			name: text(240),
			role: text(320).optional(),
			avatar: imageSpec.optional(),
		}),
	},
	"pricing-card": {
		name: "PricingCard",
		label: "料金プラン",
		schema: z.strictObject({
			view: z.literal("pricing-card"),
			source: noSource,
			title: noTitle,
			plan: text(240),
			price: text(160),
			period: text(80).optional(),
			body: z.string().max(800).optional(),
			features: z.array(text(480)).min(1).max(40),
			ctaLabel: buttonLabel.optional(),
			highlighted: z.boolean().optional(),
		}),
	},
	"cta-banner": {
		name: "CtaBanner",
		label: "行動喚起の帯",
		schema: z
			.strictObject({
				view: z.literal("cta-banner"),
				source: noSource,
				variant: z.enum(["accent", "subtle", "image"]).optional(),
				title: text(480),
				body: z.string().max(1200).optional(),
				primaryLabel: buttonLabel.optional(),
				secondaryLabel: buttonLabel.optional(),
				image: imageSpec.optional(),
			})
			.superRefine((r, ctx) => {
				if (r.variant === "image" && !r.image)
					ctx.addIssue({
						code: "custom",
						message: "image variant needs image",
					});
			}),
	},
	"comparison-table": {
		name: "ComparisonTable",
		label: "比較表",
		schema: z
			.strictObject({
				view: z.literal("comparison-table"),
				source: noSource,
				title: text(480).optional(),
				/** Headers of the value columns; the first column holds the row labels. */
				columns: z.array(text(240)).min(1).max(12),
				rows: z
					.array(
						z.strictObject({
							label: text(320),
							values: z
								.array(z.union([z.string().max(320), z.boolean()]))
								.min(1)
								.max(12),
						}),
					)
					.min(1)
					.max(80),
				highlightColumn: z.number().int().min(0).max(11).optional(),
			})
			.superRefine((r, ctx) => {
				if (r.rows.some((row) => row.values.length !== r.columns.length))
					ctx.addIssue({
						code: "custom",
						message: "each row needs one value per column",
					});
				if (
					r.highlightColumn !== undefined &&
					r.highlightColumn >= r.columns.length
				)
					ctx.addIssue({
						code: "custom",
						message: "highlightColumn out of range",
					});
			}),
	},
	faq: {
		name: "Faq",
		label: "よくある質問",
		schema: z.strictObject({
			view: z.literal("faq"),
			source: noSource,
			title: text(480).optional(),
			items: z
				.array(z.strictObject({ question: text(800), answer: text(4000) }))
				.min(1)
				.max(48),
		}),
	},
	timeline: {
		name: "Timeline",
		label: "タイムライン",
		schema: z.strictObject({
			view: z.literal("timeline"),
			source: noSource,
			title: text(480).optional(),
			items: z
				.array(
					z.strictObject({
						label: text(160).optional(),
						title: text(480),
						body: z.string().max(1600).optional(),
					}),
				)
				.min(1)
				.max(48),
		}),
	},
	stat: {
		name: "StatTile",
		label: "数値",
		schema: z
			.strictObject({
				view: z.literal("stat"),
				source: noSource,
				title: noTitle,
				label: text(240),
				value: text(240).optional(),
				expr: expression.optional(),
				...valueDisplay,
				caption: z.string().max(800).optional(),
				trend: z.enum(["up", "down", "flat"]).optional(),
			})
			.superRefine(exactlyOne(["value", "expr"], "stat needs value or expr")),
	},
	"number-input": {
		name: "NumberInput",
		label: "数値の入力",
		schema: z.strictObject({
			view: z.literal("number-input"),
			source: noSource,
			title: noTitle,
			bind: modelName,
			label: text(240),
			unit: text(80).optional(),
			min: z.number().optional(),
			max: z.number().optional(),
			step: z.number().positive().optional(),
		}),
	},
	slider: {
		name: "Slider",
		label: "スライダー",
		schema: z.strictObject({
			view: z.literal("slider"),
			source: noSource,
			title: noTitle,
			bind: modelName,
			label: text(240),
			min: z.number().optional(),
			max: z.number().optional(),
			step: z.number().positive().optional(),
			...valueDisplay,
		}),
	},
	choice: {
		name: "Choice",
		label: "選択",
		schema: z.strictObject({
			view: z.literal("choice"),
			source: noSource,
			title: noTitle,
			bind: modelName,
			label: text(480).optional(),
			options: z.array(text(320)).min(2).max(24),
			display: z.enum(["buttons", "cards"]).optional(),
		}),
	},
	toggle: {
		name: "Toggle",
		label: "切り替え",
		schema: z.strictObject({
			view: z.literal("toggle"),
			source: noSource,
			title: noTitle,
			bind: modelName,
			label: text(240),
		}),
	},
	chart: {
		name: "Chart",
		label: "グラフ",
		schema: z.strictObject({
			view: z.literal("chart"),
			source: noSource,
			kind: z.enum(["bar", "line", "area", "pie"]),
			title: text(480).optional(),
			series: z
				.array(
					z
						.strictObject({
							name: text(160),
							/** A computed `series` of the model. */
							from: modelName.optional(),
							points: z.array(chartPoint).min(1).max(600).optional(),
						})
						.superRefine(
							exactlyOne(["from", "points"], "series needs from or points"),
						),
				)
				.min(1)
				.max(8),
			xLabel: text(160).optional(),
			yLabel: text(160).optional(),
			...valueDisplay,
			note: z.string().max(800).optional(),
		}),
	},
	"data-table": {
		name: "DataTable",
		label: "表",
		schema: z
			.strictObject({
				view: z.literal("data-table"),
				source: noSource,
				title: text(480).optional(),
				/** With `series`, each column's `expr` is evaluated per point with `x` and `y`. */
				columns: z
					.array(
						z.strictObject({
							header: text(240),
							expr: expression.optional(),
							...valueDisplay,
						}),
					)
					.min(1)
					.max(12),
				rows: z
					.array(z.array(tableCell).min(1).max(12))
					.min(1)
					.max(200)
					.optional(),
				series: modelName.optional(),
			})
			.superRefine((r, ctx) => {
				exactlyOne(["rows", "series"], "data-table needs rows or series")(
					r,
					ctx,
				);
				if (r.series && r.columns.some((c) => !c.expr))
					ctx.addIssue({
						code: "custom",
						message: "with series every column needs expr",
					});
				if (r.rows?.some((row) => row.length !== r.columns.length))
					ctx.addIssue({
						code: "custom",
						message: "each row needs one cell per column",
					});
			}),
	},
	formula: {
		name: "Formula",
		label: "数式",
		schema: z.strictObject({
			view: z.literal("formula"),
			source: noSource,
			title: noTitle,
			label: text(240).optional(),
			/** A LaTeX subset rendered by KaTeX without trust (no links, HTML or macros that fetch). */
			tex: text(2000),
			/** Evaluated with the current state and shown after the formula as "= value". */
			expr: expression.optional(),
			...valueDisplay,
			caption: z.string().max(800).optional(),
		}),
	},
	calculator: {
		name: "Calculator",
		label: "電卓",
		schema: z.strictObject({
			view: z.literal("calculator"),
			source: noSource,
			title: noTitle,
			label: text(240).optional(),
			mode: z.enum(["basic", "scientific"]).optional(),
			/** An expression typed in beforehand; the user presses "=" to work it out. */
			preset: expression.optional(),
			/** A number state that receives the result of "=". */
			resultBind: modelName.optional(),
		}),
	},
	diagram: {
		name: "Diagram",
		label: "図解",
		schema: z.strictObject({
			view: z.literal("diagram"),
			source: noSource,
			title: text(480).optional(),
			aspect: z.enum(["landscape", "square", "wide"]).optional(),
			/** A number state holding the current step (shared with a `stepper`). */
			stepBind: modelName.optional(),
			elements: z.array(diagramElement).min(1).max(240),
			caption: z.string().max(800).optional(),
		}),
	},
	stepper: {
		name: "Stepper",
		label: "ステップ",
		schema: z.strictObject({
			view: z.literal("stepper"),
			source: noSource,
			title: text(480).optional(),
			/** A number state to share the current step with; kept inside the part when absent. */
			bind: modelName.optional(),
			steps: z
				.array(
					z.strictObject({
						title: text(320),
						body: z.string().max(2400).optional(),
					}),
				)
				.min(2)
				.max(48),
		}),
	},
} as const;

/** The views a UI studio composition may use (besides `layout`). */
export const compositionViews = [
	"text-block",
	"info-card",
	"form",
	...(Object.keys(compositionViewRegistry) as Array<
		keyof typeof compositionViewRegistry
	>),
] as const;
/** Layout directions a UI studio composition may use. */
export const compositionDirections = [
	"stack",
	"grid",
	"tabs",
	"slides",
] as const;

// --- runtime interface of the composition's state (implemented by composition-model.tsx) ---
export type CompositionPoint = { x: number | string; y: number };
export type CompositionSeries = readonly CompositionPoint[];
export type CompositionValue =
	| number
	| string
	| boolean
	| null
	| CompositionSeries;
export type CompositionModel = {
	/** The current value of a state or computed value; null when unknown. */
	value(name: string): CompositionValue;
	/** Sets a state; ignored for unknown names, computed values and wrong types. */
	set(name: string, value: number | string | boolean): void;
	/** Evaluates an expression against the current values (and extra locals); never throws. */
	evaluate(
		source: string,
		locals?: Readonly<Record<string, CompositionValue>>,
	): CompositionValue;
	/** The definition of a state, for an input's defaults (min, max, step). */
	state(name: string): StateDefinition | null;
};
