import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkPlan, listPlans, renderPlans, type PlanList } from "./plans.ts"
import { displayWidth } from "./text.ts"

test("discovers plans and checks the selected file in the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "rexystele-plans-"))
  try {
    expect(await listPlans(root)).toEqual([])
    await mkdir(join(root, "plans"))
    await writeFile(join(root, "plans/second plan.stele"), "plan second {}")
    await writeFile(join(root, "plans/first.stele"), "plan first {}")
    await symlink("first.stele", join(root, "plans/alias.stele"))
    const paths = await listPlans(root)
    expect(paths).toEqual(["plans/first.stele", "plans/second plan.stele"])
    const stele = join(root, "stele")
    await writeFile(stele, '#!/bin/sh\n[ "$1" = plan ] && [ "$2" = check ] && cat "$3" || exit 2\necho "missing anchor" >&2\nexit 1\n')
    await chmod(stele, 0o755)
    const report = await checkPlan(root, paths[1]!, stele)
    expect(report).toEqual(["Plan has findings", "plan second {}", "missing anchor", "", "Plan source", "plan second {}"])
    await writeFile(stele, '#!/bin/sh\necho "invalid plan" >&2\nexit 2\n')
    expect(await checkPlan(root, paths[1]!, stele)).toContain("Could not check plan (exit 2)")
    expect(await checkPlan(root, paths[0]!, join(root, "absent"))).toContain("Could not run Stele")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("plan list and report fit the pane and keep file contents inert", () => {
  const escape = "\x1b]52;c;unsafe\x07"
  const list: PlanList = { kind: "list", directory: "/tmp", paths: [`plans/${escape}.stele`], index: 0 }
  const detail = { kind: "detail" as const, list, lines: ["Plan source", escape + "\u009b31m"], offset: 0 }
  for (const page of [list, detail]) {
    const lines = renderPlans(page, 60, 12)
    expect(lines).toHaveLength(12)
    for (const line of lines) {
      expect(displayWidth(line)).toBe(60)
      expect(line).not.toContain(escape)
      expect(line).not.toContain("\u009b")
    }
  }
})
