import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ImageFrame } from "../../../../../packages/artifact-ui/src/components";
import {
	imageUrlSchema,
	type ArtifactRequest,
	type Snapshot,
} from "../../../../../packages/artifact-ui/src/contracts";
import { ArtifactRuntimeContext } from "../../../../../packages/artifact-ui/src/runtime";
afterEach(cleanup);

const request = {
	view: "generated-image",
	source: "img",
} as unknown as ArtifactRequest;
function show(resource: Record<string, unknown>) {
	const snapshot = {
		img: {
			kind: "generated-image",
			revision: 1,
			status: "succeeded",
			alt: "絵",
			...resource,
		},
	} as unknown as Snapshot;
	return render(
		<ArtifactRuntimeContext.Provider
			value={{ snapshot, dispatch: async () => ({}) as never }}
		>
			<ImageFrame request={request} />
		</ArtifactRuntimeContext.Provider>,
	);
}

test("image URLs are limited to https, blob and safe data schemes", () => {
	expect(imageUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
	expect(imageUrlSchema.safeParse("http://a.example/x.png").success).toBe(
		false,
	);
	expect(imageUrlSchema.safeParse("data:text/html;base64,AA").success).toBe(
		false,
	);
	expect(imageUrlSchema.safeParse("https://a.example/x.png").success).toBe(
		true,
	);
	expect(imageUrlSchema.safeParse("blob:https://a.example/id").success).toBe(
		true,
	);
	expect(imageUrlSchema.safeParse("data:image/png;base64,AA").success).toBe(
		true,
	);
});

test("download name follows the mime type", () => {
	show({ url: "https://a.example/x", mimeType: "image/png" });
	expect(
		screen
			.getByRole("link", { name: "画像をダウンロード" })
			.getAttribute("download"),
	).toBe("generated-image.png");
});

test("an unsafe URL renders no image or download", () => {
	show({ url: "javascript:alert(1)" });
	expect(screen.queryByRole("link", { name: "画像をダウンロード" })).toBeNull();
	expect(document.querySelector("img")).toBeNull();
});
