import type { Context } from "hono";
import type { z } from "zod";

export type ParseJsonBodyOptions = {
	/** Error code of the 400 response. Defaults to `invalid_input`. */
	code?: string;
	/** Value validated in place of a body that is empty (not malformed). */
	emptyAs?: unknown;
};

export type ParsedJsonBody<T> =
	| { ok: true; data: T }
	| { ok: false; response: Response };

/**
 * Reads the request body as JSON and validates it. A body that is not JSON, or that the schema
 * rejects, yields the ready-made 400 response so every controller answers the same way.
 */
export async function parseJsonBody<T>(
	c: Context,
	schema: z.ZodType<T>,
	options: ParseJsonBodyOptions = {},
): Promise<ParsedJsonBody<T>> {
	let raw: unknown = null;
	try {
		const text = await c.req.text();
		raw =
			"emptyAs" in options && text.trim() === ""
				? options.emptyAs
				: JSON.parse(text);
	} catch {
		// Unreadable or malformed body: validated as null, so the schema rejects it.
		raw = null;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		return {
			ok: false,
			response: c.json({ error: options.code ?? "invalid_input" }, 400),
		};
	return { ok: true, data: parsed.data };
}

/** HTTP statuses a thrown error code may map to; each domain declares its own in `contracts`. */
export type HttpErrorStatus =
	| 400
	| 401
	| 403
	| 404
	| 409
	| 410
	| 411
	| 413
	| 415
	| 422
	| 429
	| 502
	| 503;
