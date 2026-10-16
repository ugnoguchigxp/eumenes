import { useEffect, useRef, useState } from "react";
import type { Receipt } from "./contracts";
import type { SettingsSectionResource } from "./settings-contracts";
import { useArtifactRuntime } from "./runtime";
import { useInputStatus } from "./input-status";

/** Keep unparsed numeric text in the editor, while the document retains validated values. */
export function useSettingsInputs(
	source: string,
	resource: SettingsSectionResource,
	send: (id: string, value: string) => Promise<Receipt>,
) {
	const { readSecret } = useArtifactRuntime();
	const currentEdits = useRef(
		new Map<string, { wire: string; error?: string; accepted: boolean }>(),
	);
	const [edits, setEdits] = useState(
		new Map<string, { wire: string; error?: string; accepted: boolean }>(),
	);
	const report = useInputStatus(source, "numeric-inputs");
	useEffect(() => {
		if (!resource.dirty && !resource.busy && currentEdits.current.size) {
			currentEdits.current = new Map();
			setEdits(new Map());
			report(null);
		}
	}, [resource.dirty, resource.busy, report]);
	const fields = resource.fields.map((field) => {
		const secret = readSecret?.(source, field.id);
		if (secret !== undefined)
			return { ...field, confidential: true, value: secret };
		const edit = edits.get(field.id);
		return edit ? { ...field, value: edit.wire, error: edit.error } : field;
	});
	return {
		fields,
		change(id: string, wire: string) {
			const field = resource.fields.find((f) => f.id === id);
			if (field?.control !== "number") {
				void send(id, wire);
				return;
			}
			const edit = {
				wire,
				accepted: false,
				error: undefined as string | undefined,
			};
			currentEdits.current = new Map(currentEdits.current).set(id, edit);
			setEdits(currentEdits.current);
			report("数値の入力を確認してください。");
			void send(id, wire).then((receipt) => {
				if (currentEdits.current.get(id) !== edit) return;
				const accepted = receipt.status === "accepted";
				currentEdits.current = new Map(currentEdits.current).set(id, {
					...edit,
					accepted,
					error: accepted ? undefined : receipt.message,
				});
				setEdits(currentEdits.current);
				const pending = [...currentEdits.current].filter(
					([, e]) => !e.accepted,
				);
				report(
					pending.length
						? pending
								.map(
									([key, e]) =>
										`${resource.fields.find((f) => f.id === key)?.label ?? "数値"}: ${e.error || "入力を確認してください。"}`,
								)
								.join("\n")
						: null,
				);
			});
		},
	};
}
