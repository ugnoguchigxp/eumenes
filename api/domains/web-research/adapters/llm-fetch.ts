import {
	createLlmFetch,
	createSafeHttpFetcher,
	duckDuckGo,
	LlmFetchError,
	type SearchProvider,
	type SafeHttpFetcher,
} from "llm-fetch";
import type {
	ResearchRequest,
	ResearchResult,
	ResearchDocument,
} from "../contracts";

import { getLogger } from "../../../infrastructure/logger";
import { isPublicHttpUrl } from "../contracts";
import type { AcquiredBody } from "../service/saved-bodies";
export interface Acquisition {
	bodies?: AcquiredBody[];
	result: ResearchResult;
	/** Only guarded stable pages, with a host-reviewed HTTP retention policy. */
	freshUntilMs: number | null;
}
export interface AcquisitionPort {
	execute(request: ResearchRequest, signal: AbortSignal): Promise<Acquisition>;
	close(): Promise<void>;
}
/** RFC 9111 §§4.2.1/4.2.3; invalid or revalidation-only policies are never reused. */
export function freshnessDeadline(
	headers: Readonly<Record<string, string>>,
	now: number,
	timing = { requestedAtMs: now, receivedAtMs: now },
): number | null {
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const key = name.toLowerCase();
		if (
			Object.hasOwn(normalized, key) &&
			["age", "date", "expires"].includes(key)
		)
			return null;
		normalized[key] = Object.hasOwn(normalized, key)
			? normalized[key] + "," + value
			: value;
	}
	headers = normalized;
	const cc = (headers["cache-control"] ?? "").toLowerCase();
	if (
		/(?:^|,)\s*(?:no-store|no-cache|private)(?:\s|,|=|$)/.test(cc) ||
		["set-cookie", "vary", "www-authenticate"].some((key) =>
			Object.hasOwn(headers, key),
		)
	)
		return null;
	const directives = cc
		.split(",")
		.map((value) => value.trim())
		.filter((value) => /^max-age(?:\s|=|$)/.test(value));
	if (directives.length > 1) return null;
	const maxAge = directives[0]?.match(
		/^max-age\s*=\s*(?:"([0-9]+)"|([0-9]+))$/,
	);
	if (directives.length && !maxAge) return null;
	if (headers.age !== undefined && !/^[0-9]+$/.test(headers.age)) return null;
	const age = headers.age === undefined ? 0 : Number(headers.age);
	const seconds = maxAge ? Number(maxAge[1] ?? maxAge[2]) : null;
	if (
		!Number.isSafeInteger(age) ||
		(seconds !== null && !Number.isSafeInteger(seconds))
	)
		return null;
	const serverAt =
		headers.date === undefined ? timing.receivedAtMs : Date.parse(headers.date);
	if (!Number.isFinite(serverAt)) return null;
	const lifetime =
		seconds !== null
			? seconds * 1000
			: headers.expires === undefined
				? 86400000
				: Date.parse(headers.expires) - serverAt;
	if (!Number.isFinite(lifetime)) return null;
	const correctedAge = Math.max(
		0,
		timing.receivedAtMs - serverAt,
		age * 1000 + Math.max(0, timing.receivedAtMs - timing.requestedAtMs),
	);
	const duration = Math.min(
		86400000,
		lifetime - correctedAge - Math.max(0, now - timing.receivedAtMs),
	);
	return duration > 0 ? now + duration : null;
}
const log = getLogger("web-research");
function limited(text: string, characters: number) {
	const value = String(text ?? "").slice(0, characters);
	return /[\uD800-\uDBFF]$/u.test(value) ? value.slice(0, -1) : value;
}
export function acquisitionError(error: unknown): string {
	if (error instanceof LlmFetchError)
		return error.guardDecision === "require_approval"
			? "web_guard_requires_approval"
			: `web_${error.code.toLowerCase()}`;
	if (
		error instanceof Error &&
		["web_timeout", "web_cancelled", "web_result_too_large"].includes(
			error.message,
		)
	)
		return error.message;
	return "web_acquisition_failed";
}
const guardReasons = new Set([
	"PATTERN_DETECTED",
	"SEGMENT_COUNT_LIMIT",
	"CHARACTER_BUDGET_LIMIT",
	"SEGMENT_TEXT_LIMIT",
	"SEGMENT_COLLECTION_LIMIT",
	"INSPECTION_INCOMPLETE",
	"ADDITIONAL_GUARD_RESTRICTION",
]);
/** Only library-defined codes are safe diagnostics; never copy findings or error text. */
export function acquisitionRejectionReasons(error: unknown): string[] {
	return error instanceof LlmFetchError
		? [...new Set(error.guardReasonCodes ?? [])]
				.filter((code) => guardReasons.has(code))
				.slice(0, 7)
		: [];
}

