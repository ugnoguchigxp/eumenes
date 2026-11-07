import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";

/** The resource kind of a scratch file: `eumenes://scratch/<uuid>`. */
export const SCRATCH_RESOURCE_KIND = "scratch";
export const SCRATCH_ADAPTER_REF = "adapter:scratch@1";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** spec/server-scratch-cache-design-2026-11-07.md §5・§6. */
export const scratchLimits = {
	/** Above this total a write first evicts. */
	capacityBytes: 2 * GiB,
	/** What an eviction brings the total down to. */
	targetBytes: 1.5 * GiB,
	/** Less free space on the volume than this counts as over capacity. */
	minFreeBytes: 5 * GiB,
	itemBytes: 100 * MiB,
	/** One `scratch.write` of a sub-agent. */
	writeBytes: 1 * MiB,
	items: 2000,
	leaseMs: 30 * 60_000,
	nameChars: 120,
};

export const scratchImageMimes = [
	"image/jpeg",
	"image/png",
	"image/bmp",
	"image/webp",
] as const;
export const scratchTextMimes = [
	"text/markdown",
	"text/plain",
	"text/csv",
	"application/json",
] as const;
export const scratchMimes = [
	...scratchImageMimes,
	...scratchTextMimes,
	"application/pdf",
	"model/gltf-binary",
] as const;
export type ScratchMime = (typeof scratchMimes)[number];
export const scratchMime = z.enum(scratchMimes);

export const isScratchImage = (mime: string) =>
	(scratchImageMimes as readonly string[]).includes(mime);
export const isScratchText = (mime: string) =>
	(scratchTextMimes as readonly string[]).includes(mime);

/** How an item came in: the user's attachment, the user's long paste, or a write by an agent or a domain. */
export type ScratchOrigin = "attached" | "pasted" | "written";

export const scratchName = z
	.string()
	.trim()
	.min(1)
	.max(scratchLimits.nameChars);

export type ScratchItem = {
	id: string;
	conversationId: string;
	name: string;
	mime: ScratchMime;
	bytes: number;
	digest: string;
	origin: ScratchOrigin;
	/** Who made it, as the conversation shows it (「利用者」, a toolchain's title). */
	maker: string;
	width?: number;
	height?: number;
	/** Host-made reference data kept with an image (e.g. detected objects); never set by clients. */
	annotation?: { source: string; data: Record<string, unknown> };
	createdAt: number;
	usedAt: number;
};

export type ScratchPut = {
	conversationId: string;
	name: string;
	mime: ScratchMime;
	data: Uint8Array;
	origin: ScratchOrigin;
	maker: string;
	width?: number;
	height?: number;
	annotation?: ScratchItem["annotation"];
};

/** The item as the HTTP API returns it (no content). */
export type ScratchItemResponse = Omit<ScratchItem, "createdAt" | "usedAt"> & {
	uri: string;
	createdAt: string;
	usedAt: string;
	contentUrl: string;
};

export const errorStatus = {
	scratch_type_unsupported: 415,
	scratch_too_large: 413,
	scratch_capacity: 507,
	scratch_busy: 429,
	scratch_name_invalid: 400,
	scratch_empty: 400,
	invalid_scratch_input: 400,
	item_not_found: 404,
} as const satisfies Record<string, HttpErrorStatus>;

export const scratchId = z.uuid();
