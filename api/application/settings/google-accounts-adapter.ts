import type { GoogleAccounts } from "../../domains/google-accounts";
import type { DomainAdapter } from "../../domains/tool-runtime";
export const GOOGLE_ACCOUNTS_ADAPTER_REF = "adapter:google-accounts@1";
export const describeGoogleAccountsAdapter = () => ({
	owner: "google-accounts",
	operations: new Map(),
	queries: new Set(["query:google-accounts.status@1"]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:google-accounts@1",
});
/** Public projection only. OAuth browser redirects never enter the action ledger or AI tools. */
export function createGoogleAccountsAdapter(
	service: Pick<GoogleAccounts, "viewInTransaction">,
): DomainAdapter {
	return {
		ref: GOOGLE_ACCOUNTS_ADAPTER_REF,
		describe: describeGoogleAccountsAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction: () => {
			throw new Error("capability_unavailable");
		},
		readInTransaction: () => null,
		targetInput: () => ({}),
		sourceInTransaction(db, query) {
			if (query !== "query:google-accounts.status@1") return null;
			const data = service.viewInTransaction(db);
			return { revision: data.revision, data };
		},
	};
}
