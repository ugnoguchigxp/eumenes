/**
 * Workspace files an agent must never read or write: dotenv files, private keys and
 * certificates, credential stores. Dotfiles are listed explicitly because a leading `*` is not
 * relied on to match a name that starts with a dot.
 */
export const SENSITIVE_FILE_GLOBS: readonly string[] = [
	"**/.env",
	"**/.env.*",
	"**/*.env",
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
	"**/*.jks",
	"**/*.keystore",
	"**/id_rsa*",
	"**/id_dsa*",
	"**/id_ecdsa*",
	"**/id_ed25519*",
	"**/.netrc",
	"**/.pgpass",
];
