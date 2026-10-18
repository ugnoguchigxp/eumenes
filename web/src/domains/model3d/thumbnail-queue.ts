export type ThumbnailState =
	| { status: "loading" }
	| { status: "ready"; url: string }
	| { status: "error" };
type Entry = {
	id: string;
	state: ThumbnailState;
	listeners: Set<(state: ThumbnailState) => void>;
	abort: AbortController;
};

/** A single renderer serializes visible-card work; no GLB or URL survives its last viewer. */
export function createThumbnailQueue(options: {
	load: (id: string, signal: AbortSignal) => Promise<ArrayBuffer>;
	render: (bytes: ArrayBuffer) => Promise<Blob>;
	dispose: () => void;
}) {
	const entries = new Map<string, Entry>();
	const pending: Entry[] = [];
	let running = false;
	async function drain() {
		if (running) return;
		running = true;
		try {
			while (pending.length) {
				const entry = pending.shift()!;
				if (entry.abort.signal.aborted) continue;
				try {
					const bytes = await options.load(entry.id, entry.abort.signal);
					if (entry.abort.signal.aborted) continue;
					const blob = await options.render(bytes);
					if (entry.abort.signal.aborted) continue;
					entry.state = { status: "ready", url: URL.createObjectURL(blob) };
				} catch {
					if (entry.abort.signal.aborted) continue;
					entry.state = { status: "error" };
					options.dispose();
				}
				for (const listener of entry.listeners) listener(entry.state);
			}
		} finally {
			running = false;
			if (!entries.size) options.dispose();
		}
	}
	return {
		request(id: string, listener: (state: ThumbnailState) => void) {
			let entry = entries.get(id);
			if (!entry) {
				entry = {
					id,
					state: { status: "loading" },
					listeners: new Set(),
					abort: new AbortController(),
				};
				entries.set(id, entry);
				pending.push(entry);
			}
			entry.listeners.add(listener);
			listener(entry.state);
			void drain();
			const retained = entry;
			return () => {
				retained.listeners.delete(listener);
				if (retained.listeners.size) return;
				retained.abort.abort();
				if (retained.state.status === "ready")
					URL.revokeObjectURL(retained.state.url);
				if (entries.get(id) === retained) entries.delete(id);
				if (!entries.size && !running) options.dispose();
			};
		},
	};
}
