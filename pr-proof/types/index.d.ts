/** A half-block preview: Raster cells, two image pixels per cell (▀). */
export type Preview = { columns: number; rows: number; cells: string }

declare module 'claude-code' {
  interface PluginState {
    'pr-proof': {
      /** The reveals the person opened, `<record folder>@<message requestId>`. */
      open: string[]
      /** The PRs this session touched, as `name#541`: one a command printed, or a record it wrote. */
      seen: string[]
    }
  }
}
