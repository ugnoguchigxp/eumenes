import { useEffect, useRef, useState } from "react";

/**
 * Object URLs for authenticated images, loaded once per id and revoked when the id leaves the
 * list or the screen unmounts.
 */
export function useBlobUrls(
	ids: readonly string[],
	load: (id: string) => Promise<Blob>,
): Readonly<Record<string, string>> {
	const [urls, setUrls] = useState<Record<string, string>>({});
	const store = useRef(new Map<string, string>());
	const pending = useRef(new Set<string>());
	const alive = useRef(true);
	const wantedIds = useRef(new Set<string>());
	const loader = useRef(load);
	useEffect(() => {
		loader.current = load;
	});
	useEffect(() => {
		const current = store.current;
		alive.current = true;
		return () => {
			alive.current = false;
			for (const url of current.values()) URL.revokeObjectURL(url);
			current.clear();
		};
	}, []);
	const key = ids.join("\n");
	useEffect(() => {
		const wanted = new Set(key ? key.split("\n") : []);
		wantedIds.current = wanted;
		let changed = false;
		for (const [id, url] of store.current)
			if (!wanted.has(id)) {
				URL.revokeObjectURL(url);
				store.current.delete(id);
				changed = true;
			}
		if (changed) setUrls(Object.fromEntries(store.current));
		for (const id of wanted) {
			if (store.current.has(id) || pending.current.has(id)) continue;
			pending.current.add(id);
			loader
				.current(id)
				.then((blob) => {
					if (
						!alive.current ||
						!wantedIds.current.has(id) ||
						store.current.has(id)
					)
						return;
					store.current.set(id, URL.createObjectURL(blob));
					setUrls(Object.fromEntries(store.current));
				})
				.catch(() => {})
				.finally(() => pending.current.delete(id));
		}
	}, [key]);
	return urls;
}
