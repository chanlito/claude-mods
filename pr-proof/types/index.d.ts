/** A half-block preview: Raster cells, two image pixels per cell (▀). */
export type Preview = { columns: number; rows: number; cells: string }

declare module 'claude-code' {
  interface PluginState {
    'pr-proof': {
      /** The reveals the person opened, `<record folder>@<message requestId>`. */
      open: string[]
    }
  }
}
