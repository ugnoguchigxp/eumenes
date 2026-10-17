import katex from "katex";
import "katex/dist/katex.min.css";
import { useMemo } from "react";
import { cn } from "@/utils/cn";

export interface FormulaProps {
	/** A heading such as "ステップ2". */
	label?: string;
	/** LaTeX rendered by KaTeX without trust (no links, HTML, images or runaway macros). */
	tex: string;
	/** An already formatted string shown after the formula, such as "= 384,400 km". */
	value?: string;
	caption?: string;
	className?: string;
}

/** Not a color a formula would choose; its presence in the output marks a failed rendering. */
const ERROR_COLOR = "#fe0001";

/** Options that keep untrusted TeX from linking, embedding HTML or images, or expanding without end. */
export const FORMULA_KATEX_OPTIONS = {
	displayMode: true,
	trust: false,
	strict: "ignore",
	maxSize: 10,
	maxExpand: 1000,
	throwOnError: false,
	output: "htmlAndMathml",
	// KaTeX paints what it cannot parse (unknown or disabled commands) in this color.
	errorColor: ERROR_COLOR,
} as const;

export interface RenderedFormula {
	html: string;
	failed: boolean;
}

/** The HTML KaTeX makes of `tex`; `failed` when KaTeX could not parse, expand or support all of it. */
export const renderFormula = (tex: string): RenderedFormula => {
	try {
		const html = katex.renderToString(tex, { ...FORMULA_KATEX_OPTIONS });
		return {
			html,
			failed:
				html.includes('class="katex-error"') ||
				html.includes(`mathcolor="${ERROR_COLOR}"`),
		};
	} catch {
		return { html: "", failed: true };
	}
};

/** A formula typeset by KaTeX, with an optional heading, a value after it and a caption. */
export const Formula = ({
	label,
	tex,
	value,
	caption,
	className,
}: FormulaProps) => {
	const { html, failed } = useMemo(() => renderFormula(tex), [tex]);

	return (
		<figure
			className={cn(
				"m-0 flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-foreground",
				className,
			)}
		>
			{label && (
				<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{label}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{failed ? (
					<div role="alert" className="min-w-0 text-ui text-destructive">
						<p>数式を表示できません</p>
						<code className="break-all text-xs">{tex}</code>
					</div>
				) : (
					<div
						className="min-w-0 overflow-x-auto overflow-y-hidden text-lg [&_.katex-display]:m-0"
						// KaTeX output for trust:false input; text is escaped by KaTeX.
						// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by KaTeX (trust: false)
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				)}
				{value && (
					<span className="shrink-0 font-mono text-lg font-semibold tabular-nums text-foreground">
						{value}
					</span>
				)}
			</div>
			{caption && (
				<figcaption className="text-xs text-muted-foreground">
					{caption}
				</figcaption>
			)}
		</figure>
	);
};
