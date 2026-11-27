import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { runCommand } from "./command.ts"
import { fitToWidth, singleLine, style, truncateToWidth, wrapToWidth } from "./text.ts"
import { frame, scrollOffsetFor } from "./view.ts"

export type PlanList = { kind: "list"; directory: string; paths: string[]; index: number }

export type PlanScreen =
  | { kind: "message"; message: string }
  | PlanList
  | { kind: "detail"; list: PlanList; lines: string[]; offset: number }

// Only regular plan files in this worktree are candidates, including newly created ones.
export async function listPlans(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(join(directory, "plans"), { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".stele"))
      .map((entry) => `plans/${entry.name}`).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export async function checkPlan(directory: string, path: string, stele: string): Promise<string[]> {
  const [source, check] = await Promise.all([
    readFile(join(directory, path), "utf8"),
    runCommand([stele, "plan", "check", path], directory),
  ])
  const result = check ? [check.output.trimEnd(), check.errorOutput.trimEnd()].filter(Boolean).join("\n") : ""
  let heading = "Could not run Stele"
  if (check) {
    if (check.exitCode === 0) heading = "Plan check passed"
    else if (check.exitCode === 1) heading = "Plan has findings"
    else heading = `Could not check plan (exit ${check.exitCode})`
  }
  return [heading, ...result.split("\n"), "", "Plan source", ...source.trimEnd().split("\n")]
}

export function renderPlans(screen: PlanScreen, width: number, height: number) {
  if (width < 50 || height < 12) return [truncateToWidth("RexyStele needs a larger pane", width)]
  const contentWidth = width - 2
  const visible = height - 3
  let title = "Worktree plans"
  let hints = "p impact   r refresh   q quit"
  let lines: string[]
  let offset = 0
  if (screen.kind === "message") {
    lines = wrapToWidth(singleLine(screen.message), contentWidth)
  } else if (screen.kind === "list") {
    lines = screen.paths.map((path, index) => {
      const line = fitToWidth(` ${singleLine(path)}`, contentWidth)
      return index === screen.index ? style.blueBackground(line) : line
    })
    offset = scrollOffsetFor(screen.index, lines.length, visible)
    hints = "↑↓ select   enter check   " + hints
  } else {
    title = singleLine(screen.list.paths[screen.list.index]!)
    lines = screen.lines.flatMap((line) => wrapToWidth(singleLine(line), contentWidth))
    offset = screen.offset = Math.min(screen.offset, Math.max(0, lines.length - visible))
    hints = "↑↓ scroll   esc back   " + hints
  }
  return [...frame(title, "", lines, offset, true, width, height - 1), style.dim(fitToWidth(" " + hints, width))]
}
