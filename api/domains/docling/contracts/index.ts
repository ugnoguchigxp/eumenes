import { z } from "zod";

export const doclingStatus = z.strictObject({
	revision: z.number().int().nonnegative(),
	configured: z.boolean(),
	publicOrigin: z.string().url().nullable(),
});
export const doclingTicket = z.strictObject({
	url: z.string().url(),
	expiresIn: z.number().int().positive().max(60),
});
export const doclingPrepared = z.strictObject({
	action: z.literal("open"),
	state: z.literal("ready_for_open"),
});
export const errorStatus = {
	docling_unconfigured: 503,
	docling_open_in_progress: 409,
	docling_connection_changed: 409,
	docling_cancelled: 409,
	docling_timeout: 503,
	docling_unreachable: 503,
	docling_auth_failed: 502,
	docling_upstream_failed: 502,
	docling_invalid_response: 502,
} as const;

/** Backend-only connection, injected from the settings public operations. */
export type DoclingConnection = {
	revision: number;
	version: string;
	gatewayUrl: string;
	publicOrigin: string;
	credential: string;
};