export function createWebAcquisition(
	options: {
		search?: SearchProvider;
		now?: () => number;
		fetcher?: SafeHttpFetcher;
	} = {},
): AcquisitionPort {
	const now = options.now ?? Date.now;
	const baseSearch = options.search ?? duckDuckGo({ timeoutMs: 5000 });
	// llm-fetch rejects the whole provider response on one invalid hit
	// (PARSE_CHANGED), so drop unusable hits before it validates them.
	const search: SearchProvider = {
		name: baseSearch.name,
		async search(input) {
			const raw = await baseSearch.search(input);
			if (!Array.isArray(raw)) return raw;
			const valid = raw.filter(
				(hit) => typeof hit?.url === "string" && isPublicHttpUrl(hit.url),
			);
			if (valid.length < raw.length)
				log.info("web_research.hits_filtered", {
					count: raw.length - valid.length,
				});
			return valid;
		},
	};
	const hitsClient = createLlmFetch({
		search,
		cache: { enabled: false },
		searchTimeoutMs: 8000,
	});
	async function read(
		url: string,
		signal: AbortSignal,
	): Promise<{
		document: ResearchDocument;
		body: AcquiredBody;
		deadline: number | null;
	}> {
		const transport =
			options.fetcher ??
			createSafeHttpFetcher({
				timeoutMs: 15000,
				userAgent: "Eumenes/0.1 (llm-fetch/0.1.2)",
				allowedContentTypes: [
					"text/html",
					"text/plain",
					"application/xhtml+xml",
					"application/xml",
					"text/xml",
					"text/markdown",
					"application/json",
				],
			});
		let headers: Readonly<Record<string, string>> = {};
		let status = 200;
		let timing = { requestedAtMs: now(), receivedAtMs: now() };
		const client = createLlmFetch({
			cache: { enabled: false },
			// Scan ordinary pages with hundreds of metadata/attribute segments in
			// full; preserve denial when inspection is incomplete or finds an attack.
			contextGuard: { maxSegments: 4096, maxCharacters: 2_000_000 },
			readTimeoutMs: 15000,
			fetcher: async (target, input) => {
				const requestedAtMs = now();
				const response = await transport(target, input);
				timing = { requestedAtMs, receivedAtMs: now() };
				headers = response.headers;
				status = response.status;
				// JSON remains untrusted text and passes the same context guard. The transport still performs DNS/redirect checks.
				if (
					response.contentType?.split(";", 1)[0]?.trim() === "application/json"
				) {
					JSON.parse(new TextDecoder().decode(response.body));
					return {
						...response,
						contentType: "text/plain",
						headers: { ...response.headers, "content-type": "text/plain" },
					};
				}
				return response;
			},
		});
		try {
			const doc = await client.read({
				url,
				maxCharacters: 64000,
				render: "never",
				requestedUse: "answer_with_citation",
				signal,
			});
			if (doc.security.decision !== "allow")
				throw new LlmFetchError("GUARD_DENIED", "Guard refused", {
					// A warning is not an approval: report it as a plain denial.
					guardDecision:
						doc.security.decision === "allow_with_warning"
							? "deny"
							: doc.security.decision,
					guardReasonCodes: doc.security.reasonCodes,
				});
			const requested = new URL(url),
				final = new URL(doc.finalUrl);
			requested.hash = final.hash = "";
			const text = doc.text.replaceAll("\r\n", "\n");
			return {
				body: {
					url: doc.finalUrl,
					title: limited(doc.title, 500),
					text,
					fetchedAt: doc.fetchedAt,
					acquisitionTruncated: doc.truncated || status === 206,
				},
				document: {
					url: doc.finalUrl,
					title: limited(doc.title, 500),
					text: limited(text, 12000),
					fetchedAt: doc.fetchedAt,
					truncated: doc.truncated || status === 206 || text.length > 12000,
					trust: "untrusted",
					tainted: true,
					verification: "source_read",
					guardDecision: doc.security.decision,
					guardReasonCodes: [...(doc.security.reasonCodes ?? [])].slice(0, 16),
				},
				// The public fetch result exposes only final headers; redirect policy cannot be verified.
				deadline:
					status === 200 && requested.href === final.href
						? freshnessDeadline(headers, now(), timing)
						: null,
			};
		} finally {
			await client.close();
		}
	}
	return {
		async execute(request, signal) {
			const bodies: AcquiredBody[] = [];
			const result: ResearchResult = {
				provider: "llm-fetch@0.1.2",
				observedAt: new Date(now()).toISOString(),
				cache: "bypass",
				hits: [],
				documents: [],
				failures: [],
			};
			if (request.operation === "read") {
				const value = await read(request.url, signal);
				result.documents.push(value.document);
				bodies.push(value.body);
				return {
					result,
					bodies,
					freshUntilMs: request.retention === "stable" ? value.deadline : null,
				};
			}
			const hits = await hitsClient.search({
				query: request.query,
				limit: 5,
				language: request.language,
				region: request.region,
				timeRange: request.timeRange,
				signal,
			});
			const valid = hits.filter(
				(hit) => typeof hit.url === "string" && isPublicHttpUrl(hit.url),
			);
			if (valid.length < hits.length)
				log.info("web_research.hits_filtered", {
					count: hits.length - valid.length,
				});
			result.hits = valid.slice(0, 5).map((hit) => ({
				url: hit.url,
				title: limited(hit.title, 300),
				snippet: limited(hit.snippet, 500),
				provider: limited(hit.provider, 80),
				trust: "untrusted",
				tainted: true,
				verification: "search_summary",
			}));
			for (const hit of result.hits.slice(0, request.readPages)) {
				signal.throwIfAborted();
				try {
					const value = await read(hit.url, signal);
					result.documents.push(value.document);
					bodies.push(value.body);
				} catch (error) {
					signal.throwIfAborted();
					result.failures.push({
						url: hit.url,
						code: acquisitionError(error),
						...(error instanceof LlmFetchError
							? {
									guardDecision: error.guardDecision,
									guardReasonCodes: error.guardReasonCodes
										? [...error.guardReasonCodes].slice(0, 16)
										: undefined,
								}
							: {}),
					});
				}
			}
			return { result, bodies, freshUntilMs: null };
		},
		close: () => hitsClient.close(),
	};
}
