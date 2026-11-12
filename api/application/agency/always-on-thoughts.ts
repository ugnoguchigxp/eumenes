import type {
	AgendaItem,
	AgendaTicket,
	Quiet,
	StepOutcome,
} from "eumenes-agency/agenda";
import type { AgencyThought } from "../../domains/dialogue/contracts/agency-status";
import type { AgendaScope } from "./always-on-scope";

/** Thoughts kept per conversation: the newest ones (display only, gone with a restart). */
export const THOUGHTS_KEPT = 100;

const KIND: Record<AgendaItem["kind"], string> = {
	ask: "聞く",
	research: "調べる",
	talk: "話す",
};
const CHECK: Record<string, string> = {
	partial: "一部は調べ済み",
	covered: "調べ済み",
	failed: "確認できず",
};

/** Adds one thought of the agent to the chat column (the oldest go past THOUGHTS_KEPT). */
export function think(
	c: AgendaScope,
	at: number,
	kind: AgencyThought["kind"],
	text: string,
) {
	c.thoughts.push({
		id: `t${++c.thoughtSeq}`,
		at,
		kind,
		text,
	});
	c.thoughts.splice(0, Math.max(0, c.thoughts.length - THOUGHTS_KEPT));
	c.thoughtsChanged();
}

/** What one step thought, as the reference host's CLI shows it: planned, dropped, checked, held back. */
export function stepThoughts(c: AgendaScope, out: StepOutcome) {
	const at = out.at;
	const items = new Map(c.agent.view().items.map((i) => [i.id, i]));
	if (out.plan) {
		const p = out.plan;
		for (const a of p.added)
			think(c, at, "plan", `${KIND[a.kind]}: ${a.text}（${a.reason}）`);
		for (const id of p.dropped) {
			const reason = p.reasons
				.find((r) => r.startsWith(`drop ${id}: `))
				?.slice(`drop ${id}: `.length);
			think(
				c,
				at,
				"drop",
				`${items.get(id)?.text ?? id}${reason ? `（${reason}）` : ""}`,
			);
		}
		if (p.call.code === "failed") think(c, at, "error", "計画できませんでした");
	}
	if (out.check && out.check.call.model !== "" && out.check.verdict !== "new") {
		const k = out.check;
		think(
			c,
			at,
			"check",
			`${CHECK[k.verdict] ?? k.verdict}${k.coveredBy ? `（${k.coveredBy} と同じ）` : ""}: ${k.request ?? k.reason}`,
		);
	}
	for (const r of out.repeats)
		think(
			c,
			at,
			"repeat",
			`聞かない（${r.verdict === "asked" ? "もう聞いた" : "もう答えがある"}）: ${r.text} — ${r.reason}`,
		);
	if (out.compose?.declined) {
		const item = items.get(out.compose.itemId);
		think(
			c,
			at,
			"decline",
			item
				? `見送り: ${item.text} — ${out.compose.declined}`
				: `見送り: ${out.compose.declined}`,
		);
	}
}

/** A research the agent handed over, and what became of the hand-over. */
export function researchThought(
	c: AgendaScope,
	at: number,
	ticket: Extract<AgendaTicket, { kind: "research" }>,
	outcome: "started" | "refused" | "failed",
) {
	think(
		c,
		at,
		"research",
		`${ticket.requested ? "[頼まれた] " : ""}${ticket.text}${
			outcome === "refused"
				? "（受付拒否）"
				: outcome === "failed"
					? "（できませんでした）"
					: ""
		}`,
	);
}

/** The user's wish for quiet as the reply set it (nothing when it did not change). */
export function quietThought(
	c: AgendaScope,
	at: number,
	before: Quiet,
	after: Quiet,
) {
	if (
		before.speechUntil === after.speechUntil &&
		before.allUntil === after.allUntil
	)
		return;
	const minutes = (until: number) =>
		Math.max(1, Math.round((until - at) / 60_000));
	if (after.allUntil !== null && after.allUntil > at)
		think(
			c,
			at,
			"quiet",
			`${minutes(after.allUntil)}分、調べもの・話しかけ・計画を止めます`,
		);
	else if (after.speechUntil !== null && after.speechUntil > at)
		think(
			c,
			at,
			"quiet",
			`${minutes(after.speechUntil)}分、自分から話しかけません（調べものは続けます）`,
		);
	else think(c, at, "quiet", "静かな時間を解除しました");
}
