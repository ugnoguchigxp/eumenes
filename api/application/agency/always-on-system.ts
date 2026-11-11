import { agendaReplySystem } from "eumenes-agency/agenda";

const FROM = "【あなたの仕組み】";
const TO = "【気持ちの絵文字】";

/**
 * The agenda reply's rules, as the package writes them: how the agent knows the user (memory, notes), how it asks for
 * research, reads a note and keeps quiet, and the manner of the reply. Eumenes keeps its own persona, emotion and
 * data rules around them, so only this span of the package's text is used; the package is the source of the wording
 * (its tests pin that both marks exist).
 */
export function agendaReplyRules(): string {
	const full = agendaReplySystem(undefined, { toolchains: false });
	const from = full.indexOf(FROM);
	const to = full.indexOf(TO);
	if (from < 0 || to < from) throw new Error("agenda_reply_rules_changed");
	return full.slice(from, to).trim();
}
