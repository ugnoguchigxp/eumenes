/** Only protocol-safe codes escape. Response bodies, credentials and paths are never error messages. */
export class DocumentFileError extends Error {
	constructor(
		readonly code: string,
		readonly status: number | null,
		readonly uncertain = false,
	) {
		super(code);
	}
}
