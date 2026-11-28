import { basename, join } from "node:path";
import {
	WorksSelectionRequired,
	type Host,
	type WorksTarget,
} from "../../domains/claude-code";
import { claudeDaemonClient } from "../../domains/coding";
import {
	worksDependencyPublisher,
	type PrototypeService,
} from "../../domains/prototype";
import { claudeWorkspace } from "../work/claude-code-task-adapter";

export function prototypeExecution(
	work: PrototypeService,
	directory: string,
	protectedPaths: readonly string[],
	shared?: { source: string; home: string; works: string },
): NonNullable<Host["works"]> {
	const runners = new Map<string, ReturnType<typeof claudeDaemonClient>>();
	const publish =
		shared &&
		worksDependencyPublisher(shared.source, shared.home, [
			...protectedPaths,
			shared.works,
		]);
	return {
		select({ name, references }) {
			const selected = [
				...new Set(
					references.flatMap((item) => {
						const uri =
							/^eumenes:\/\/prototype\/([a-f0-9-]{36})(?:\?.*)?$/.exec(
								item.ref,
							);
						return uri
							? [uri[1]!]
							: item.kind === "resource" && item.owner === "prototype"
								? [item.id]
								: [];
					}),
				),
			];
			const found = work
				.list()
				.projects.filter((row) =>
					selected.length
						? selected.includes(row.id)
						: name &&
							row.name.normalize("NFC") === name.trim().normalize("NFC"),
				);
			if (selected.length > 1 || found.length > 1)
				throw new WorksSelectionRequired(
					found.slice(0, 8).map((row) => ({
						id: row.id,
						generation: row.generation,
						label: (row.name + "（" + basename(row.root) + "）").replace(
							/[\r\n\t]/g,
							" ",
						),
					})),
				);
			if (!found[0]) throw new Error("prototype_target_required");
			const revision = references.find(
				({ ref, id }) =>
					selected.length &&
					(id === found[0]!.id || ref.includes("/" + found[0]!.id)),
			)?.revision;
			if (revision && Date.parse(revision) !== found[0].generation)
				throw new Error("prototype_registration_changed");
			return work.editTarget(found[0].id);
		},
		pick(choice) {
			const target = work.editTarget(choice.id);
			if (target.generation !== choice.generation)
				throw new Error("prototype_registration_changed");
			return target;
		},
		current: (target) => work.editTargetCurrent(target),
		workspace: (target) => claudeWorkspace("prototype:" + target.id),
		...(publish
			? {
					dependencies: {
						publish: ({ target, approval, signal, assertCurrent }) =>
							publish({
								id: approval.id,
								environment: target.environment,
								request: approval.request,
								signal,
								assertCurrent,
							}),
						advance: work.advanceEnvironment,
						advanced: work.environmentAdvanced,
					},
				}
			: {}),
		runner(target: WorksTarget) {
			const key = target.id + "-" + target.generation;
			let runner = runners.get(key);
			if (!runner) {
				runner = claudeDaemonClient(
					{
						root: join(
							directory,
							"runner-" + target.id.slice(0, 12) + "-" + target.generation,
						),
						workspace: target.root,
						protectedPaths: [...protectedPaths],
					},
					{ idleMs: 60_000 },
				);
				runners.set(key, runner);
			}
			return runner;
		},
	};
}
