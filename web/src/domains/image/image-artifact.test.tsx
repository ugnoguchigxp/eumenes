import { afterEach, expect, it, vi } from "vitest";
import {
	cleanup,
	render,
	screen,
	fireEvent,
	waitFor,
} from "@testing-library/react";
import { ArtifactRenderer } from "@eumenes/artifact-ui";
import { compileArtifact } from "@eumenes/artifact-ui";
import type { ImageWorkspaceResource } from "@eumenes/artifact-ui/contracts";
afterEach(cleanup);
const image: ImageWorkspaceResource = {
	kind: "image-workspace",
	revision: 1,
	identity: "studio",
	defaults: { prompt: "森", width: 512, height: 512, format: "webp", seed: 0 },
	images: [
		{
			id: "past",
			title: "保存画像",
			url: "/api/images/past/content",
			width: 512,
			height: 512,
			format: "webp",
			createdAt: "2026-10-13T00:00:00Z",
		},
	],
};
it("individual OpenUI gallery dispatches confirmed deletion through its authorized source", async () => {
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "画像を削除しました。",
	}));
	render(
		<ArtifactRenderer
			definition={JSON.stringify({ view: "image-gallery", source: "images" })}
			runtime={{ snapshot: { images: image }, dispatch }}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "保存画像を削除" }));
	expect(dispatch).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await waitFor(() =>
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "images",
				revision: 1,
				action: "image-delete",
				values: { id: "past" },
			}),
		),
	);
	await waitFor(() =>
		expect(screen.getByText("画像を削除しました。")).toBeTruthy(),
	);
});
it("image workspace composes with explanation UI, uses authorized sources and dispatches values", () => {
	const definition = JSON.stringify({
		view: "layout",
		children: [
			{ view: "image-workspace", source: "images" },
			{ view: "components", source: "explanation" },
		],
	});
	const snapshot = {
		images: image,
		explanation: { kind: "components" as const, revision: 1 },
	};
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "受付",
	}));
	expect(compileArtifact(definition, snapshot).lang).toContain("Composition");
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot, dispatch }}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "画像を生成" }));
	expect(
		screen
			.getByRole("img", { name: "保存画像", hidden: true })
			.getAttribute("src"),
	).toBe("/api/images/past/content");
	expect(dispatch).toHaveBeenCalledWith(
		expect.objectContaining({
			source: "images",
			action: "image-generate",
			values: {
				prompt: "森",
				width: "512",
				height: "512",
				format: "webp",
				seed: "0",
			},
		}),
	);
	expect(() =>
		compileArtifact(definition, { ...snapshot, images: explain() }),
	).toThrow("source");
	expect(() => compileArtifact(definition, {})).toThrow("source");
});
function explain() {
	return { kind: "components" as const, revision: 1 };
}

it("individual image views compile with one authorized source and compose through OpenUI", () => {
	const definition = JSON.stringify({
		view: "layout",
		direction: "grid",
		children: [
			{ view: "image-preview", source: "images" },
			{ view: "image-creation-form", source: "images" },
			{ view: "image-gallery", source: "images" },
		],
	});
	expect(compileArtifact(definition, { images: image }).lang).toContain(
		"Composition",
	);
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot: { images: image },
				dispatch: vi.fn(async () => ({
					status: "accepted" as const,
					message: "受付",
				})),
			}}
		/>,
	);
	expect(screen.getByLabelText("画像作成プロンプト")).toBeTruthy();
	expect(screen.getByRole("button", { name: "保存画像を表示" })).toBeTruthy();
	for (const view of ["image-preview", "image-creation-form", "image-gallery"])
		expect(() =>
			compileArtifact(JSON.stringify({ view, source: "wrong" }), {
				wrong: explain(),
			}),
		).toThrow("source");
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "image-workspace",
				source: "images",
				presentation: "arbitrary",
			}),
			{ images: image },
		),
	).toThrow();
});

it("OpenUI image artifact defaults to Qwen and sends the explicitly selected preparation model", async () => {
	const definition = {
		view: "image-workspace",
		source: "image-studio",
		creationOptions: {
			styleGroups: [{ label: "画風", options: ["写真"] }],
			moods: ["落ち着いた"],
			compositions: ["おまかせ"],
			lighting: ["おまかせ"],
			defaults: {
				width: 512,
				height: 512,
				format: "webp",
				seed: 0,
				model: "qwen-image-2.1-turbo",
			},
			models: [
				{ value: "qwen-image-2.1-turbo", label: "Qwen Turbo（既定）" },
				{
					value: "flux-3-image-klein",
					label: "FLUX 3 Image Klein（準備中）",
					description:
						"準備中です。LARMへの配置・実生成確認・本番配備は未完了です。",
				},
			],
		},
	};
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "受付",
	}));
	render(
		<ArtifactRenderer
			definition={JSON.stringify(definition)}
			runtime={{ snapshot: { "image-studio": image }, dispatch }}
		/>,
	);
	expect(screen.getByLabelText("推論モデル")).toHaveProperty(
		"value",
		"qwen-image-2.1-turbo",
	);
	fireEvent.change(screen.getByLabelText("推論モデル"), {
		target: { value: "flux-3-image-klein" },
	});
	expect(
		screen.getByText(
			"準備中です。LARMへの配置・実生成確認・本番配備は未完了です。",
		),
	).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "画像を生成" }));
	await waitFor(() =>
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "image-generate",
				values: {
					prompt: "森",
					model: "flux-3-image-klein",
					width: "512",
					height: "512",
					format: "webp",
					seed: "0",
				},
			}),
		),
	);
});
