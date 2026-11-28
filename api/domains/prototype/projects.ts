import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { workspaceGit as git } from "../coding";
import { collect, isInside, type Project } from "./runtime/project";

export type Registration = {
	id: string;
	name: string;
	root: string;
	common: string;
	anchor: string;
	trial?: Project;
	identity: string;
	generation: number;
};
const identity = (path: string) => {
	const value = lstatSync(path, { bigint: true });
	return value.dev.toString() + ":" + value.ino.toString();
};
const overlap = (a: string, b: string) => isInside(a, b) || isInside(b, a);
const validId = /^[a-f0-9-]{36}$/;

function canonicalGit(path: string) {
	if (!isAbsolute(path)) throw new Error("prototype_path_invalid");
	const root = realpathSync(path);
	if (root !== resolve(path) || !lstatSync(root).isDirectory())
		throw new Error("prototype_path_invalid");
	const args = (flag: string) =>
		git(root, ["rev-parse", "--path-format=absolute", flag]).trimEnd();
	if (realpathSync(args("--show-toplevel")) !== root)
		throw new Error("prototype_git_root_required");
	const common = realpathSync(args("--git-common-dir"));
	const actual = realpathSync(args("--absolute-git-dir"));
	const anchor = git(root, ["rev-list", "--max-parents=0", "HEAD"])
		.split(/\s+/)
		.filter(Boolean)
		.sort()[0];
	if (!anchor || !/^[a-f0-9]{40,64}$/.test(anchor))
		throw new Error("prototype_git_history_required");
	return {
		root,
		common,
		actual,
		anchor,
		identity: identity(root) + "/" + identity(common),
	};
}

export function template(root: string, name: string, environment: string) {
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "assets"), { recursive: true });
	writeFileSync(
		join(root, "prototype.json"),
		JSON.stringify(
			{
				schema: 1,
				name,
				entry: "src/main.tsx",
				environment,
				features: [],
				include: ["src", "assets"],
			},
			null,
			2,
		) + "\n",
		{ flag: "wx" },
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify(
			{
				name: basename(root),
				version: "0.1.0",
				private: true,
				scripts: {
					dev: "eumenes-prototype dev",
					build: "eumenes-prototype build",
					typecheck: "eumenes-prototype typecheck",
				},
			},
			null,
			2,
		) + "\n",
		{ flag: "wx" },
	);
	writeFileSync(
		join(root, "tsconfig.json"),
		'{"extends":"./.eumenes/tsconfig.generated.json","include":["src"]}\n',
		{ flag: "wx" },
	);
	writeFileSync(
		join(root, ".gitignore"),
		".eumenes/\ndist/\nnode_modules/\n.env*\n!.env.example\n",
		{ flag: "wx" },
	);
	writeFileSync(
		join(root, ".env.example"),
		"# Standalone uses bundled sample assets. Keep real credentials server-side.\n",
		{ flag: "wx" },
	);
	writeFileSync(
		join(root, "README.md"),
		"# " +
			name +
			"\n\nPrepare Eumenes Works release " +
			environment +
			" outside this repository. Export EUMENES_PROTOTYPE_HOME and add its bin directory to PATH.\n" +
			"\nRun `eumenes-prototype dev`, `eumenes-prototype typecheck` or `eumenes-prototype build`. " +
			"The same commands are exposed as package.json scripts. Do not install dependencies in this repository.\n",
		{ flag: "wx" },
	);
	writeFileSync(
		join(root, "src/main.tsx"),
		'import { mount } from "eumenes-prototype/app";\nmount(({ root }) => root.render(<h1>Works</h1>));\n',
		{ flag: "wx" },
	);
	writeFileSync(join(root, "assets/.gitkeep"), "", { flag: "wx" });
}

