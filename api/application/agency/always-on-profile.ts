import { updateProfile } from "eumenes-agency/agenda";
import { PROFILE_PASSES_KEPT } from "../../domains/dialogue";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { agendaClock, knownOf, type AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import { think } from "./always-on-thoughts";

const log = getLogger("agency");

/**
 * The user's plans-and-interests note, written behind the talk: one pass of the package's writer over the exchanges
 * since the last pass (see `scheduleProfile`; nothing waits for it, the plan and the next reply read what it wrote).
 * Only the user's new words can be its evidence; a pass that began before a forget is not kept, and a
 * forget takes the note back to before the pass that read the forgotten words (see `forgetProfile`).
 */
async function writeProfile(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	now(): number;
	changed(): void;
}): Promise<void> {
	const { deps, c, now } = input;
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
		if (out.applied.length) think(c, now(), "profile", out.applied.join(" / "));
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
}

/**
 * A reply is in the conversation: the writer's pass starts at once when none is running. While one runs, the reply only
 * marks `c.profileRun`; when the pass ends, one more pass reads at once what came in meanwhile (nothing marked, no pass).
 * A forget needs no cancelling: a pass reads the words as they are when it starts, and a pass already running is dropped
 * by `forgetSeq` (see `writeProfile`). Once the scope is disposed (`profileAbort`), no further pass starts.
 */
export function scheduleProfile(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	now(): number;
	changed(): void;
	track<T>(p: Promise<T>): Promise<T>;
}) {
	const { c } = input;
	if (c.profileAbort.signal.aborted) return;
	if (c.profileRun) {
		c.profileRun.again = true;
		return;
	}
	const run = { again: false };
	c.profileRun = run;
	void input.track(
		(async () => {
			try {
				do {
					run.again = false;
					await writeProfile({
						deps: input.deps,
						c,
						now: input.now,
						changed: input.changed,
					});
				} while (run.again && !c.profileAbort.signal.aborted);
			} finally {
				c.profileRun = null;
			}
		})(),
	);
}
