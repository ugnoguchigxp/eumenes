import { AlertCircle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/Button";
import { cn } from "@/utils/cn";

type ErrorStateProps = {
	error?: unknown;
	onRetry?: () => void;
	className?: string;
	/** エラータイトルの上書き */
	title?: string;
	/** エラーメッセージの上書き。未指定時は error オブジェクトから抽出を試みます。 */
	message?: string;
	/** 再試行ボタンのテキスト (デフォルト: '再読み込み') */
	retryText?: string;
};

export const ErrorState = ({
	error,
	onRetry,
	className = "",
	title: propsTitle,
	message: propsMessage,
	retryText = "再読み込み",
}: ErrorStateProps) => {
	const getErrorMessage = (err: unknown) => ({
		title: "Error",
		message: (err as Error | undefined)?.message ?? "Something went wrong.",
	});

	const { title: defaultTitle, message: defaultMessage } =
		getErrorMessage(error);
	const title = propsTitle || defaultTitle;
	const message = propsMessage || defaultMessage;

	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center p-8 text-center bg-card rounded-lg border border-border/50",
				className,
			)}
		>
			<div className="bg-destructive/10 p-4 rounded-full mb-4">
				<AlertCircle className="h-8 w-8 text-destructive" />
			</div>
			<h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
			<p className="text-sm text-muted-foreground mb-6 max-w-sm">{message}</p>
			{onRetry && (
				<Button onClick={onRetry} variant="outline" className="gap-2">
					<RefreshCcw className="h-4 w-4" />
					{retryText}
				</Button>
			)}
		</div>
	);
};
