/** A half-block preview: Raster cells, two image pixels per cell (▀). */
export type Preview = { columns: number; rows: number; cells: string }

declare module 'claude-code' {
  interface PluginState {
    'pr-proof': {
      /** The reveals the person opened, `<record folder>@<message requestId>`. */
      open: string[]
      /** The PRs that are this session's, as `name#541`: one it opened or changed with `gh pr`, a record it wrote or named by path, or one the person named. */
      seen: string[]
    }
  }
}
