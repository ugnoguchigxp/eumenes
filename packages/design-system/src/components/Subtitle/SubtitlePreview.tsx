import { Card, CardContent, CardHeader, CardTitle } from "../Card";
import { Subtitle, type SubtitleProps } from "./Subtitle";

export type SubtitlePreviewProps = Pick<
	SubtitleProps,
	"text" | "style" | "size"
> & {
	title?: string;
	enabled: boolean;
};
export function SubtitlePreview({
	title = "字幕のプレビュー",
	enabled,
	...subtitle
}: SubtitlePreviewProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				<p className="ds-subtitle-preview-hint">
					{enabled
						? "保存後、読み上げ中に字幕を表示します。"
						: "字幕は非表示の設定です。見本は確認できます。"}
				</p>
				<div className="subtitle-preview-stage">
					<Subtitle {...subtitle} inline />
				</div>
			</CardContent>
		</Card>
	);
}
