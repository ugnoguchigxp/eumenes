import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, sep } from "node:path";

export type Mode = "host" | "standalone";
export type Project = {
	schema: 1;
	name: string;
	entry: string;
	environment: string;
	features: string[];
	include: string[];
	mountId?: string;
};
export const versionPattern = /^[1-9]\d*\.\d+$/;
const ignored = (name: string) =>
	name.startsWith(".") || ["dist", "node_modules"].includes(name);
export const relativePath = (name: string) =>
	!isAbsolute(name) &&
	name
		.split("/")
		.every(
			(segment) =>
				/^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(segment) && !ignored(segment),
		);
const rootFolders = new Set(["src", "assets", "samples"]);
const assets = new Set([
	".png",
	".webp",
	".jpg",
	".jpeg",
	".svg",
	".gltf",
	".glb",
	".bin",
	".json",
	".txt",
	".woff2",
]);
const source = new Set([".ts", ".tsx", ".css"]);
const features = new Set(["library.image.read", "media.image.generate"]);
const MiB = 1024 * 1024;
type Identity = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
};
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const stable = (a: Identity, b: Identity) =>
	same(a, b) &&
	a.size === b.size &&
	a.mtimeMs === b.mtimeMs &&
	a.ctimeMs === b.ctimeMs;

export function readStable(path: string, expected: Identity, limit: number) {
	if (expected.size > limit) throw new Error("prototype_snapshot_limit");
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || !stable(before, expected))
			throw new Error("prototype_input_changed");
		const data = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < data.length) {
			const n = readSync(fd, data, offset, data.length - offset, null);
			if (!n) throw new Error("prototype_input_changed");
			offset += n;
		}
		if (!stable(before, fstatSync(fd)) || !stable(before, lstatSync(path)))
			throw new Error("prototype_input_changed");
		return data;
	} finally {
		closeSync(fd);
	}
}

function parseProject(raw: Buffer, trial = false): Project {
	const p: Project = JSON.parse(raw.toString());
	if (
		p?.schema !== 1 ||
		typeof p.name !== "string" ||
		!p.name.trim() ||
		p.name.length > 100 ||
		typeof p.environment !== "string" ||
		!versionPattern.test(p.environment) ||
		!Array.isArray(p.include) ||
		!p.include.length ||
		p.include.length > 16 ||
		p.include.some(
			(name) =>
				typeof name !== "string" ||
				!relativePath(name) ||
				(!trial && !rootFolders.has(name.split("/")[0]!)),
		) ||
		typeof p.entry !== "string" ||
		!relativePath(p.entry) ||
		!/\.tsx?$/.test(p.entry) ||
		!p.include.some(
			(part) => p.entry.startsWith(part + "/") || (trial && p.entry === part),
		) ||
		(p.mountId !== undefined &&
			(!trial || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p.mountId))) ||
		!Array.isArray(p.features) ||
		p.features.length > features.size ||
		p.features.some((feature) => !features.has(feature))
	)
		throw new Error("prototype_definition_invalid");
	return p;
}

export function projectDefinition(root: string) {
	const path = join(root, "prototype.json");
	return parseProject(readStable(path, lstatSync(path), 32 * 1024));
}

export function collect(root: string, trial?: Project) {
	const resolved = realpathSync(root);
	const files = new Map<string, Buffer>();
	let bytes = 0;
	let entries = 0;
	const ancestors = new Map<string, Identity>();
	const rootInfo = lstatSync(resolved);
	const verifyAncestors = () => {
		if (
			!same(rootInfo, lstatSync(resolved)) ||
			realpathSync(resolved) !== resolved
		)
			throw new Error("prototype_input_changed");
		for (const [path, identity] of ancestors) {
			const current = lstatSync(path);
			if (!current.isDirectory() || !stable(identity, current))
				throw new Error("prototype_input_changed");
		}
	};
	const metadata = join(resolved, "prototype.json");
	const data = trial
		? Buffer.from(JSON.stringify(trial))
		: readStable(metadata, lstatSync(metadata), 32 * 1024);
	files.set("prototype.json", data);
	bytes += data.length;
	const project = parseProject(data, trial !== undefined);
	function visit(name: string, depth: number) {
		if (++entries > 4096 || depth > 24)
			throw new Error("prototype_snapshot_limit");
		if (files.has(name) || name.split("/").some(ignored)) return;
		if (!relativePath(name)) throw new Error("prototype_path_invalid");
		verifyAncestors();
		const path = join(resolved, name);
		const item = lstatSync(path);
		if (item.isSymbolicLink() || realpathSync(path) !== path)
			throw new Error("prototype_link_forbidden");
		if (item.isDirectory()) {
			ancestors.set(path, item);
			for (const child of readdirSync(path).sort())
				visit(name + "/" + child, depth + 1);
			verifyAncestors();
			ancestors.delete(path);
			return;
		}
		if (!item.isFile()) throw new Error("prototype_path_invalid");
		const extension = extname(name).toLowerCase();
		if (!source.has(extension) && !assets.has(extension)) return;
		if (files.size >= 1024) throw new Error("prototype_snapshot_limit");
		const body = readStable(path, item, Math.min(16 * MiB, 64 * MiB - bytes));
		verifyAncestors();
		files.set(name, body);
		bytes += body.length;
	}
	for (const folder of [...new Set(project.include)].sort()) visit(folder, 0);
	if (!files.has(project.entry)) throw new Error("prototype_entry_missing");
	if (
		!trial &&
		!readStable(metadata, lstatSync(metadata), 32 * 1024).equals(data)
	)
		throw new Error("prototype_input_changed");
	verifyAncestors();
	const hash = createHash("sha256");
	for (const [name, contents] of [...files].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		hash.update(String(Buffer.byteLength(name)) + ":").update(name);
		hash.update(String(contents.length) + ":").update(contents);
	}
	return { project, files, digest: hash.digest("hex") };
}
export type Snapshot = ReturnType<typeof collect>;

export function writeSnapshot(snapshot: Snapshot, stage: string) {
	for (const [name, body] of snapshot.files) {
		const file = join(stage, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
	}
}
export function copyPublicAssets(snapshot: Snapshot, output: string) {
	for (const [name, body] of snapshot.files) {
		if (
			!/^(assets|samples)\//.test(name) ||
			!assets.has(extname(name).toLowerCase())
		)
			continue;
		const file = join(output, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
	}
}
export const isInside = (parent: string, candidate: string) =>
	candidate === parent || candidate.startsWith(parent + sep);
