import type { MiddlewareHandler } from "hono";

/**
 * Reject requests above `max` in flight with 429. For request/response routes only:
 * never for streams (SSE), whose body outlives the handler.
 */
export function limitConcurrency(
	max: number,
	code = "too_many_requests",
): MiddlewareHandler {
	let active = 0;
	return async (c, next) => {
		if (active >= max) return c.json({ error: code }, 429);
		active++;
		try {
			await next();
		} finally {
			active--;
		}
	};
}
