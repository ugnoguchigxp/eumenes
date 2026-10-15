/**
 * accepted/duplicate/conflict/rejected are final. pending (accepted for later settlement) and
 * indeterminate (the outcome is not known yet; the host reconciles the same operation) are
 * display states: neither is a confirmed success, and neither may be shown as a failure.
 */
export type Receipt = {
	status:
		| "accepted"
		| "duplicate"
		| "conflict"
		| "rejected"
		| "pending"
		| "indeterminate";
	message: string;
};
