import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EumenesClient } from "../../../client";
import { GooglePhotoPicker } from "./GooglePhotoPicker";
afterEach(cleanup);
it("imports only an explicitly selected photo, then hands its LARM ID to the common picker", async () => {
	const onSelect = vi.fn();
	const id = crypto.randomUUID();
	const importGooglePhoto = vi.fn(async () => ({
		status: "succeeded",
		artifact: { id: "image_imported", width: 2000, height: 1000 },
	}));
	const cancelGooglePhotos = vi.fn(async () => {});
	const client = {
		identity: "fixture",
		googleAccount: async () => ({
			revision: 1,
			configured: true,
			pending: false,
			status: "connected",
			photosAuthorized: true,
		}),
		googlePhotos: async () => null,
		startGooglePhotos: async () => ({
			handle: id,
			pickerUri: "https://photos.google.com/picker/test",
			status: "ready",
			pollAfterMs: 1000,
			timeoutAt: Date.now() + 60_000,
			items: [{ id: "photo", title: "選んだ写真", thumbnailUrl: "/preview" }],
		}),
		importGooglePhoto,
		cancelGooglePhotos,
	} as unknown as EumenesClient;
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={query}>
			<GooglePhotoPicker client={client} onSelect={onSelect} />
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(
			(
				screen.getByRole("button", {
					name: "Googleフォトで選ぶ",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "Googleフォトで選ぶ" }));
	await screen.findByRole("button", { name: "選んだ写真を選ぶ" });
	expect(importGooglePhoto).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "選んだ写真を選ぶ" }));
	fireEvent.click(screen.getByRole("button", { name: "この写真を取り込む" }));
	await waitFor(() =>
		expect(onSelect).toHaveBeenCalledWith({
			id: "image_imported",
			title: "Googleフォトから取り込んだ画像",
			thumbnailUrl: "/api/images/image_imported/content",
		}),
	);
	expect(importGooglePhoto.mock.calls[0]?.slice(1, 3)).toEqual([id, "photo"]);
	expect(cancelGooglePhotos).toHaveBeenCalledWith(id);
	view.unmount();
	query.clear();
});
