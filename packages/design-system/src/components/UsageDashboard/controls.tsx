import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../Select";
export function UsageSelect({
	label,
	value,
	options,
	onChange,
	disabled = false,
}: {
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange(value: string): void;
	disabled?: boolean;
}) {
	return (
		<label className="ds-usage-select">
			<span>{label}</span>
			<Select
				value={value || "__all"}
				onValueChange={(v) => onChange(v === "__all" ? "" : v)}
				disabled={disabled}
			>
				<SelectTrigger aria-label={label}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((o) => (
						<SelectItem key={o.value || "__all"} value={o.value || "__all"}>
							{o.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</label>
	);
}
export const token = (n: number | null) =>
	n === null ? "未取得" : n.toLocaleString("ja-JP");
export const duration = (n: number | null) =>
	n === null
		? "未取得"
		: n < 60
			? n.toLocaleString("ja-JP", { maximumFractionDigits: 2 }) + "秒"
			: Math.floor(n / 60).toLocaleString("ja-JP") +
				"分" +
				Math.floor(n % 60) +
				"秒";
export const money = (n: string | number | null) =>
	n === null
		? "未算定"
		: "$" +
			Number(n).toLocaleString("en-US", {
				minimumFractionDigits: 2,
				maximumFractionDigits: 6,
			});
export const stamp = (s: string) =>
	new Date(s).toLocaleString("ja-JP", {
		timeZone: "Asia/Tokyo",
		hour12: false,
	});
