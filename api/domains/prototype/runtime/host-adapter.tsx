import { createRoot, type Root } from "react-dom/client";

type Asset = { id: string; label: string };
type Generation = {
	operationId: string;
	state: "generating" | "completed" | "failed" | "cancelled";
	phase: string;
	errorCode: string | null;
};
type Images = {
	assets(): Promise<Asset[]>;
	read(id: string): Promise<Blob>;
	generations(): Promise<Generation[]>;
	status(operation: string): Promise<Generation>;
	content(operation: string): Promise<Blob>;
	sample(path: string): Promise<Blob>;
};
export type Adapter = {
	mode: "eumenes" | "sample";
	asset(path: string): string;
	features(): Promise<Array<"library.image.read" | "media.image.generate">>;
	suggestImage(prompt: string): Promise<void>;
	images: Images;
};

function bridge() {
	let port: MessagePort | undefined;
	let identity:
		{ project: string; version: string; session: string } | undefined;
	const listeners = new Set<() => void>();
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (
			event.source !== window.parent ||
			window.parent === window ||
			!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(event.origin) ||
			data?.type !== "eumenes-works-images" ||
			!event.ports[0] ||
			location.hostname !== "p-" + data.project + ".localhost" ||
			location.pathname !== "/v/" + data.session + "/" ||
			!/^[a-f0-9]{64}$/.test(data.version)
		)
			return;
		port?.close();
		port = event.ports[0];
		identity = {
			project: data.project,
			version: data.version,
			session: data.session,
		};
		for (const notify of listeners) notify();
	});
	return async <T,>(method: string, value?: string): Promise<T> => {
		if (!port)
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					clearTimeout(timer);
					listeners.delete(done);
					resolve();
				};
				const timer = setTimeout(() => {
					listeners.delete(done);
					reject(new Error("works_image_channel_unavailable"));
				}, 3000);
				listeners.add(done);
			});
		const current = port!;
		return new Promise<T>((resolve, reject) => {
			const id = crypto.randomUUID();
			const expire = setTimeout(() => {
				current.removeEventListener("message", receive);
				reject(new Error("works_image_request_timeout"));
			}, 32_000);
			const receive = (event: MessageEvent) => {
				if (event.data?.id !== id) return;
				clearTimeout(expire);
				current.removeEventListener("message", receive);
				if (event.data.ok) resolve(event.data.value);
				else reject(new Error(event.data.error));
			};
			current.addEventListener("message", receive);
			current.start();
			current.postMessage({ ...identity, id, method, value });
		});
	};
}

export function mount(
	render: (context: { adapter: Adapter; root: Root }) => void,
) {
	const call = bridge();
	if (window.parent !== window) {
		const beat = () =>
			window.parent.postMessage({ type: "eumenes-prototype-heartbeat" }, "*");
		beat();
		setInterval(beat, 1_000);
	}
	const root = createRoot(document.getElementById("app")!);
	render({
		adapter: {
			mode: "eumenes",
			asset: (path) => new URL(path, document.baseURI).href,
			features: () => call("features"),
			suggestImage: (prompt) => call("suggest", prompt),
			images: {
				assets: () => call("assets"),
				read: (id) => call("read", id),
				generations: () => call("generations"),
				status: (id) => call("status", id),
				content: (id) => call("content", id),
				sample: async () => {
					throw new Error("works_sample_only");
				},
			},
		},
		root,
	});
}
