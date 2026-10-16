import { z } from "zod";
import type { GoogleAccountView } from "../api/domains/google-accounts/contracts";
import { callJson, json, type Transport } from "./transport";

const googleAccountViewSchema: z.ZodType<GoogleAccountView> = z.object({
	revision: z.number().int().nonnegative(),
	configured: z.boolean(),
	status: z.enum(["disconnected", "connected", "reconnect", "disconnecting"]),
	profile: z
		.object({
			sub: z.string(),
			name: z.string(),
			email: z.string(),
			picture: z.string().optional(),
		})
		.optional(),
	pending: z.boolean(),
	result: z.enum(["connected", "cancelled", "failed", "expired"]).optional(),
});
const connectSchema = z.object({ url: z.string() });

export function googleAccountsClient(transport: Transport) {
	const change = (
		operation: "cancel" | "disconnect",
		expectedRevision: number,
	) =>
		callJson(
			transport,
			googleAccountViewSchema,
			`/api/google-accounts/${operation}`,
			json({ expectedRevision }),
		);
	return {
		googleAccount: (): Promise<GoogleAccountView> =>
			callJson(transport, googleAccountViewSchema, "/api/google-accounts"),
		connectGoogleAccount: (
			expectedRevision: number,
		): Promise<{ url: string }> =>
			callJson(
				transport,
				connectSchema,
				"/api/google-accounts/connect",
				json({ expectedRevision }),
			),
		cancelGoogleAccount: (
			expectedRevision: number,
		): Promise<GoogleAccountView> => change("cancel", expectedRevision),
		disconnectGoogleAccount: (
			expectedRevision: number,
		): Promise<GoogleAccountView> => change("disconnect", expectedRevision),
	};
}
