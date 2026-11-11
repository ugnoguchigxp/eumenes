import type { UiStudioResource } from "./ui-studio-contracts";
import { iconTableCell, listRefreshSource } from "./composition-contracts";

type RecordValue = Record<string, unknown>;

function cell(value: unknown) {
	if (value == null) return "";
	if (["string", "number", "boolean"].includes(typeof value)) return value;
	return JSON.stringify(value);
}

export function displayWorkflowOutput(
	viewing: NonNullable<UiStudioResource["viewing"]>,
	withRefresh = false,
) {
	const { table, sections } = viewing.bindings ?? {};
	const output = table ?? sections;
	if (!output || !viewing.definition || typeof viewing.definition !== "object")
		return viewing.definition;
	const root = structuredClone(viewing.definition) as RecordValue;
	let part = root;
	for (const index of output.path) {
		const child = Array.isArray(part.children) ? part.children[index] : null;
		if (!child || typeof child !== "object") return viewing.definition;
		part = child;
	}
	const data = viewing.data as RecordValue | null | undefined;
	const rows = data?.[output.rowsKey];
	if (!Array.isArray(rows) || !rows.length) {
		for (const key of Object.keys(part)) delete part[key];
		Object.assign(part, {
			view: "info-card",
			title:
				data?.coverage === "empty"
					? "掲載なし"
					: withRefresh
						? "未取得"
						: "結果",
			body:
				data?.coverage === "empty"
					? "指定の条件に該当する掲載はありません。"
					: withRefresh
						? "「作品リストを更新」を押すと、選んだ日の上映作品を表示します。"
						: "入力を送信すると、確認できた結果をここに表示します。",
		});
	} else if (table) {
		delete part.series;
		part.rows = rows.map((row: RecordValue) =>
			table.columns.map((key) => {
				const value = row?.[key];
				if (value && typeof value === "object" && "icon" in value) {
					const icon = iconTableCell.safeParse(value);
					if (icon.success) return icon.data;
				}
				return cell(value);
			}),
		);
	} else if (sections) {
		const groups = new Map<string, string[][]>();
		for (const row of rows as RecordValue[]) {
			const title = String(cell(row?.[sections.groupBy]));
			const items = groups.get(title) ?? [];
			items.push(
				sections.itemKeys.map((key) => {
					const value = String(cell(row?.[key]));
					const labels = sections.labels?.[key];
					return labels && Object.hasOwn(labels, value)
						? labels[value]!
						: value;
				}),
			);
			groups.set(title, items);
		}
		part.groups = Array.from(groups, ([title, items]) => ({ title, items }));
		if (
			viewing.workflow?.publish?.schemaRef === "schema:showtimes.rows@1" &&
			sections.itemKeys[0] === "startTime" &&
			typeof data?.date === "string"
		)
			part.scheduleDate = data.date;
	}
	if (withRefresh) part.source = listRefreshSource;
	return root;
}
