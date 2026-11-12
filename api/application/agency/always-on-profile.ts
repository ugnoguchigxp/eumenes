import { updateProfile } from "eumenes-agency/agenda";
import { PROFILE_PASSES_KEPT } from "../../domains/dialogue";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { agendaClock, knownOf, type AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import { think } from "./always-on-thoughts";

const log = getLogger("agency");

/**
 * The user's plans-and-interests note, written behind the talk: one pass of the package's writer over the latest
 * exchange, after each reply (nothing waits for it; the plan and the next reply read what it wrote). Passes run one
 * after another. Only the user's new words can be its evidence; a pass that began before a forget is not kept, and a
 * forget takes the note back to before the pass that read the forgotten words (see `forgetProfile`).
 */
export function writeProfile(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	now(): number;
	changed(): void;
}): Promise<void> {
	const { deps, c, now } = input;
	c.profileWriting = c.profileWriting.then(async () => {
		const said = c.agent
			.view()
			.said.slice(-8)
			.map((s) => ({ id: s.id, who: s.who, text: s.text }));
		const fresh = said.filter((s) => !c.profileSeen.has(s.id)).map((s) => s.id);
		for (const s of said) c.profileSeen.add(s.id);
		const evidence = said
			.filter((s) => s.who === "user" && fresh.includes(s.id))
			.map((s) => s.id);
		if (evidence.length === 0 || c.profileAbort.signal.aborted) return;
		const seq = c.forgetSeq;
		const at = now();
		try {
			const out = await updateProfile({
				llm: c.background,
				markdown: c.profile.markdown,
				said,
				fresh,
				known: knownOf(deps, at),
				clock: agendaClock(at),
				at,
				signal: c.profileAbort.signal,
			});
			if (!out.changed || c.forgetSeq !== seq || c.profileAbort.signal.aborted)
				return;
			if (out.applied.length)
				think(c, now(), "profile", out.applied.join(" / "));
			if (out.rejected.length)
				think(c, now(), "profile", `見送り: ${out.rejected.join(" / ")}`);
			const passes = [
				...c.profile.passes,
				{ markdown: out.markdown, sources: evidence },
			];
			// Older passes are folded into the base: the note before the oldest one kept.
			const dropped = passes.splice(
				0,
				Math.max(0, passes.length - PROFILE_PASSES_KEPT),
			);
			c.profile = {
				markdown: out.markdown,
				base: dropped.at(-1)?.markdown ?? c.profile.base,
				passes,
			};
			c.revision++;
			input.changed();
		} catch (error) {
			log.warn("agency.profile_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "agency_profile_failed"),
			});
		}
	});
	return c.profileWriting;
}
