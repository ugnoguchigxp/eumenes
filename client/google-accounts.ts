import { json, type Transport } from "./transport";
import type { GoogleAccountView } from "../api/domains/google-accounts/contracts";
export function googleAccountsClient(transport: Transport) {
	return {
		googleAccount: async (): Promise<GoogleAccountView> =>
			(await transport.call("/api/google-accounts")).json(),
		connectGoogleAccount: async (
			expectedRevision: number,
		): Promise<{ url: string }> =>
			(
				await transport.call(
					"/api/google-accounts/connect",
					json({ expectedRevision }),
				)
			).json(),
		cancelGoogleAccount: async (
			expectedRevision: number,
		): Promise<GoogleAccountView> =>
			(
				await transport.call(
					"/api/google-accounts/cancel",
					json({ expectedRevision }),
				)
			).json(),
		disconnectGoogleAccount: async (
			expectedRevision: number,
		): Promise<GoogleAccountView> =>
			(
				await transport.call(
					"/api/google-accounts/disconnect",
					json({ expectedRevision }),
				)
			).json(),
	};
}
