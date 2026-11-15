import type { Database } from "bun:sqlite";
import { parseResourceUri } from "../../resources";
import { runViewingSchema, type Run } from "../contracts";
import { runViewing } from "../repository";
import { runViewingResource } from "../repository/resources";
import type { DialogueDeps } from "./context";
import { lineText } from "./input-text";
import { viewedSpecialistTarget } from "./specialist-context";

const phases = {
	loading: "読込中",
	ready: "表示可能",
	blocked: "表示できない",
	error: "画面エラー",
} as const;
const selections = {
	none: "対象未選択",
	selected: "対象選択済み",
	loading: "選択対象を読込中",
	error: "選択対象の読込に失敗",
} as const;
const activities = {
	pending: "処理待ち",
	running: "処理中",
	completed: "処理完了",
	failed: "処理失敗",
	cancelled: "処理取消済み",
} as const;

/** A bounded projection of the run's own screen, shared by routing and normal talk. */
export function screenLinesInTransaction(
	deps: DialogueDeps,
	db: Database,
	run: Run,
): string[] {
	const screen = runViewingSchema.safeParse(runViewing(db, run.id)).data
		?.screen;
	const registered =
		screen &&
		deps.toolchains?.screenInTransaction?.(db, screen.artifactRevisionId);
	const lines: string[] = [];
	const variant =
		registered && (screen?.variantId ?? registered.defaultVariant);
	const adapterRefs =
		variant && registered?.variants.includes(variant)
			? registered.adapterRefs
			: undefined;
	if (screen && variant && adapterRefs) {
		const details = [
			phases[screen.phase],
			screen.selection && selections[screen.selection],
			screen.activity && activities[screen.activity],
			screen.dirty && "未保存変更あり",
			screen.contentRevision !== undefined &&
				`内容版 ${screen.contentRevision}`,
		]
			.filter(Boolean)
			.join("、");
		lines.push(
			`- 送信時の画面「${lineText(registered.title)}」（表示モード「${lineText(variant)}」、${details}、観測 ${screen.observedAt}）`,
		);
	}
	const viewing = screen
		? adapterRefs
			? viewingLineInTransaction(deps, db, run, adapterRefs)
			: undefined
		: viewingLineInTransaction(deps, db, run);
	if (viewing)
		lines.push(
			`- ${lineText(viewing)}（${screen ? "送信時に画面に表示" : "画面に表示中"}）`,
		);
	const target = viewedSpecialistTarget(deps, db, run);
	if (target)
		lines.push(
			`- ${lineText(target.specialist)}「${lineText(target.label)}」（画面に表示中、target ${target.ref}）`,
		);
	return lines;
}

/**
 * The resource the run's screen showed, as `## State`'s line of what is in front of the user (`a3 画像「…」`). The Web sends the resource's
 * URI; it is entered into the ledger as `viewed` (the same URI keeps its number) and the model reads only the
 * number. Anything else the run carries, or a resource its owner no longer has, adds no line.
 */
function viewingLineInTransaction(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger">,
	db: Database,
	run: { id: string; conversationId: string },
	adapterRefs?: readonly string[],
): string | undefined {
	const access = deps.resources;
	const ledger = deps.resourceLedger;
	if (!access || !ledger) return undefined;
	const stored = runViewingResource(db, run.id);
	const parsed = stored ? parseResourceUri(stored) : null;
	if (!parsed) return undefined;
	const resolved = access.registry.resolveInTransaction(db, parsed.uri);
	if (!resolved.ok) return undefined;
	if (adapterRefs && !adapterRefs.includes(resolved.resource.adapterRef))
		return undefined;
	const entered = ledger.enterInTransaction(db, {
		conversationId: run.conversationId,
		uri: parsed.uri,
		kind: resolved.resource.kind,
		label: resolved.resource.label,
		source: "viewed",
	});
	if (entered.forgottenAt) return undefined;
	return `a${entered.ref} ${resolved.resource.kindLabel}「${lineText(resolved.resource.label)}」`;
}
