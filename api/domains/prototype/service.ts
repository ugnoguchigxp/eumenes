import {
	mkdirSync,
	mkdtempSync,
	lstatSync,
	readFileSync,
	writeFileSync,
	renameSync,
	realpathSync,
	rmSync,
	watch,
	type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import { projects, type Registration } from "./projects";
import type { PrototypePreview, TrialRequest } from "./contracts";
import { configureEditor, runBuild } from "./runtime/build";
import {
	collect,
	isInside,
	projectDefinition,
	versionPattern,
	type Snapshot,
} from "./runtime/project";
import { loopbackOrigin, previewListener } from "./runtime/preview";
import { trialInventory } from "./trial";
import { openRelease, releaseSupportsChecks } from "./runtime/release";

export type PrototypeOptions = {
	core: string;
	data: string;
	works: string;
	runtime: string;
	parentOrigin: string;
	previewPort: number;
	defaultVersion: string;
	inUse?(id: string): boolean;
};
type Output = { url: string; version: string; clear(): void };
type View = {
	row: Registration;
	snapshot?: Snapshot;
	editorVersion?: string;
	state: PrototypePreview["state"];
	output?: Output;
	diagnostics: string[];
	latest?: string;
	timer?: ReturnType<typeof setTimeout>;
	watcher?: FSWatcher;
	revision: number;
	lastSeen: number;
};

const show = (view?: View): PrototypePreview => ({
	state: view?.state ?? "hidden",
	url: view?.output?.url ?? null,
	version: view?.output?.version ?? null,
	diagnostics: view?.diagnostics ?? [],
});
const releaseOutput = (view: View) => {
	view.output?.clear();
	delete view.output;
};

function problem(view: View, error: unknown) {
	const reason = error instanceof Error ? error.message : "prototype_failed";
	if (
		reason.startsWith("prototype_environment") ||
		reason === "prototype_release_busy"
	)
		view.state = "environment";
	else if (
		reason === "prototype_platform_unsupported" ||
		reason === "prototype_origin_unsupported"
	)
		view.state = "unsupported";
	else if (
		reason === "prototype_registration_changed" ||
		reason === "runner_git_failed" ||
		reason === "prototype_git_overlap"
	) {
		view.state = "registration";
		releaseOutput(view);
		view.watcher?.close();
		delete view.watcher;
	} else view.state = "failed";
	view.diagnostics = [
		reason.startsWith("prototype_") || reason === "runner_git_failed"
			? reason
			: "prototype_input_unavailable",
	];
}

export function createPrototypeService(options: PrototypeOptions) {
	if (!versionPattern.test(options.defaultVersion))
		throw new Error("prototype_environment_invalid");
	const parent = loopbackOrigin(options.parentOrigin);
	const root = realpathSync(options.data);
	const core = realpathSync(options.core);
	const works = realpathSync(options.works);
	const runtime = realpathSync(options.runtime);
	if (
		[root, core, works].some(
			(dir) => isInside(dir, runtime) || isInside(runtime, dir),
		)
	)
		throw new Error("prototype_runtime_outside_core_required");
	const cache = realpathSync(mkdirAndReturn(join(root, "outputs")));
	const disposable = mkdtempSync(join(cache, "session-"));
	const opened = new Map<string, View>();
	const pending = new Map<string, View>();
	let running: Promise<void> | undefined;
	let liveness: ReturnType<typeof setInterval> | undefined;
	let listener: ReturnType<typeof previewListener> | undefined;
	let closing = false;
	const shutdown = new AbortController();
	const registry = projects({
		core,
		data: root,
		works,
		setup(row) {
			const snapshot = collect(row.root, row.trial);
			const release = openRelease(runtime, snapshot.project.environment);
			try {
				if (!row.trial) configureEditor(row.root, release.path, "host");
			} finally {
				release.close();
			}
		},
	});
	function current(view: View) {
		try {
			registry.assertCurrent(view.row);
		} catch {
			throw new Error("prototype_registration_changed");
		}
	}
	function enqueue(view: View, force = false) {
		if (closing || opened.get(view.row.id) !== view) return;
		try {
			current(view);
			const next = collect(view.row.root, view.row.trial);
			if (!force && next.digest === view.latest) return;
			view.latest = next.digest;
			view.snapshot = next;
			view.revision++;
			view.state = "waiting";
			view.diagnostics = [];
			pending.set(view.row.id, view);
			pump();
		} catch (error) {
			view.revision++;
			delete view.latest;
			pending.delete(view.row.id);
			problem(view, error);
		}
	}
	async function build(view: View, snapshot: Snapshot, revision: number) {
		const target = join(disposable, crypto.randomUUID());
		let keep = false;
		let release: ReturnType<typeof openRelease> | undefined;
		try {
			release = openRelease(runtime, snapshot.project.environment);
			if (
				!view.row.trial &&
				view.editorVersion !== snapshot.project.environment
			) {
				configureEditor(view.row.root, release.path, "host");
				view.editorVersion = snapshot.project.environment;
			}
			view.state = "building";
			const result = await runBuild({
				runtime: release.path,
				snapshot,
				mode: "host",
				work: disposable,
				target,
				build: true,
				typecheck: true,
				strict: false,
				signal: shutdown.signal,
			});
			if (
				closing ||
				opened.get(view.row.id) !== view ||
				view.revision !== revision
			)
				return;
			current(view);
			if (collect(view.row.root, view.row.trial).digest !== snapshot.digest) {
				enqueue(view);
				return;
			}
			view.diagnostics = result.diagnostics;
			if (!result.built) {
				view.state = "failed";
				return;
			}
			listener ??= previewListener(options.previewPort, parent);
			const files = listener.add(view.row.id, target);
			releaseOutput(view);
			const unlock = release.close;
			view.output = {
				url: files.url,
				version: snapshot.digest,
				clear() {
					files.release();
					unlock();
					rmSync(target, { force: true, recursive: true });
				},
			};
			release = undefined;
			keep = true;
			view.state = "ready";
		} catch (error) {
			if (
				!closing &&
				opened.get(view.row.id) === view &&
				view.revision === revision
			)
				problem(view, error);
		} finally {
			release?.close();
			if (!keep) rmSync(target, { recursive: true, force: true });
		}
	}
	function pump() {
		if (running || closing) return;
		const view = pending.values().next().value;
		if (!view) return;
		pending.delete(view.row.id);
		const snapshot = view.snapshot!;
		delete view.snapshot;
		running = build(view, snapshot, view.revision).finally(() => {
			running = undefined;
			pump();
		});
	}
	function stop(id: string) {
		const view = opened.get(id);
		if (!view) return;
		opened.delete(id);
		pending.delete(id);
		view.revision++;
		clearTimeout(view.timer);
		view.watcher?.close();
		releaseOutput(view);
		if (!opened.size && liveness) {
			clearInterval(liveness);
			liveness = undefined;
		}
	}
	function open(id: string) {
		if (closing) throw new Error("prototype_closing");
		const old = opened.get(id);
		if (old) {
			old.lastSeen = Date.now();
			return show(old);
		}
		const row = registry.get(id);
		const view: View = {
			row,
			state: "waiting",
			diagnostics: [],
			revision: 0,
			lastSeen: Date.now(),
		};
		opened.set(id, view);
		liveness ??= setInterval(() => {
			for (const [key, item] of opened)
				if (Date.now() - item.lastSeen > 30_000) stop(key);
		}, 5_000);
		try {
			current(view);
			view.watcher = watch(row.root, { recursive: true }, (_, name) => {
				if (!isPreviewInput(view, name)) return;
				clearTimeout(view.timer);
				view.timer = setTimeout(() => {
					delete view.timer;
					enqueue(view);
				}, 100);
			});
			view.watcher.on("error", () =>
				problem(view, new Error("prototype_registration_changed")),
			);
			enqueue(view);
		} catch (error) {
			problem(view, error);
		}
		return show(view);
	}

	return {
		features(id: string) {
			const row = registry.get(id);
			registry.assertLocation(row);
			return row.trial?.features ?? projectDefinition(row.root).features;
		},
		inputVersion(id: string) {
			const row = registry.get(id);
			registry.assertLocation(row);
			return (
				opened.get(id)?.output?.version ?? collect(row.root, row.trial).digest
			);
		},
		list: () => ({
			projects: registry.list(),
			defaultVersion: options.defaultVersion,
		}),
		...editTargets(registry, runtime),
		register: (path: string) => registry.register(path),
		...trialRegistration(registry, runtime),
		create: (name: string) => registry.create(name, options.defaultVersion),
		move(id: string, path: string) {
			if (options.inUse?.(id)) throw new Error("prototype_workspace_busy");
			const row = registry.move(id, path);
			stop(id);
			return row;
		},
		remove(id: string) {
			if (options.inUse?.(id)) throw new Error("prototype_workspace_busy");
			registry.remove(id);
			stop(id);
		},
		open,
		preview(id: string) {
			registry.get(id);
			const view = opened.get(id);
			if (view) {
				view.lastSeen = Date.now();
				try {
					registry.assertLocation(view.row);
				} catch {
					problem(view, new Error("prototype_registration_changed"));
				}
			}
			return show(view);
		},
		hide(id: string) {
			stop(id);
		},
		stalled(id: string, version: string) {
			const view = opened.get(id);
			if (view && version === view.output?.version) {
				view.revision++;
				pending.delete(id);
				view.state = "unresponsive";
				view.diagnostics = ["prototype_preview_unresponsive"];
				releaseOutput(view);
			}
			return show(view);
		},
		retry(id: string) {
			const view = opened.get(id);
			if (view) enqueue(view, true);
			return show(view);
		},
		metrics: () => ({
			watchers: [...opened.values()].filter((view) => view.watcher).length,
			waiting: pending.size,
			active: Number(Boolean(running)),
		}),
		async close() {
			closing = true;
			shutdown.abort();
			for (const key of opened.keys()) stop(key);
			await running;
			await listener?.close();
			rmSync(disposable, { recursive: true, force: true });
		},
	};
}

function isPreviewInput(view: View, path: string | null) {
	if (!path) return true;
	if (
		path
			.split("/")
			.some(
				(part) =>
					part.startsWith(".") || part === "node_modules" || part === "dist",
			)
	)
		return false;
	if (path === "prototype.json" && !view.row.trial) return true;
	const scope = view.row.trial?.include ?? view.snapshot?.project.include;
	return (
		!scope ||
		scope.some(
			(input) =>
				input === path ||
				input.startsWith(path + "/") ||
				path.startsWith(input + "/"),
		)
	);
}

function editTargets(registry: ReturnType<typeof projects>, runtime: string) {
	function editTarget(id: string) {
		const row = registry.get(id);
		registry.assertCurrent(row);
		if (row.trial) throw new Error("prototype_trial_read_only");
		const { project } = collect(row.root);
		if (!releaseSupportsChecks(project.environment))
			throw new Error("prototype_environment_edit_unavailable");
		const release = openRelease(runtime, project.environment);
		try {
			return {
				id: row.id,
				generation: row.generation,
				root: row.root,
				name: row.name,
				environment: project.environment,
				runtime: release.path,
				include: project.include,
			};
		} finally {
			release.close();
		}
	}
	return {
		editTarget,
		environmentAdvanced(
			target: ReturnType<typeof editTarget>,
			original: string,
			version: string,
		) {
			try {
				const row = registry.get(target.id);
				if (row.generation !== target.generation || row.root !== target.root)
					return false;
				registry.assertLocation(row);
				const file = join(row.root, "prototype.json");
				const info = lstatSync(file);
				return (
					info.isFile() &&
					info.size <= 32 * 1024 &&
					readFileSync(file, "utf8") ===
						nextManifest(original, target.environment, version)
				);
			} catch {
				return false;
			}
		},
		advanceEnvironment(
			target: ReturnType<typeof editTarget>,
			original: string,
			version: string,
		) {
			const row = registry.get(target.id);
			if (row.generation !== target.generation || row.root !== target.root)
				throw new Error("prototype_registration_changed");
			registry.assertCurrent(row);
			const file = join(row.root, "prototype.json");
			const info = lstatSync(file);
			if (!info.isFile() || info.size > 32 * 1024)
				throw new Error("prototype_dependency_inputs_changed");
			const next = nextManifest(original, target.environment, version);
			const release = openRelease(runtime, version);
			try {
				const before = readFileSync(file, "utf8");
				if (before !== original && before !== next)
					throw new Error("prototype_dependency_inputs_changed");
				if (before !== next) {
					const stage = mkdtempSync(join(row.root, ".works-approval-"));
					try {
						const candidate = join(stage, "prototype.json");
						writeFileSync(candidate, next, { mode: info.mode & 0o777 });
						registry.assertLocation(row);
						if (
							!lstatSync(file).isFile() ||
							readFileSync(file, "utf8") !== original
						)
							throw new Error("prototype_dependency_inputs_changed");
						renameSync(candidate, file);
					} finally {
						rmSync(stage, { recursive: true, force: true });
					}
				}
				return { ...target, environment: version, runtime: release.path };
			} finally {
				release.close();
			}
		},
		editTargetCurrent(target: ReturnType<typeof editTarget>) {
			try {
				const row = registry.get(target.id);
				if (row.generation !== target.generation || row.root !== target.root)
					return false;
				registry.assertLocation(row);
				const project = projectDefinition(row.root);
				return (
					project.environment === target.environment &&
					JSON.stringify(project.include) === JSON.stringify(target.include)
				);
			} catch {
				return false;
			}
		},
	};
}

function nextManifest(original: string, previous: string, version: string) {
	const metadata = JSON.parse(original);
	if (metadata.environment !== previous)
		throw new Error("prototype_dependency_inputs_changed");
	const indent = /^\{\r?\n([ \t]+)"/.exec(original)?.[1];
	const eol = original.includes("\r\n") ? "\r\n" : "\n";
	const changed = JSON.stringify(
		{ ...metadata, environment: version },
		null,
		indent,
	);
	return (
		(eol === "\r\n" ? changed.replaceAll("\n", eol) : changed) +
		(original.endsWith("\n") ? eol : "")
	);
}
const mkdirAndReturn = (path: string) => {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
};
export type PrototypeService = ReturnType<typeof createPrototypeService>;

function trialRegistration(
	registry: ReturnType<typeof projects>,
	runtime: string,
) {
	return {
		registerTrial(input: TrialRequest) {
			const { path, ...definition } = input;
			return registry.register(path, {
				...definition,
				mountId: definition.mountId ?? "app",
				schema: 1,
				features: [],
			});
		},
		trialInventory(id: string) {
			const row = registry.get(id);
			if (!row.trial) throw new Error("prototype_trial_not_found");
			registry.assertCurrent(row);
			const release = openRelease(runtime, row.trial.environment);
			try {
				return trialInventory(row.root, release.path, row.trial.entry);
			} finally {
				release.close();
			}
		},
	};
}
