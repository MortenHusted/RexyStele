// The viewer as a terminal app: it asks Stele what the change in a directory touches, and asks
// again when the branch or a tracked file changes.
import { outputOf, runCommand, runQuietly } from "./command.ts"
import { parseAnchor, parseHunks, parseLocation, type DiffHunk } from "./diff.ts"
import { editorCommandFor } from "./editor.ts"
import { availableBaseChoices, isFailure, readImpact, type BaseChoice, type Impact } from "./impact.ts"
import { readChangeFingerprint, readRepositoryState, type RepositoryState } from "./repository.ts"
import { buildRows, renderScreen, type SelectableRow } from "./view.ts"
import { checkPlan, listPlans, renderPlans, type PlanList, type PlanScreen } from "./plans.ts"

export type ViewerOptions = {
  workingDirectory: string
  gitBinary: string
  steleBinary: string
  baseBranch?: string
  // The name of an editor, or a command with {file} and {line} to fill in. See editor.ts.
  editorCommand?: string
}

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l"
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l"
const KEY_PATTERN = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g
const CHANGE_POLL_MILLISECONDS = 3_000
const DETAIL_SCROLL_STEP = 8

let options: ViewerOptions
let repository: RepositoryState | null = null
let impact: Impact | null = null
let failure: string | null = null
let isLoading = true
let rows: SelectableRow[] = []
let selectedRowKey: string | undefined
let detailScrollOffset = 0
let largestDetailScrollOffset = 0
let statusMessage = ""
let baseChoice: BaseChoice = "mergeBase"
let changeFingerprint: string | undefined
let loadGeneration = 0
let plans: PlanScreen | null = null
const hunksByFile = new Map<string, DiffHunk[]>()
const filesBeingRead = new Set<string>()

function rowKey(row: SelectableRow): string {
  return row.kind === "statement" ? `statement:${row.statement.id}` : `unmapped:${row.symbol}`
}

function selectedRowIndex(): number {
  return Math.max(0, rows.findIndex((row) => rowKey(row) === selectedRowKey))
}

function selectedRow(): SelectableRow | undefined {
  return rows[selectedRowIndex()]
}

function render() {
  if (plans) {
    const lines = renderPlans(plans, process.stdout.columns, process.stdout.rows)
    process.stdout.write(`\x1b[?2026h\x1b[H\x1b[2J${lines.join("\r\n")}\x1b[?2026l`)
    return
  }
  const screen = renderScreen(
    {
      repository,
      impact,
      failure,
      isLoading,
      rows,
      selectedRowIndex: selectedRowIndex(),
      detailScrollOffset,
      hunksByFile,
      statusMessage,
    },
    process.stdout.columns,
    process.stdout.rows,
  )
  largestDetailScrollOffset = screen.largestDetailScrollOffset
  detailScrollOffset = Math.min(detailScrollOffset, largestDetailScrollOffset)
  process.stdout.write(`\x1b[?2026h\x1b[H\x1b[2J${screen.lines.join("\r\n")}\x1b[?2026l`)
}

function filesOf(row: SelectableRow): string[] {
  if (row.kind === "unmapped") return [parseAnchor(row.symbol).filePath]
  return [...new Set(row.statement.anchors.map((anchor) => parseLocation(anchor.location).filePath))]
}

async function readFileHunks(filePath: string, generation: number) {
  if (!repository || !impact) return
  const revisions = impact.scope.headCommit ? [impact.scope.baseCommit, impact.scope.headCommit] : [impact.scope.baseCommit]
  const result = await runCommand(
    [options.gitBinary, "diff", "--no-color", "--no-ext-diff", "-U3", ...revisions, "--", filePath],
    repository.directory,
  )
  filesBeingRead.delete(filePath)
  if (generation !== loadGeneration) return
  hunksByFile.set(filePath, result && result.exitCode === 0 ? parseHunks(result.output) : [])
  render()
}

function readSelectedDiffs() {
  const row = selectedRow()
  if (!row) return
  for (const filePath of filesOf(row)) {
    if (hunksByFile.has(filePath) || filesBeingRead.has(filePath)) continue
    filesBeingRead.add(filePath)
    void readFileHunks(filePath, loadGeneration)
  }
}

