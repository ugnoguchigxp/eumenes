import { Copy } from "lucide-react";
import type React from "react";
import { Button } from "@/components/Button";

interface CopyClipButtonProps {
	text: string;
	copyValue?: string;
	className?: string;
	onCopied?: (copiedValue: string) => void;
	onCopyError?: (error: unknown) => void;
}

export const CopyClipButton = ({
	text,
	copyValue,
	className,
	onCopied,
	onCopyError,
}: CopyClipButtonProps) => {
	const t = (key: string) => key;

	const handleCopy = async (e: React.MouseEvent) => {
		e.stopPropagation();
		const valueToCopy = copyValue || text;
		try {
			await navigator.clipboard.writeText(valueToCopy);
			onCopied?.(valueToCopy);
		} catch (err) {
			onCopyError?.(err);
		}
	};

	return (
		<Button
			variant="link"
			className={`p-0 h-auto font-normal hover:no-underline hover:text-primary items-center gap-1 ${className || ""}`}
			onClick={handleCopy}
			title={t("click_to_copy")}
		>
			{text}
			<Copy className="h-3 w-3 opacity-50" />
		</Button>
	);
};
