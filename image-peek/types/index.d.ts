/** A half-block preview: Raster cells, two image pixels per cell (▀). */
export type PeekPreview = { columns: number; rows: number; cells: string }

/** One image the mod has seen: pasted by the person or sent by Claude. */
export type PeekImage = {
  /** Session-wide number shown on the card, `#n`; what the commands take. */
  n: number
  /** The transcript row the card sits under: a prompt's uuid or a tool_use_id. */
  row: string
  /** Absolute path on this machine. */
  path: string
  /** `Image #2` for a paste, the file name for one Claude sent. */
  label: string
  /** A paste's prompt text, to find its row if the row id differs. */
  prompt?: string
  from: 'pasted' | 'claude'
  /** Original size in pixels, when ImageMagick could read it. */
  width?: number
  height?: number
  preview?: PeekPreview
  /** A PNG copy of a non-PNG image, the file a sharp image is drawn from. */
  png?: string
}

declare module 'claude-code' {
  interface PluginState {
    'image-peek': { images: PeekImage[]; seq: number }
  }
}