async function load() {
  const generation = ++loadGeneration
  isLoading = true
  render()
  const foundRepository = await readRepositoryState(options.gitBinary, options.workingDirectory, options.baseBranch)
  if (generation !== loadGeneration) return
  repository = foundRepository
  if (!foundRepository) {
    failure = `${options.workingDirectory} is not in a git repository with a base branch to compare with.`
    impact = null
    rows = []
    isLoading = false
    return render()
  }
  changeFingerprint = await readChangeFingerprint(options.gitBinary, foundRepository.directory)
  const result = await readImpact(options.steleBinary, foundRepository, baseChoice)
  if (generation !== loadGeneration) return
  hunksByFile.clear()
  filesBeingRead.clear()
  if (isFailure(result)) {
    failure = result.failure
    impact = null
  } else {
    failure = null
    impact = result
    if (!availableBaseChoices(!result.scope.committedChangesOnly).includes(baseChoice)) baseChoice = "mergeBase"
  }
  rows = buildRows(impact)
  isLoading = false
  readSelectedDiffs()
  render()
}

async function reloadWhenChanged() {
  if (isLoading || !repository) return
  const currentFingerprint = await readChangeFingerprint(options.gitBinary, repository.directory)
  if (currentFingerprint === changeFingerprint || isLoading) return
  statusMessage = "the code changed, asking Stele again"
  void load()
}

function refresh() {
  statusMessage = `updated ${new Date().toTimeString().slice(0, 5)}`
  void load()
}

function select(rowIndex: number) {
  const row = rows.at(rowIndex)
  if (!row) return
  selectedRowKey = rowKey(row)
  detailScrollOffset = 0
  readSelectedDiffs()
}

function moveSelection(step: number) {
  if (rows.length === 0) return
  select((selectedRowIndex() + step + rows.length) % rows.length)
}

function scrollDetail(step: number) {
  detailScrollOffset = Math.max(0, Math.min(largestDetailScrollOffset, detailScrollOffset + step))
}

function cycleBase() {
  const choices = availableBaseChoices(impact ? !impact.scope.committedChangesOnly : true)
  baseChoice = choices[(choices.indexOf(baseChoice) + 1) % choices.length] ?? "mergeBase"
  statusMessage =
    baseChoice === "mergeBase"
      ? `comparing with ${repository?.baseBranch ?? "the base branch"}`
      : baseChoice === "lastCommit"
        ? "comparing with the commit before the last"
        : "showing uncommitted changes only"
  void load()
}

function openFile(filePath: string, lineNumber: number) {
  const absolutePath = filePath.startsWith("/") ? filePath : `${repository?.directory ?? "."}/${filePath}`
  const command = editorCommandFor(options.editorCommand, absolutePath, lineNumber)
  void runQuietly(command).then((isOpened) => {
    statusMessage = isOpened ? `opened ${filePath}` : `could not run ${command[0]}`
    render()
  })
}

function openSelectedCode() {
  const row = selectedRow()
  if (!row) return
  if (row.kind === "unmapped") return openFile(parseAnchor(row.symbol).filePath, 1)
  const firstAnchor = row.statement.anchors[0]
  if (!firstAnchor) return
  const { filePath, range } = parseLocation(firstAnchor.location)
  openFile(filePath, range?.firstLine ?? 1)
}

function openSelectedStatement() {
  const row = selectedRow()
  const catalogStatement = row?.kind === "statement" ? row.statement.catalogStatement : undefined
  if (catalogStatement) openFile(catalogStatement.filePath, catalogStatement.lineNumber)
  else statusMessage = "no catalog statement to open"
}

function copySelectedId() {
  const row = selectedRow()
  if (!row) return
  const copiedText = row.kind === "statement" ? row.statement.id : row.symbol
  const clipboardCommand = process.platform === "darwin" ? "pbcopy" : "wl-copy"
  void runQuietly([clipboardCommand], copiedText).then((isCopied) => {
    statusMessage = isCopied ? `copied ${copiedText}` : `could not run ${clipboardCommand}`
    render()
  })
}

