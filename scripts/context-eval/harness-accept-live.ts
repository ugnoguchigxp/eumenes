/**
 * The saved connections the acceptance lane runs on, in this process (no server is started), bound as the product
 * binds them: the conversation's LARM connection (`createLiveLarm`), the user-intent judge's connection of the saved
 * intent profile, and the embedding of the saved LARM connection. The database is opened read-only, and only the
 * judge's settings are taken from the settings document. Nothing here names a model or a profile.
 */
import { Database } from "bun:sqlite";
import type { Embed } from "../../api/application/toolchain/toolchain-vectors";
import type { VectorSpace } from "../../api/domains/capabilities";
import { createLarm, createLarmPlayground } from "../../api/domains/larm";
import { intentSettingsSchema } from "../../api/domains/settings/contracts";
import { resolveLarmToken } from "../../api/infrastructure/auth-config";
import { createLiveLarm, liveLarmSettings } from "../live-larm";
import { expectationJudge, type AcceptPorts } from "./harness-accept";

/**
 * The judge's saved settings the product routes by. The gate asks only that some profile is set: without a saved
 * intent profile the saved LARM profile stands in (the step's expectation judges then; Ruri needs its own).
 */
export function savedIntent(dbPath: string): AcceptPorts["intent"] & {
	saved: boolean;
} {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.query("SELECT document FROM settings_document WHERE id=1")
			.get() as { document: string } | null;
		if (!row) throw new Error("harness_saved_settings_missing");
		const intent = intentSettingsSchema.parse(
			(JSON.parse(row.document) as { intent?: unknown }).intent ?? {},
		);
		const profile = intent.profile ?? liveLarmSettings().profile;
		if (!profile) throw new Error("harness_saved_profile_missing");
		return {
			profile,
			searchScore: intent.searchScore,
			timeoutMs: intent.timeoutMs,
			saved: !!intent.profile,
		};
	} finally {
		db.close();
	}
}

/** Passages embedded once for the whole run: every chain's index is made of the same bundle texts. */
function onceForPassages(embed: Embed): Embed {
	const known = new Map<string, number[]>();
	let space: VectorSpace | undefined;
	return async (texts, type, signal) => {
		if (type !== "passage") return embed(texts, type, signal);
		const missing = [...new Set(texts.filter((text) => !known.has(text)))];
		if (missing.length) {
			const result = await embed(missing, type, signal);
			space = result.space;
			for (const [i, text] of missing.entries())
				known.set(text, result.vectors[i]!);
		}
		return { vectors: texts.map((text) => known.get(text)!), space: space! };
	};
}

/** The lane's ports on the saved connections; `close` releases them after the last chain. */
export async function liveAcceptPorts(
	dbPath: string,
	judge: "ruri" | "expect",
	env = process.env,
): Promise<AcceptPorts & { close(): Promise<void> }> {
	const larm = liveLarmSettings(env);
	const token = resolveLarmToken(env);
	const intent = savedIntent(dbPath);
	if (judge === "ruri" && !intent.saved)
		throw new Error(
			"harness_intent_profile_missing (no saved intent profile: --judge expect)",
		);
	const main = createLiveLarm(env);
	const ruri =
		judge === "ruri"
			? createLarm({
					decisionOnly: true,
					keepAlive: true,
					baseUrl: larm.baseUrl ?? undefined,
					token,
					profile: intent.profile,
					audience: larm.audience,
				})
			: null;
	const playground = createLarmPlayground({
		baseUrl: larm.baseUrl ?? undefined,
		token,
		profile: larm.profile,
		audience: larm.audience,
	});
	await main.connect();
	await ruri?.connect();
	return {
		main,
		judge: ruri
			? (input, _step, signal) => ruri.judgeIntent!(input, signal)
			: expectationJudge,
		embed: onceForPassages((texts, type, signal) =>
			playground.embed(texts, type, signal),
		),
		intent: {
			profile: intent.profile,
			searchScore: intent.searchScore,
			timeoutMs: intent.timeoutMs,
		},
		async close() {
			await ruri?.close();
			await main.close();
		},
	};
}
