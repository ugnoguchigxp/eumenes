import { createRoot, type Root } from "react-dom/client";
import type { Adapter } from "./host-adapter";
export type { Adapter } from "./host-adapter";

export function mount(
	render: (context: { adapter: Adapter; root: Root }) => void,
) {
	const root = createRoot(document.getElementById("app")!);
	const noRemote = async (): Promise<never> => {
		throw new Error("works_sample_requires_local_asset");
	};
	const sample = async (path: string) => {
		if (
			!/^samples\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(png|webp|svg)$/.test(
				path,
			)
		)
			throw new Error("works_sample_path_invalid");
		const result = await fetch(new URL(path, document.baseURI));
		if (!result.ok) throw new Error("works_sample_missing");
		return result.blob();
	};
	render({
		adapter: {
			mode: "sample",
			asset: (path) => new URL(path, document.baseURI).href,
			features: async () =>
				document.querySelector('meta[name="works-image-samples"]')
					? ["library.image.read"]
					: [],
			suggestImage: noRemote,
			images: {
				assets: async () => [],
				read: noRemote,
				generations: async () => [],
				status: noRemote,
				content: noRemote,
				sample,
			},
		},
		root,
	});
}
