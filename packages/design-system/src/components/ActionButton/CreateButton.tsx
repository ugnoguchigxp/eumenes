import { Plus } from "lucide-react";
import type React from "react";
import { ActionButton, type ActionButtonProps } from "./ActionButton";

export interface CreateButtonProps extends ActionButtonProps {
	/** FABとして配置するかどうか (デフォルト: 'inline') */
	position?: "inline" | "fab";
}

/**
 * 新規作成 / 追加ボタン
 */
export const CreateButton: React.FC<CreateButtonProps> = ({
	label = "Create New",
	position = "inline",
	icon = Plus,
	variant = "default",
	...props
}) => {
	return (
		<ActionButton
			label={label}
			icon={icon}
			variant={variant}
			isFab={position === "fab"}
			{...props}
		/>
	);
};

CreateButton.displayName = "CreateButton";
