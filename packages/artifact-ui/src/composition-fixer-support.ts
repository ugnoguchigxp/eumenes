/** Types and helpers the composition fixer's repairs share (`composition-fixer.ts`). */
import { compositionViews } from "./composition-contracts";

export type Obj = Record<string, unknown>;
/** The parts of a zod issue the repairs read (union branches are nested issue lists). */
export type Issue = {
	code: string;
	path: PropertyKey[];
	message: string;
	errors?: Issue[][];
	keys?: string[];
	values?: unknown[];
	maximum?: number | bigint;
	minimum?: number | bigint;
	inclusive?: boolean;
	divisor?: number | bigint;
	expected?: string;
};
/** The issues the schema reports for a node; empty when the node is valid. */
export type Check = (node: Obj) => Issue[];

const allowedViews = new Set<string>(["layout", ...compositionViews]);
/** Views not listed here (button, list, video, iframe, ...) are not aliased and are dropped. */
const viewAliases: Record<string, string> = {
	heading: "text-block",
	headline: "text-block",
	title: "text-block",
	subtitle: "text-block",
	text: "text-block",
	paragraph: "text-block",
	card: "info-card",
	img: "image",
	picture: "image",
	photo: "image",
	metric: "stat",
	kpi: "stat",
	statistic: "stat",
	pricing: "pricing-card",
	feature: "feature-card",
	cta: "cta-banner",
	quote: "testimonial",
	switch: "toggle",
	range: "slider",
	number: "number-input",
	container: "layout",
	section: "layout",
	page: "layout",
	group: "layout",
	stack: "layout",
};

export const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);
export const isLayout = (
	value: unknown,
): value is Obj & { children: unknown[] } =>
	isObj(value) && value.view === "layout" && Array.isArray(value.children);
export const at = (path: readonly string[]) => path.join("/") || ".";
export const byteLength = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

export function valueAt(node: unknown, path: readonly string[]): unknown {
	let current = node;
	for (const key of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}
export function setAt(node: Obj, path: readonly string[], value: unknown) {
	const parent = valueAt(node, path.slice(0, -1)) as Record<string, unknown>;
	parent[path[path.length - 1]!] = value;
}

/** The view name a part means, or null when it is none of the allowed views. */
export function canonicalView(view: unknown): string | null {
	if (typeof view !== "string") return null;
	const name = view.trim().toLowerCase().replaceAll("_", "-");
	if (allowedViews.has(name)) return name;
	return Object.hasOwn(viewAliases, name) ? viewAliases[name]! : null;
}

export function truncate(text: string, max: number): string {
	let cut = text.slice(0, Math.max(0, max - 1));
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return `${cut}…`;
}

/** The nearest multiple of `divisor`, written without float noise. */
export function roundToStep(value: number, divisor: number): number {
	const decimals = (String(divisor).split(".")[1] ?? "").length;
	return Number((Math.round(value / divisor) * divisor).toFixed(decimals));
}

/** Whether removing the key at `path` makes the schema report that very path (it is required). */
export function isRequired(
	node: Obj,
	path: readonly string[],
	check: Check,
): boolean {
	const copy = structuredClone(node);
	const parent = valueAt(copy, path.slice(0, -1));
	if (!isObj(parent)) return true;
	delete parent[path[path.length - 1]!];
	return check(copy).some(
		(issue) =>
			issue.path.length === path.length &&
			issue.path.every((key, index) => String(key) === path[index]),
	);
}

export const issuesOf = (result: {
	success: boolean;
	error?: { issues: unknown[] };
}): Issue[] =>
	result.success ? [] : ((result.error?.issues ?? []) as Issue[]);