function quit() {
  process.stdout.write(LEAVE_SCREEN)
  process.stdin.setRawMode(false)
  process.exit(0)
}

async function showPlan(list: PlanList) {
  const detail: PlanScreen = { kind: "detail", list, lines: ["Checking plan…"], offset: 0 }
  plans = detail
  render()
  try {
    detail.lines = await checkPlan(list.directory, list.paths[list.index]!, options.steleBinary)
  } catch (error) {
    detail.lines = [String(error)]
  }
  if (plans === detail) render()
}

async function showPlans() {
  const loading: PlanScreen = { kind: "message", message: "Reading worktree plans…" }
  plans = loading
  render()
  try {
    const root = await outputOf([options.gitBinary, "rev-parse", "--show-toplevel"], options.workingDirectory)
    const directory = root?.trimEnd()
    const paths = directory ? await listPlans(directory) : []
    if (plans !== loading) return
    if (directory && paths.length) {
      plans = { kind: "list", directory, paths, index: 0 }
      if (paths.length === 1) return showPlan(plans)
    } else {
      loading.message = directory ? "No plans/*.stele files in this worktree." : "Open a Git worktree to see its plans."
    }
  } catch (error) {
    loading.message = String(error)
  }
  render()
}

function handlePlanKey(screen: PlanScreen, key: string) {
  if (key === "q" || key === "\x03") return quit()
  if (key === "p" || key === "\x1b") {
    plans = key === "\x1b" && screen.kind === "detail" && screen.list.paths.length > 1 ? screen.list : null
    return
  }
  if (key === "r") return screen.kind === "detail" ? void showPlan(screen.list) : void showPlans()
  if (key === "\r" && screen.kind === "list") return void showPlan(screen)
  if (screen.kind === "detail" && ["J", " ", "\x1b[6~", "K", "\x1b[5~"].includes(key)) {
    const direction = ["K", "\x1b[5~"].includes(key) ? -1 : 1
    screen.offset = Math.max(0, screen.offset + direction * DETAIL_SCROLL_STEP)
    return
  }
  const down = ["j", "\x1b[B", "\x1bOB"].includes(key)
  const up = ["k", "\x1b[A", "\x1bOA"].includes(key)
  if (!down && !up) return
  const step = down ? 1 : -1
  if (screen.kind === "list") screen.index = (screen.index + step + screen.paths.length) % screen.paths.length
  if (screen.kind === "detail") screen.offset = Math.max(0, screen.offset + step)
}

function handleKey(key: string) {
  if (plans) return handlePlanKey(plans, key)
  if (key === "p") return void showPlans()
  switch (key) {
    case "q":
    case "\x1b":
    case "\x03":
      return quit()
    case "j":
    case "\t":
    case "\x1b[B":
    case "\x1bOB":
      return moveSelection(1)
    case "k":
    case "\x1b[Z":
    case "\x1b[A":
    case "\x1bOA":
      return moveSelection(-1)
    case "g":
      return select(0)
    case "G":
      return select(-1)
    case "J":
    case " ":
    case "\x04":
    case "\x1b[6~":
      return scrollDetail(DETAIL_SCROLL_STEP)
    case "K":
    case "\x15":
    case "\x1b[5~":
      return scrollDetail(-DETAIL_SCROLL_STEP)
    case "b":
      return cycleBase()
    case "r":
      return refresh()
    case "\r":
    case "o":
      return openSelectedCode()
    case "c":
      return openSelectedStatement()
    case "y":
      return copySelectedId()
  }
}

export function startViewer(viewerOptions: ViewerOptions) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("rexystele needs a terminal")
    process.exit(1)
  }
  options = viewerOptions
  process.stdout.write(ENTER_SCREEN)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on("data", (chunk: Buffer) => {
    for (const key of chunk.toString("utf8").match(KEY_PATTERN) ?? []) handleKey(key)
    render()
  })
  process.stdout.on("resize", render)
  process.on("SIGTERM", quit)
  process.on("SIGHUP", quit)
  setInterval(() => void reloadWhenChanged(), CHANGE_POLL_MILLISECONDS)
  void load()
}
