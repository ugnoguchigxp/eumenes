import { lazy, Suspense, useMemo } from "react";
import {
	SettingsSection,
	type SettingsInputField,
} from "@eumenes/design-system";
import type { Settings } from "../../../../../api/domains/settings/contracts";
import { spatialControls } from "../../../../../api/domains/settings/contracts";
import { spatialPreferences } from "../../../components/SpatialPreferences";
import type { Change } from "../shared";

const Preview = lazy(() =>
	import("../../background").then((m) => ({ default: m.SpatialBackground })),
);
const fields = spatialControls;
const groups = [
	{ id: "particles", label: "粒子" },
	{ id: "motion", label: "動き" },
	{ id: "state", label: "状態プレビュー" },
];

export function SpatialSettingsSection({
	value,
	change,
}: {
	value: Settings;
	change: Change;
}) {
	const options = useMemo(
		() => spatialPreferences(value.general),
		[value.general],
	);
	const inputs: SettingsInputField[] = fields.map((field) => ({
		id: field.fieldId,
		label: field.label,
		control: field.control as SettingsInputField["control"],
		group: field.group,
		help: "help" in field ? field.help : undefined,
		minimum: "min" in field ? field.min : undefined,
		maximum: "max" in field ? field.max : undefined,
		step: "step" in field ? field.step : undefined,
		options: "options" in field ? [...field.options] : undefined,
		value: String(
			value.general[
				field.path.split(".").at(-1)! as keyof Settings["general"]
			] ?? field.defaultValue,
		),
	}));
	return (
		<>
			<SettingsSection
				title="Spatialの調整"
				description="12種類の展示モデル。下の見本は編集中の値で動きます。会話の背景への反映は「変更を適用」で保存します。取得経路は未接続です。"
				fields={inputs}
				groups={groups}
				dirty={false}
				hideFooter
				onReview={() => {}}
				onChange={(id, raw) => {
					const field = fields.find((item) => item.fieldId === id);
					if (!field) return;
					const next =
						field.control === "toggle"
							? raw === "true"
							: field.control === "range"
								? Number(raw)
								: raw;
					change((draft) => {
						Object.assign(draft.general, {
							[field.path.split(".").at(-1)!]: next,
						});
					});
				}}
			/>
			<Suspense fallback={<p>Spatialを準備しています…</p>}>
				<Preview active options={options} standalone />
			</Suspense>
		</>
	);
}