export function projects(options: {
	core: string;
	data: string;
	works: string;
	setup(registration: Registration): void;
}) {
	const core = canonicalGit(options.core);
	const works = realpathSync(options.works);
	const data = realpathSync(options.data);
	if (overlap(core.root, works) || overlap(data, works))
		throw new Error("prototype_works_outside_core_required");
	const filename = join(data, "registrations.json");
	let rows: Registration[] = existsSync(filename)
		? (JSON.parse(readFileSync(filename, "utf8")) as Registration[])
		: [];
	function update(next: Registration[]) {
		const temp = mkdtempSync(join(data, "registrations-"));
		try {
			const file = join(temp, "records.json");
			writeFileSync(file, JSON.stringify(next, null, 2) + "\n", {
				mode: 0o600,
			});
			renameSync(file, filename);
			rows = next;
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}
	function checked(path: string, except?: string) {
		const inspected = canonicalGit(path);
		const { root, common, actual } = inspected;
		if (
			common !== actual ||
			!isInside(root, common) ||
			[core.root, core.common, data].some(
				(candidate) => overlap(candidate, root) || overlap(candidate, common),
			)
		)
			throw new Error("prototype_git_overlap");
		if (
			rows.some(
				(row) =>
					row.id !== except &&
					(overlap(row.root, root) || overlap(row.common, common)),
			)
		)
			throw new Error("prototype_git_overlap");
		return inspected;
	}
	function get(id: string) {
		const row = validId.test(id) && rows.find((project) => project.id === id);
		if (!row) throw new Error("prototype_not_found");
		return row;
	}
	const register = (path: string, trial?: Project) => {
		const location = checked(path);
		const { project } = collect(location.root, trial);
		const row = {
			...location,
			id: crypto.randomUUID(),
			name: project.name,
			...(trial ? { trial: project } : {}),
			generation: 1,
		};
		options.setup(row);
		update([...rows, row]);
		return row;
	};
	return {
		get,
		register,
		list: () => rows,
		assertLocation(row: Registration) {
			if (
				row.identity !== identity(row.root) + "/" + identity(row.common) ||
				realpathSync(row.root) !== row.root
			)
				throw new Error("prototype_registration_changed");
		},
		assertCurrent(row: Registration) {
			if (get(row.id).generation !== row.generation)
				throw new Error("prototype_registration_changed");
			const live = checked(row.root, row.id);
			if (row.identity !== live.identity || row.common !== live.common)
				throw new Error("prototype_registration_changed");
		},
		move(id: string, path: string) {
			const old = get(id);
			const target = checked(path, id);
			if (
				git(target.root, [
					"merge-base",
					"--is-ancestor",
					old.anchor,
					"HEAD",
				]) !== ""
			)
				throw new Error("prototype_git_history_required");
			const { project } = collect(target.root, old.trial);
			const next = {
				...old,
				...target,
				anchor: old.anchor,
				name: project.name,
				generation: old.generation + 1,
			};
			options.setup(next);
			update(rows.map((row) => (row.id === id ? next : row)));
			return next;
		},
		remove(id: string) {
			get(id);
			update(rows.filter((row) => row.id !== id));
		},
		create(slug: string, environment: string) {
			if (
				!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ||
				!/^[1-9]\d*\.\d+$/.test(environment)
			)
				throw new Error("prototype_name_invalid");
			const user = {
				HOME: process.env.HOME ?? "/nonexistent",
				GIT_CONFIG_GLOBAL: join(
					process.env.HOME ?? "/nonexistent",
					".gitconfig",
				),
			};
			let name: string, email: string;
			try {
				name = git(
					works,
					["config", "--global", "--get", "user.name"],
					user,
				).trim();
				email = git(
					works,
					["config", "--global", "--get", "user.email"],
					user,
				).trim();
			} catch {
				throw new Error("prototype_git_identity_required");
			}
			if (!name || !email) throw new Error("prototype_git_identity_required");
			const target = join(works, slug);
			const stage = mkdtempSync(join(works, ".works-new-"));
			try {
				const repo = join(stage, slug);
				template(repo, slug, environment);
				git(repo, ["init", "--initial-branch=main", "--template="]);
				git(repo, [
					"add",
					"--",
					"prototype.json",
					"src",
					"assets",
					"package.json",
					"tsconfig.json",
					"README.md",
					".env.example",
					".gitignore",
				]);
				git(repo, [
					"-c",
					"user.name=" + name,
					"-c",
					"user.email=" + email,
					"commit",
					"-m",
					"Initialize Works project",
				]);
				if (existsSync(target)) throw new Error("prototype_path_exists");
				renameSync(repo, target);
				return register(target);
			} finally {
				rmSync(stage, { recursive: true, force: true });
			}
		},
	};
}
