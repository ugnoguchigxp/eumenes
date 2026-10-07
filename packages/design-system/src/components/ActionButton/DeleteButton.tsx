import { Trash2 } from "lucide-react";
import type React from "react";
import { ActionButton, type ActionButtonProps } from "./ActionButton";

/**
 * 削除ボタン
 */
export const DeleteButton: React.FC<ActionButtonProps> = ({
	label = "Delete",
	icon = Trash2,
	variant = "destructive",
	...props
}) => {
	return (
		<ActionButton label={label} icon={icon} variant={variant} {...props} />
	);
};

DeleteButton.displayName = "DeleteButton";
