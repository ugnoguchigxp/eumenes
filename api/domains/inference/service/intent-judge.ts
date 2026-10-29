import {
	createLarm,
	type IntentInput,
	type IntentJudgment,
	type LarmPort,
} from "../../larm";
import type { Settings } from "../../settings";
import type { InferenceOptions } from "./execute-types";

/**
 * The user-intent judge's own LARM port (the intent gate design, section 3): a connection of the saved intent
 * profile that carries the decision provider alone, held while the judge is in use, and released when the profile,
 * the LARM origin or the mode (`legacy`) changes and when inference closes. It never serves the speaking-attitude
 * judge, and the conversation's port never serves it.
 */
export function createIntentJudge(deps: {
	settings: { get(): Settings; onChange(fn: () => void): () => void };
	options: InferenceOptions;
}) {
	let held: { key: string; port: LarmPort } | undefined;
	const closing = new Set<Promise<void>>();
	let closed = false;
	const keyOf = (s: Settings) =>
		s.intent.mode !== "legacy" && s.intent.profile && s.larm.baseUrl
			? JSON.stringify([s.larm.baseUrl, s.intent.profile, s.larm.audience])
			: null;
	function drop() {
		if (!held) return;
		const done = held.port.close();
		held = undefined;
		closing.add(done);
		void done.finally(() => closing.delete(done)).catch(() => {});
	}
	function port(s: Settings, key: string) {
		if (held?.key !== key) {
			drop();
			held = {
				key,
				port:
					deps.options.intentLarmFactory?.(s) ??
					createLarm({
						decisionOnly: true,
						keepAlive: true,
						baseUrl: s.larm.baseUrl ?? undefined,
						token: deps.options.token,
						providerHosts: deps.options.providerHosts,
						profile: s.intent.profile,
						audience: s.larm.audience,
					}),
			};
		}
		return held.port;
	}
	/** A configured judge's connection is made ahead of the first utterance, so it does not spend that turn's bound. */
	function warm() {
		const s = deps.settings.get();
		const key = keyOf(s);
		if (key && !closed)
			void port(s, key)
				.connect()
				.catch(() => {});
	}
	const unsubscribe = deps.settings.onChange(() => {
		if (held && keyOf(deps.settings.get()) !== held.key) drop();
		warm();
	});
	warm();
	return {
		/** One judgement with the saved settings; an unconfigured judge is an error the caller falls back from. */
		async judge(
			input: IntentInput,
			signal: AbortSignal,
		): Promise<IntentJudgment> {
			if (closed) throw new Error("intent_judge_closed");
			const s = deps.settings.get();
			if (!s.intent.profile) throw new Error("intent_profile_missing");
			const key = keyOf(s);
			if (!key) throw new Error("intent_judge_unconfigured");
			const judgeIntent = port(s, key).judgeIntent;
			if (!judgeIntent) throw new Error("intent_judge_unconfigured");
			return judgeIntent(input, signal);
		},
		async close() {
			closed = true;
			unsubscribe();
			drop();
			await Promise.allSettled(closing);
		},
	};
}
