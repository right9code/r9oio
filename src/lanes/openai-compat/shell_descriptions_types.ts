/**
 * Shared types for shell_descriptions.ts. Split into its own file so the
 * Transformer interface in base.ts can re-use the type without pulling
 * in the description renderer (no circular dep risk if a transformer
 * ever wants to reference the edition type from base).
 */

export type POSIXShellEdition = 'desktop' | 'core'
