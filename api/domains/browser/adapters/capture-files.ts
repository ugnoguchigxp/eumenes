import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { CaptureFiles } from "../contracts/ports";

/**
 * Capture files in one managed directory. A ref is `<captureId>.tmp` or `<captureId>.webp`;
 * the capture id is validated to a plain token, so no ref can carry a path separator or
 * traversal. Final names come from the capture id only (never page title or URL).
 */
const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REF = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.(tmp|webp)$/;

function captureId(value: string) {
	if (!CAPTURE_ID.test(value)) throw new Error("capture_ref_invalid");
	return value;
}

function parseRef(ref: string) {
	const match = REF.exec(ref);
	if (!match) throw new Error("capture_ref_invalid");
	return { id: match[1] as string, kind: match[2] as "tmp" | "webp" };
}

export function createCaptureFiles(options: {
	directory: string;
}): CaptureFiles {
	const path = (ref: string) => join(options.directory, ref);
	const list = async (kind: "tmp" | "webp") => {
		try {
			return (await readdir(options.directory)).filter(
				(name) => REF.exec(name)?.[2] === kind,
			);
		} catch {
			return [];
		}
	};
	const ensure = () =>
		mkdir(options.directory, { recursive: true, mode: 0o700 });
	return {
		async writeTemp(id, bytes) {
			const ref = `${captureId(id)}.tmp`;
			await ensure();
			await writeFile(path(ref), bytes, { mode: 0o600 });
			return ref;
		},
		async adopt(tempRef, id) {
			const temp = parseRef(tempRef);
			if (temp.kind !== "tmp" || temp.id !== captureId(id))
				throw new Error("capture_ref_invalid");
			const ref = `${temp.id}.webp`;
			await rename(path(tempRef), path(ref));
			return ref;
		},
		async read(ref) {
			parseRef(ref);
			return new Uint8Array(await readFile(path(ref)));
		},
		async remove(ref) {
			parseRef(ref);
			await rm(path(ref), { force: true });
		},
		listTemp: () => list("tmp"),
		listAdopted: () => list("webp"),
	};
}
