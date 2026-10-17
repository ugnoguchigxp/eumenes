/**
 * The live lane: the saved LARM connection (createLiveLarm, in this process; no server is started) and the
 * production `generateConversation`. Run through `cli.ts run --live`; it is outside verify.
 * Only the arm's messages differ between calls. Nothing here names a model or a profile.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolchainCard } from "../../api/domains/capabilities";
import {
	appendConversationPolicy,
	toolchainTools,
} from "../../api/domains/dialogue/service/conversation-tools";
import { generateConversation } from "../../api/domains/dialogue/service/conversation-generation";
import { markCurrentRequest } from "../../api/domains/dialogue/service/request-context";
import type { JudgeFn } from "../../api/domains/dialogue/eval/context/judge";
import type { ConversationRunner } from "../../api/domains/dialogue/eval/context/run";
import { createLiveLarm, liveLarmSettings } from "../live-larm";
import { canonicalJson } from "../../api/domains/dialogue/eval/context/prefix-stability";

type CatalogEntry = {
	functionName: string;
	title: string;
	summary: string;
	useWhen: string[];
};

/** The fixed function catalog of an experiment (`toolsCatalog`), as the cards the production tools are built from. */
function cardsOf(experimentDir: string, file: string): ToolchainCard[] {
	const entries = JSON.parse(
		readFileSync(join(experimentDir, file), "utf8"),
	) as CatalogEntry[];
	return entries.map((entry, index) => ({
		revisionId: `eval-${index + 1}`,
		id: entry.functionName,
		functionName: entry.functionName,
		title: entry.title,
		summary: entry.summary,
		useWhen: entry.useWhen,
		redirects: [],
		score: {
			rank: index + 1,
			ftsRank: null,
			similarity: null,
			fromHistory: false,
		},
	}));
}

export async function createLiveLane(
	experimentDir: string,
	toolsCatalog: string | undefined,
) {
	const live = createLiveLarm();
	await live.connect();
	const cards = toolsCatalog ? cardsOf(experimentDir, toolsCatalog) : [];
	const runner: ConversationRunner = async (call, signal) => {
		if (call.tools === "conversation" && cards.length === 0)
			throw new Error("context_eval_tools_catalog_missing");
		const offered = call.tools === "conversation";
		const messages = [...call.messages];
		const current = messages.at(-1)!;
		if (offered) appendConversationPolicy(messages, true, current);
		const marked = markCurrentRequest(messages, current, crypto.randomUUID());
		let repaired = false;
		try {
			const generated = await generateConversation({
				inference: live,
				messages: marked,
				requestMessage: marked.at(-1)!,
				signal,
				delta: () => {},
				briefReply: true,
				...(offered ? { tools: toolchainTools(cards), cards } : {}),
				repair: () => {
					repaired = true;
				},
				sessionRole: "main",
			});
			return {
				kind: "ok",
				text: generated.operation
					? generated.operation.announcement
					: generated.text,
				toolCalls: generated.operation
					? [
							{
								name: generated.operation.functionName,
								arguments: JSON.stringify({
									request: generated.operation.request,
								}),
							},
						]
					: [],
				repaired: repaired || generated.repaired,
			};
		} catch (error) {
			// The production path ends a run with this code when the one correction did not fix the output.
			if (
				error instanceof Error &&
				error.message === "invalid_conversation_operation"
			)
				return {
					kind: "contract_failure",
					code: error.message,
					repaired: true,
				};
			throw error;
		}
	};
	const judge: JudgeFn = (request) =>
		live.answer(request.messages, AbortSignal.timeout(45_000), request.options);
	return { runner, judge, close: () => live.close() };
}

/**
 * Identifier of the saved LARM connection settings a live run reads: sha256 of their canonical JSON (read-only,
 * from the same stored settings `createLiveLarm` uses). Only the digest is recorded, so no profile or model name
 * reaches a report. It changes whenever any saved LARM setting changes. The settings document's own revision
 * counter is not exposed read-only by the settings domain, so this digest stands in for it.
 */
export function liveSettingsSnapshot(): string {
	return `sha256:${createHash("sha256").update(canonicalJson(liveLarmSettings())).digest("hex")}`;
}
