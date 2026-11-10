// Minimal local stand-in for the upstream generated SDK settings types.
// The real file is produced by the upstream typegen pipeline which is not
// part of this source checkout. Only the names actually re-exported by
// agentSdkTypes.ts are declared here.

export type Settings = {
  hooks?: Record<string, unknown>
  [key: string]: unknown
}
