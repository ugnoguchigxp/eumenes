const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const UNSAFE = new RegExp(`[<>&${LINE_SEPARATORS}]`, "g");
const escapeChar = (char: string) =>
	`\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
/**
 * JSON for reference data: `<`, `>`, `&` and the line separators are \uXXXX escapes, so no text inside can forge a
 * delimiter or a tag around it. Other characters (Japanese included) stay as they are.
 */
export function referenceJson(value: unknown): string {
	return JSON.stringify(value).replace(UNSAFE, escapeChar);
}
