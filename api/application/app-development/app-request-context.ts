import type { Database } from "bun:sqlite";
import {
	appDigest,
	requestUrls,
	type AppDevelopment,
	type AppDraft,
	type AppRequestContext,
	type AppRequestSource,
} from "../../domains/app-development";

type Work = ReturnType<AppDevelopment["draft"]>;
export type AppRequestEvidence = {
	messageId: string;
	conversationId: string;
	request: string;
	digest: string;
};
export type AppRequestEvidenceReader = (
	db: Database,
	conversationId: string,
	messageId: string,
) => AppRequestEvidence | null;

export function appRequestContext(
	work: Work,
	draft: AppDraft,
	sources: AppRequestSource[],
): AppRequestContext {
	const pipeline = draft.workflow?.pipeline as
		{ request?: unknown } | undefined;
	const current =
		typeof pipeline?.request === "string" && pipeline.request.trim()
			? pipeline.request.trim()
			: (work.requestContext?.current ?? work.request ?? "");
	const prior = work.requestContext;
	const unique = new Map(
		[...(prior?.sources ?? []), ...sources].map((source) => [
			source.kind === "message"
				? `${source.conversationId}:${source.messageId}`
				: source.operationId,
			source,
		]),
	);
	return {
		revision: (prior?.revision ?? 0) + 1,
		current,
		sources: [...unique.values()].slice(-32),
	};
}

export function appSourceUrlAllowed(
	db: Database,
	work: Work,
	url: string,
	read: AppRequestEvidenceReader,
) {
	let normalized: string;
	try {
		normalized = new URL(url).href;
	} catch {
		return false;
	}
	return (
		work.requestContext?.sources.some((source) => {
			if (source.kind === "ui") return source.urls.includes(normalized);
			const evidence = read(db, source.conversationId, source.messageId);
			return (
				evidence?.digest === source.digest &&
				requestUrls(evidence.request).includes(normalized)
			);
		}) ?? false
	);
}

export const uiRequestSource = (
	operationId: string,
	text: string,
): AppRequestSource => ({
	kind: "ui",
	operationId,
	digest: appDigest(text),
	urls: requestUrls(text),
});
