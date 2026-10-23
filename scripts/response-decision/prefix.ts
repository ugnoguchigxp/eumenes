import { commonPrefixBytes } from "../../api/domains/dialogue/eval/context/prefix-stability";

/** Observes real outgoing JSON in memory. It never retains headers, URLs, bodies or hashes in reports. */
export function wirePrefixObserver() {
	let previous: Buffer | undefined;
	let previousBody: Record<string, unknown> | undefined;
	return (body: Record<string, unknown>) => {
		const next = Buffer.from(JSON.stringify(body));
		let changed = "first_call";
		if (previousBody) {
			changed = "unchanged";
			for (const key of new Set([
				...Object.keys(previousBody),
				...Object.keys(body),
			])) {
				if (JSON.stringify(previousBody[key]) === JSON.stringify(body[key]))
					continue;
				changed = key;
				if (
					key === "messages" &&
					Array.isArray(body.messages) &&
					Array.isArray(previousBody.messages)
				) {
					const index = body.messages.findIndex(
						(m, i) =>
							JSON.stringify(m) !==
							JSON.stringify((previousBody!.messages as unknown[])[i]),
					);
					changed = `messages[${index < 0 ? body.messages.length : index}]`;
				}
				break;
			}
		}
		const result = {
			bytes: next.length,
			previousBytes: previous?.length ?? null,
			commonBytes: previous ? commonPrefixBytes(previous, next) : null,
			firstChanged: changed,
		};
		previous = next;
		previousBody = body;
		return result;
	};
}
