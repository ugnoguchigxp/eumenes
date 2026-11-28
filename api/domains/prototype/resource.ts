import {
	formatResourceUri,
	parseResourceUri,
	type ResourceAdapter,
	type ResourceRef,
} from "../resources";
import type { PrototypeService } from "./service";

import { prototypeScreenRef } from "./contracts";
export function prototypeResource(work: PrototypeService): ResourceAdapter {
	const list = () => work.list().projects;
	const ref = (row: ReturnType<typeof list>[number]): ResourceRef => ({
		kind: "prototype",
		uri: formatResourceUri("prototype", row.id),
		label: row.name,
		createdAt: new Date(row.generation).toISOString(),
	});
	const find = (id: string) => list().find((row) => row.id === id);
	return {
		kind: "prototype",
		fromResultInTransaction(_db, result) {
			const refs = (result as { refs?: unknown } | null)?.refs;
			if (!Array.isArray(refs)) return [];
			return refs.flatMap((value) => {
				const parsed =
					typeof value === "string" ? parseResourceUri(value) : null;
				const row = parsed?.kind === "prototype" && find(parsed.id);
				return row ? [ref(row)] : [];
			});
		},
		getInTransaction(_db, id) {
			const row = find(id);
			return row
				? {
						...ref(row),
						adapterRef: prototypeScreenRef,
						targetRef: row.id,
						actions: ["open", "read"],
						preview: row.name + " (Works)",
					}
				: null;
		},
		async search(query, signal) {
			signal.throwIfAborted();
			return list()
				.filter((row) =>
					row.name.toLowerCase().includes(query.text.toLowerCase()),
				)
				.slice(0, query.limit)
				.map(ref);
		},
		async read(id, signal) {
			signal.throwIfAborted();
			const row = find(id);
			if (!row) throw new Error("prototype_not_found");
			return {
				text: `Works project: ${row.name}\nRegistration generation: ${row.generation}`,
			};
		},
	};
}
