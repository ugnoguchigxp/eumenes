import { Fragment } from "react";

export function Result({
	title,
	entries,
}: {
	title: string;
	entries: [string, string][];
}) {
	return (
		<section className="aui-result" aria-label={title}>
			<strong>{title}</strong>
			<dl>
				{entries.map(([label, value]) => (
					<Fragment key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</Fragment>
				))}
			</dl>
		</section>
	);
}
