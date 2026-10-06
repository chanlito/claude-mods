/** One service as the hint line draws it. */
export type Dot = { name: string; state: "up" | "starting" | "down" | "broken"; from?: string };
/** The stack the session's folder belongs to, as last seen; null when none covers it. */
export type Dots = { stack: string; services: Dot[] } | null;

declare module "claude-code" {
  interface PluginState {
    "dev-up": {
      /** What the hint line under the prompt shows, written by passes, commands and the 30 s refresh. */
      dots: Dots;
    };
  }
}
