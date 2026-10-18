import { readBounded } from "../../../infrastructure/bounded-read";
import type { LogFields } from "../../../infrastructure/logger";

// Provider values are never free-form log text. Unknown codes and IDs stay private.
const codes = new Set([
	"unauthorized",
	"forbidden",
	"invalid_request",
	"not_found",
	"connection_idle_released",
	"body_too_large",
	"context_budget_exceeded",
	"chat_token_count_unavailable",
	"chat_input_contract_unavailable",
	"gateway_timeout",
]);
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const requestId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const epoch = new RegExp(`^epoch-${uuid}$`, "i");

export function tokenCountResponseIds(
	value: {
		bootEpoch?: unknown;
		configRevision?: unknown;
	},
	secret: string,
): LogFields {
	return {
		...(typeof value.bootEpoch === "string" &&
		value.bootEpoch !== secret &&
		epoch.test(value.bootEpoch)
			? { bootEpoch: value.bootEpoch }
			: {}),
		...(typeof value.configRevision === "string" &&
		value.configRevision !== secret &&
		/^[a-f0-9]{64}$/i.test(value.configRevision)
			? { configRevision: value.configRevision }
			: {}),
	};
}

export function tokenCountResponseHeaders(
	response: Response,
	secret: string,
): LogFields {
	const id = response.headers.get("X-Request-Id");
	return {
		status: response.status,
		...(id && id !== secret && requestId.test(id)
			? { upstreamRequestId: id }
			: {}),
	};
}

/** Diagnostic reading is bounded and cannot change the original rejection or trigger a retry. */
export async function tokenCountRejection(
	response: Response,
	signal: AbortSignal,
	secret: string,
): Promise<LogFields> {
	try {
		const bytes = await readBounded(response.body, {
			limit: 16384,
			tooLarge: "diagnostic_unavailable",
			missing: "diagnostic_unavailable",
			signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
		});
		const value = JSON.parse(new TextDecoder().decode(bytes));
		const error = value?.error;
		const code = typeof error === "string" ? error : error?.code;
		return {
			validationCode: codes.has(code) ? code : "unknown",
			...tokenCountResponseIds(
				{
					bootEpoch: error?.bootEpoch ?? value?.bootEpoch,
					configRevision: error?.configRevision ?? value?.configRevision,
				},
				secret,
			),
		};
	} catch {
		return { validationCode: "unavailable" };
	}
}
