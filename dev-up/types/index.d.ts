/** One service as the hint line draws it; `done` marks a task whose output exists (✓, not ●). */
export type Dot = { name: string; state: "up" | "starting" | "down" | "broken"; done?: true; from?: string };
/** The stack the session's folder belongs to, as last seen; null when none covers it. */
export type Dots = { stack: string; services: Dot[] } | null;

/** One cell of the panel: a service, its state, and the end of its log. */
export type Cell = Dot & { kind: "compose" | "server" | "task" | "check"; detail: string; lines: string[] };
/** What `/dev-up panel` draws; null until it first fills. */
export type Panel = { stack: string; cells: Cell[] } | null;

declare module "claude-code" {
  interface PluginState {
    "dev-up": {
      /** What the hint line under the prompt shows, written by passes, commands and the 30 s refresh. */
      dots: Dots;
      /** The panel's cells, refilled every few seconds while it is open. */
      panel: Panel;
    };
  }
}
