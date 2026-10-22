/** Serializable document values; files are references, never URLs or binary data. */
export type PipelineMaterial =
	| { kind: "text"; text: string }
	| { kind: "value"; value: unknown }
	| { kind: "request" }
	| { kind: "prompt"; stepId: string }
	| { kind: "reference"; reference: string }
	| { kind: "result"; stepId: string }
	| { kind: "image" | "music"; id: string; title: string };

export type PipelineHandoffDocument = {
	inputs: Record<
		string,
		{ description: string; required: boolean; default?: unknown }
	>;
	steps: Array<{
		id: string;
		title: string;
		kind: string;
		request?: string;
		materials?: PipelineMaterial[];
	}>;
	tests?: Array<{
		stepResults: Record<
			string,
			{ summary?: string; output?: unknown; value?: unknown }
		>;
	}>;
};

export type PipelineMediaLibrary = {
	kind: "image" | "music" | null;
	loading: boolean;
	error?: string;
	query: string;
	images: Array<{ id: string; title: string; thumbnailUrl?: string }>;
	tracks: Array<{
		id: string;
		title: string;
		durationSeconds: number;
		audioUrl: string;
	}>;
	hasMore?: boolean;
};

export function handoffDocument(
	source: string,
): PipelineHandoffDocument | null {
	try {
		const value = JSON.parse(source);
		return value &&
			Array.isArray(value.steps) &&
			value.inputs &&
			typeof value.inputs === "object"
			? value
			: null;
	} catch {
		return null;
	}
}

export function materialLabel(
	material: PipelineMaterial,
	document: PipelineHandoffDocument,
): string {
	const title = (id: string) =>
		document.steps.find((step) => step.id === id)?.title ?? id;
	switch (material.kind) {
		case "text":
			return `本文：${material.text.slice(0, 40)}${material.text.length > 40 ? "…" : ""}`;
		case "value":
			return `固定の値：${JSON.stringify(material.value).slice(0, 40)}`;
		case "request":
			return "実行時の依頼文（全文）";
		case "prompt":
			return `${title(material.stepId)}のプロンプト（原文）`;
		case "reference":
			return material.reference;
		case "result":
			return `${title(material.stepId)}の結果全体`;
		case "image":
			return `画像：${material.title}`;
		case "music":
			return `楽曲：${material.title}`;
	}
}

/** JSON numbers must remain JSON values after serializing the draft. */
export function parseFixedValue(text: string): unknown {
	return JSON.parse(text, (_key, value: unknown) => {
		if (typeof value === "number" && !Number.isFinite(value))
			throw new Error("invalid_json_number");
		return value;
	});
}
