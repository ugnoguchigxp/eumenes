import { expect, test } from "bun:test";
import { Hono } from "hono";
import { answerError } from "../app";
import { registerGooglePhotoImport } from "./google-photo-import";
import type { ImageImportView } from "../../domains/image/contracts";
const handle = crypto.randomUUID(),
	id = crypto.randomUUID();
const ready: ImageImportView = {
	requestId: id,
	status: "succeeded",
	createdAt: 1,
	expiresAt: 2,
	retryAfterMs: 1000,
};
function fixture() {
	const calls: string[] = [];
	let stored = false,
		current = true;
	const image = {
		imports: {
			async resume(key: string) {
				calls.push(`resume:${key}`);
				if (!stored) throw new Error("image_import_not_found");
				return ready;
			},
			async upload(key: string, file: File) {
				calls.push(`upload:${key}:${file.type}`);
				stored = true;
				return ready;
			},
			async read() {
				return ready;
			},
		},
	};
	const google = {
		photos: {
			assertCurrent(value: string) {
				expect(value).toBe(handle);
				if (!current) throw new Error("photos_session_changed");
			},
			async file(_handle: string, item: string) {
				calls.push(`file:${item}`);
				return new File(["photo"], "photo", { type: "image/jpeg" });
			},
		},
	};
	const app = new Hono();
	app.onError(answerError);
	registerGooglePhotoImport(app, image, google);
	const send = (body: unknown = { handle, itemId: "selected-photo" }) =>
		app.request(`/api/images/imports/${id}/google-photo`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	return {
		send,
		calls,
		changed: () => {
			current = false;
		},
	};
}
test("Google import composes selected-photo access with the existing import, then reuses the persisted UUID", async () => {
	const h = fixture();
	expect((await h.send()).status).toBe(200);
	expect((await h.send()).status).toBe(200);
	expect(h.calls).toEqual([
		`resume:${id}`,
		"file:selected-photo",
		`upload:${id}:image/jpeg`,
		`resume:${id}`,
	]);
});
test("changed Google selection and arbitrary URL input cannot resume or download an old photo", async () => {
	const h = fixture();
	h.changed();
	const r = await h.send();
	expect(r.status).toBe(409);
	expect(await r.json()).toEqual({ error: "photos_session_changed" });
	expect(h.calls).toEqual([]);
	expect(
		(
			await h.send({
				handle,
				itemId: "selected-photo",
				url: "https://arbitrary.example/photo",
			})
		).status,
	).toBe(400);
});
