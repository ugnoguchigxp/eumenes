import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { readBounded } from "../../../infrastructure/bounded-read";
import { PHOTOS_SCOPE, type GoogleProvider } from "../contracts";
import type { PhotosView } from "../contracts/photos";
import type { createPersistence } from "./state";

const API = "https://photospicker.googleapis.com/v1";
const duration = z
	.string()
	.regex(/^\d+(\.\d{1,9})?s$/)
	.transform((s) => Number(s.slice(0, -1)) * 1000)
	.refine(Number.isFinite);
const sessionSchema = z.object({
	id: z.string().min(1).max(2048),
	pickerUri: z.url(),
	expireTime: z.iso.datetime({ offset: true }),
	mediaItemsSet: z.boolean().optional(),
	pollingConfig: z
		.object({ pollInterval: duration, timeoutIn: duration })
		.optional(),
});
const itemSchema = z.object({
	id: z.string().min(1).max(2048),
	type: z.literal("PHOTO"),
	mediaFile: z.object({
		baseUrl: z.url(),
		mimeType: z.string().startsWith("image/"),
	}),
});
export type PhotoSession = {
	handle: string;
	id: string;
	epoch: string;
	pickerUri: string;
	expires: number;
	pollAt: number;
	timeoutAt: number;
	ready: boolean;
	items: z.infer<typeof itemSchema>[];
};
export class PhotosError extends Error {
	constructor(
		public readonly code: string,
		public readonly status = 409,
	) {
		super(code);
	}
}
type Options = {
	store: SqliteStore;
	persistence: ReturnType<typeof createPersistence>;
	provider?: GoogleProvider;
	now: () => number;
	maintain: () => Promise<void>;
	fetch?: typeof fetch;
};
export function createPhotos(options: Options) {
	const {
		store,
		persistence: { load, write },
		now,
	} = options;
	const request = options.fetch ?? fetch;
	function account() {
		const s = store.read(load).state;
		if (
			s.status !== "connected" ||
			s.provider !== options.provider?.identity ||
			!s.tokens?.scopes?.includes(PHOTOS_SCOPE)
		)
			throw new PhotosError("photos_authorization_required");
		return { state: s, token: s.tokens.access };
	}
	function current(handle: string) {
		const { state, token } = account(),
			p = state.photos;
		if (!p || p.handle !== handle || p.epoch !== state.epoch)
			throw new PhotosError("photos_session_changed");
		if (p.expires <= now())
			throw new PhotosError("photos_session_expired", 410);
		return { state, token, session: p };
	}
	function view(p: PhotoSession): PhotosView {
		return {
			handle: p.handle,
			pickerUri: p.pickerUri,
			status:
				p.expires <= now() || (!p.ready && p.timeoutAt <= now())
					? "expired"
					: p.ready
						? "ready"
						: "pending",
			pollAfterMs: Math.max(0, p.pollAt - now()),
			timeoutAt: Math.min(p.timeoutAt, p.expires),
			items: p.items.map((i) => ({
				id: i.id,
				title: "Googleフォトで選んだ画像",
				thumbnailUrl: `/api/google-accounts/photos/${p.handle}/items/${encodeURIComponent(i.id)}/content`,
			})),
		};
	}
	async function api(
		path: string,
		token: string,
		signal: AbortSignal,
		method = "GET",
		body?: unknown,
	) {
		const r = await request(`${API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal,
			redirect: "error",
		});
		if (!r.ok) {
			await r.body?.cancel();
			throw new PhotosError(
				r.status === 403
					? "photos_permission_denied"
					: r.status === 401
						? "photos_authorization_required"
						: "photos_unavailable",
				r.status === 403 ? 403 : 503,
			);
		}
		if (method === "DELETE") {
			await r.body?.cancel();
			return undefined;
		}
		return JSON.parse(
			new TextDecoder().decode(
				await readBounded(r.body, {
					limit: 2_000_000,
					tooLarge: "photos_response_invalid",
					missing: "photos_response_invalid",
					signal,
				}),
			),
		);
	}
	async function save(p: PhotoSession, epoch: string, previous?: string) {
		await store.write((db) => {
			const s = load(db);
			if (
				s.state.epoch !== epoch ||
				s.state.status !== "connected" ||
				s.state.photos?.handle !== previous
			)
				throw new PhotosError("photos_session_changed");
			write(db, s.revision, { ...s.state, photos: p }, false);
		});
	}
	return {
		async begin(signal: AbortSignal) {
			await options.maintain();
			const { state, token } = account();
			if (state.photos) throw new PhotosError("photos_session_exists");
			const raw = sessionSchema.parse(
				await api("/sessions", token, signal, "POST", {
					pickingConfig: { maxItemCount: "1" },
				}),
			);
			const url = new URL(raw.pickerUri);
			if (
				url.protocol !== "https:" ||
				url.hostname !== "photos.google.com" ||
				url.username ||
				url.password ||
				url.hash
			)
				throw new PhotosError("photos_response_invalid", 502);
			const p: PhotoSession = {
				handle: crypto.randomUUID(),
				id: raw.id,
				epoch: state.epoch,
				pickerUri: raw.pickerUri,
				expires: Date.parse(raw.expireTime),
				pollAt: now() + (raw.pollingConfig?.pollInterval ?? 1000),
				timeoutAt: now() + (raw.pollingConfig?.timeoutIn ?? 600_000),
				ready: !!raw.mediaItemsSet,
				items: [],
			};
			try {
				await save(p, state.epoch);
			} catch (error) {
				await api(
					`/sessions/${encodeURIComponent(raw.id)}`,
					token,
					AbortSignal.timeout(15000),
					"DELETE",
				).catch(() => {});
				throw error;
			}
			return view(p);
		},
		async read(handle: string, signal: AbortSignal) {
			await options.maintain();
			const { session: p, token } = current(handle);
			if (p.ready || p.pollAt > now() || p.timeoutAt <= now()) return view(p);
			const raw = sessionSchema.parse(
				await api(`/sessions/${encodeURIComponent(p.id)}`, token, signal),
			);
			if (raw.id !== p.id)
				throw new PhotosError("photos_response_invalid", 502);
			const next = {
				...p,
				ready: !!raw.mediaItemsSet,
				pollAt: now() + (raw.pollingConfig?.pollInterval ?? 1000),
				timeoutAt: Math.min(
					p.timeoutAt,
					now() + (raw.pollingConfig?.timeoutIn ?? 600_000),
				),
			};
			if (next.ready) {
				const items = z
					.object({
						mediaItems: z.array(itemSchema).max(1),
						nextPageToken: z.string().optional(),
					})
					.parse(
						await api(
							`/mediaItems?sessionId=${encodeURIComponent(p.id)}&pageSize=1`,
							token,
							signal,
						),
					);
				if (items.nextPageToken)
					throw new PhotosError("photos_response_invalid", 502);
				next.items = items.mediaItems;
			}
			current(handle);
			await save(next, p.epoch, handle);
			return view(next);
		},
		async file(
			handle: string,
			id: string,
			signal: AbortSignal,
			thumbnail = false,
		) {
			await options.maintain();
			const { session: p, token } = current(handle),
				item = p.items.find((i) => i.id === id);
			if (!p.ready || !item)
				throw new PhotosError("photos_image_not_selected", 404);
			const u = new URL(item.mediaFile.baseUrl);
			if (
				u.protocol !== "https:" ||
				!(
					u.hostname === "googleusercontent.com" ||
					u.hostname.endsWith(".googleusercontent.com")
				) ||
				u.username ||
				u.password ||
				u.hash ||
				(u.port && u.port !== "443")
			)
				throw new PhotosError("photos_response_invalid", 502);
			const r = await request(`${u.href}${thumbnail ? "=w400-h400" : "=d"}`, {
				headers: { Authorization: `Bearer ${token}` },
				signal,
				redirect: "error",
			});
			if (!r.ok) {
				await r.body?.cancel();
				throw new PhotosError("photos_download_failed", 502);
			}
			const mime = r.headers.get("Content-Type")?.split(";")[0] ?? "";
			const bytes = await readBounded(r.body, {
				limit: 16 * 1024 * 1024,
				tooLarge: "photos_image_too_large",
				missing: "photos_download_failed",
				signal,
			});
			current(handle);
			if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
				throw new PhotosError("photos_image_unsupported", 415);
			return new File([new Uint8Array(bytes)], "photo", { type: mime });
		},
		assertCurrent: (handle: string) => {
			current(handle);
		},
		status: () => {
			const { state } = account();
			const p = state.photos;
			return p && p.epoch === state.epoch ? view(p) : null;
		},
		async cancel(handle: string, signal: AbortSignal) {
			const { state, token } = account(),
				p = state.photos;
			if (!p || p.handle !== handle || p.epoch !== state.epoch)
				throw new PhotosError("photos_session_changed");
			await store.write((db) => {
				const s = load(db);
				if (s.state.photos?.handle === handle)
					write(db, s.revision, { ...s.state, photos: undefined }, false);
			});
			await api(
				`/sessions/${encodeURIComponent(p.id)}`,
				token,
				signal,
				"DELETE",
			).catch(() => {});
		},
	};
}
