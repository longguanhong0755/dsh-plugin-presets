/** Shared constants for dsh-plugin-presets. */
export const PACKAGE_NAME = 'dsh-plugin-presets'
export const ROW_ID = 'plugin-presets'
export const COMMAND_NAME = 'plugin-presets'
export const TOOL_NAME = 'plugin_presets'

export const DATA_DIR_NAME = 'plugin-presets'
export const EXPORT_FORMAT = 'dsh-plugin-presets'
export const EXPORT_FORMAT_VERSION = 1
export const PRESET_SCHEMA_VERSION = 1
export const INDEX_SCHEMA_VERSION = 1
export const BACKUP_SCHEMA_VERSION = 1

export const DEFAULT_MAX_PRESETS = 100
export const DEFAULT_MAX_BACKUPS = 20
export const MAX_PRESETS_LIMIT = 500
export const MAX_BACKUPS_LIMIT = 200
export const MAX_NAME_LENGTH = 80
export const MAX_DESCRIPTION_LENGTH = 2000
export const MAX_BUNDLES = 200
export const MAX_PATCH_BYTES = 16 * 1024 * 1024
export const MAX_IMPORT_BYTES = 24 * 1024 * 1024
export const MAX_ENTRIES = 2000
export const MAX_CONFIG_DEPTH = 64

/** Bundles that keep the management surfaces alive; a preset may never drop them. */
export const DEFAULT_PROTECTED_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base'])

/** Plugin modules whose owning bundles must stay selected while this plugin manages the profile. */
export const PROTECTED_MODULES = Object.freeze([
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-hmr',
  '@deepseek-ai/dsh-config-editor',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-tools',
  PACKAGE_NAME,
])

export const HIGHER_PRIORITY_SOURCES = Object.freeze({
  HOME: 'home-patch',
  ARGV: 'command-line-overlay',
})
