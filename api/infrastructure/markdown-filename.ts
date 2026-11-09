/** Limit a title to a safe filename stem without changing the title itself. */
export function documentName(title: string) {
	return [...title]
		.map((c) => {
			const code = c.codePointAt(0)!;
			return code < 32 || code === 127 || c === "/" || c === "\\" ? "_" : c;
		})
		.slice(0, 80)
		.join("")
		.trim();
}
