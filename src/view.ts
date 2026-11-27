// Draws the whole screen as lines of exactly the terminal's width. It reads no state of its own.
import { homedir } from "node:os"
import { hunksTouching, parseAnchor, parseLocation, type DiffHunk } from "./diff.ts"
import type { AnchorChange, BaseChoice, Impact, TouchedStatement } from "./impact.ts"
import type { RepositoryState } from "./repository.ts"
import {
  displayWidth,
  fitToWidth,
  plain,
  singleLine,
  style,
  truncateToWidth,
  wrapToWidth,
  type Colorize,
} from "./text.ts"

export type SelectableRow =
  | { kind: "statement"; statement: TouchedStatement }
  | { kind: "unmapped"; symbol: string }

export type ViewerState = {
  repository: RepositoryState | null
  impact: Impact | null
  failure: string | null
  isLoading: boolean
  rows: SelectableRow[]
  selectedRowIndex: number
  detailScrollOffset: number
  // A file's hunks once git has answered; a missing file is still being read.
  hunksByFile: Map<string, DiffHunk[]>
  statusMessage: string
}

export type RenderedScreen = {
  lines: string[]
  // The furthest the detail panel can scroll, so the caller can stop there.
  largestDetailScrollOffset: number
}

const KEY_HINTS: [key: string, action: string][] = [
  ["↑↓", "select"],
  ["J K", "scroll"],
  ["p", "plans"],
  ["b", "base"],
  ["r", "refresh"],
  ["enter", "open code"],
  ["c", "open statement"],
  ["y", "copy id"],
  ["q", "quit"],
]
const SIDE_BY_SIDE_WIDTH = 100
const REMOVED_MARKER = "✗"
const CHANGED_MARKER = "●"
const UNTOUCHED_MARKER = "·"
const UNMAPPED_MARKER = "+"
const TAB_WIDTH = 2
const LARGEST_SHOWN_DIFF_LINES = 400

const BASE_LABELS: Record<BaseChoice, string> = {
  mergeBase: "",
  lastCommit: "last commit",
  uncommitted: "uncommitted changes",
}

export function buildRows(impact: Impact | null): SelectableRow[] {
  if (!impact) return []
  return [
    ...impact.statements.map((statement): SelectableRow => ({ kind: "statement", statement })),
    ...impact.unmappedSymbols.map((symbol): SelectableRow => ({ kind: "unmapped", symbol })),
  ]
}

function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function shortenHome(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function highlight(line: string, isSelected: boolean): string {
  return isSelected ? style.blueBackground(style.bold(line)) : line
}

function isRemoved(statement: TouchedStatement): boolean {
  return statement.anchors.some((anchor) => anchor.change === "removed")
}

function standingColor(standing: string): Colorize {
  if (standing === "verified") return style.green
  if (standing === "unapproved" || standing === "stale") return style.yellow
  return style.dim
}

function shortAnchor(anchor: string): string {
  const { filePath, symbol } = parseAnchor(anchor)
  return symbol ? symbol : filePath
}

function baseLabel(repository: RepositoryState, impact: Impact | null): string {
  const baseChoice = impact?.scope.baseChoice ?? "mergeBase"
  if (baseChoice !== "mergeBase") return BASE_LABELS[baseChoice]
  const behind = repository.commitsBehindBase > 0 ? `, ${repository.commitsBehindBase} behind` : ""
  return `${repository.baseBranch}${behind}`
}

function headerLine(state: ViewerState, width: number): string {
  const { repository, impact } = state
  if (!repository) return style.bold(fitToWidth(" RexyStele", width))
  const facts = [`${repository.branch} ← ${baseLabel(repository, impact)}`]
  if (impact) {
    if (impact.scope.committedChangesOnly) {
      const hidden =
        repository.uncommittedFileCount > 0
          ? `, ${countOf(repository.uncommittedFileCount, "uncommitted file")} left out`
          : ""
      facts.push(`commits only${hidden}`)
    }
    facts.push(`${impact.statements.length} touched`)
    facts.push(`${impact.unmappedSymbols.length} unmapped`)
    if (impact.awaitingApprovalCount > 0) facts.push(`${impact.awaitingApprovalCount} to approve`)
  }
  const title = " RexyStele  "
  const factsText = truncateToWidth(facts.join(" · "), Math.max(0, width - displayWidth(title) - 1))
  const needsAttention = Boolean(
    impact && (impact.awaitingApprovalCount > 0 || (impact.scope.committedChangesOnly && repository.uncommittedFileCount > 0)),
  )
  const factsColor = needsAttention ? style.yellow : style.dim
  const padding = " ".repeat(Math.max(0, width - displayWidth(title) - displayWidth(factsText)))
  return style.bold(style.cyan(title)) + factsColor(factsText) + padding
}

function statementRowLine(statement: TouchedStatement, isSelected: boolean, width: number): string {
  const marker = isRemoved(statement) ? REMOVED_MARKER : CHANGED_MARKER
  const markerColor = isRemoved(statement) ? style.red : style.yellow
  const needsStanding = statement.standing !== "unverified"
  const standing = needsStanding ? ` ${statement.standing}` : ""
  const idWidth = Math.max(0, width - 3 - displayWidth(standing))
  const line = ` ${markerColor(marker)} ${fitToWidth(statement.id, idWidth)}${standingColor(statement.standing)(standing)}`
  return highlight(line, isSelected)
}

function unmappedRowLine(symbol: string, isSelected: boolean, width: number): string {
  const line = ` ${style.cyan(UNMAPPED_MARKER)} ${fitToWidth(shortAnchor(symbol), Math.max(0, width - 3))}`
  return highlight(line, isSelected)
}

function listLines(state: ViewerState, width: number): { lines: string[]; selectedLineIndex: number } {
  const lines: string[] = []
  let selectedLineIndex = 0
  let currentArea: string | undefined
  let unmappedHeadingShown = false
  state.rows.forEach((row, rowIndex) => {
    const isSelected = rowIndex === state.selectedRowIndex
    if (row.kind === "statement") {
      const area = row.statement.catalogStatement?.area ?? "other"
      if (area !== currentArea) {
        if (lines.length > 0) lines.push(" ".repeat(width))
        lines.push(style.bold(style.cyan(fitToWidth(` ${area}`, width))))
        currentArea = area
      }
      if (isSelected) selectedLineIndex = lines.length
      lines.push(statementRowLine(row.statement, isSelected, width))
      return
    }
    if (!unmappedHeadingShown) {
      if (lines.length > 0) lines.push(" ".repeat(width))
      lines.push(style.bold(style.cyan(fitToWidth(" code no statement maps", width))))
      unmappedHeadingShown = true
    }
    if (isSelected) selectedLineIndex = lines.length
    lines.push(unmappedRowLine(row.symbol, isSelected, width))
  })
  return { lines, selectedLineIndex }
}

function wrapped(text: string, width: number, color: Colorize = plain, indent = " "): string[] {
  const innerWidth = Math.max(1, width - displayWidth(indent))
  return wrapToWidth(singleLine(text), innerWidth).map((line) => indent + color(fitToWidth(line, innerWidth)))
}

function heading(title: string, width: number): string[] {
  return [" ".repeat(width), style.cyan(fitToWidth(` ${title}`, width))]
}

function diffLine(line: string, width: number): string {
  const shown = fitToWidth(` ${line.replaceAll("\t", " ".repeat(TAB_WIDTH))}`, width)
  if (line.startsWith("@@")) return style.cyan(shown)
  if (line.startsWith("+")) return style.green(shown)
  if (line.startsWith("-")) return style.red(shown)
  return style.dim(shown)
}

function diffLines(state: ViewerState, location: string, width: number): string[] {
  const { filePath, range } = parseLocation(location)
  const fileHeading = style.bold(fitToWidth(` ${location}`, width))
  const fileHunks = state.hunksByFile.get(filePath)
  if (!fileHunks) return [fileHeading, style.dim(fitToWidth(" reading the diff…", width))]
  const shownHunks = hunksTouching(fileHunks, range)
  if (shownHunks.length === 0) {
    const reason = fileHunks.length === 0 ? " git shows no change to this file" : " the file changed outside these lines"
    return [fileHeading, style.dim(fitToWidth(reason, width))]
  }
  const hunkLines = shownHunks.flatMap((hunk) => hunk.lines)
  const lines = [fileHeading, ...hunkLines.slice(0, LARGEST_SHOWN_DIFF_LINES).map((line) => diffLine(line, width))]
  if (hunkLines.length > LARGEST_SHOWN_DIFF_LINES) {
    lines.push(style.dim(fitToWidth(` … ${hunkLines.length - LARGEST_SHOWN_DIFF_LINES} more lines`, width)))
  }
  return lines
}

function mappedCodeLines(statement: TouchedStatement, width: number): string[] {
  const changesByAnchor = new Map(statement.anchors.map((anchor): [string, AnchorChange] => [anchor.anchor, anchor]))
  const mappedAnchors = statement.catalogStatement?.realizedBy ?? statement.anchors.map((anchor) => anchor.anchor)
  return mappedAnchors.map((anchor) => {
    const change = changesByAnchor.get(anchor)
    const marker = !change ? UNTOUCHED_MARKER : change.change === "removed" ? REMOVED_MARKER : CHANGED_MARKER
    const color = !change ? style.dim : change.change === "removed" ? style.red : style.yellow
    const changeLabel = change ? `  ${change.change}` : ""
    const anchorWidth = Math.max(0, width - 3 - displayWidth(changeLabel))
    return ` ${color(marker)} ${color(fitToWidth(shortAnchor(anchor), anchorWidth))}${color(changeLabel)}`
  })
}

function statementDetailLines(state: ViewerState, statement: TouchedStatement, width: number): string[] {
  const catalogStatement = statement.catalogStatement
  const lines = [
    ` ${style.dim(statement.kind)} ${style.bold(truncateToWidth(statement.id, Math.max(0, width - statement.kind.length - 2)))}`,
    ` ${standingColor(statement.standing)(fitToWidth(statement.standing, Math.max(0, width - 1)))}`,
  ]
  if (catalogStatement) {
    lines.push(" ".repeat(width), ...wrapped(catalogStatement.text, width))
    const parent = catalogStatement.parentId ? state.impact?.catalog.statements.get(catalogStatement.parentId) : undefined
    if (catalogStatement.parentId) {
      lines.push(...heading(`refines ${catalogStatement.parentId}`, width))
      if (parent) lines.push(...wrapped(parent.text, width, style.dim))
    }
    if (catalogStatement.citationLines.length > 0) {
      lines.push(...heading("sources", width))
      for (const citation of catalogStatement.citationLines) lines.push(...wrapped(citation, width, style.dim))
    }
  } else {
    lines.push(" ".repeat(width), ...wrapped("This statement is not in the catalog files that were read.", width, style.dim))
  }
  lines.push(...heading("mapped code", width), ...mappedCodeLines(statement, width))
  lines.push(...heading("what changed", width))
  for (const anchor of statement.anchors) lines.push(...diffLines(state, anchor.location, width))
  if (catalogStatement) {
    const catalogLocation = `${shortenHome(catalogStatement.filePath)}:${catalogStatement.lineNumber}`
    lines.push(...heading("catalog", width), style.dim(fitToWidth(` ${catalogLocation}`, width)))
  }
  return lines
}

function unmappedDetailLines(state: ViewerState, symbol: string, width: number): string[] {
  const { filePath, symbol: symbolName } = parseAnchor(symbol)
  return [
    ` ${style.dim("code")} ${style.bold(truncateToWidth(symbolName ?? filePath, Math.max(0, width - 6)))}`,
    style.dim(fitToWidth(` ${filePath}`, width)),
    " ".repeat(width),
    ...wrapped("No statement in the catalog maps this code. If it is behaviour people rely on, it may deserve a definition; if it realizes an existing one, add it to that definition's realized_by.", width),
    ...heading("what changed", width),
    ...diffLines(state, filePath, width),
  ]
}

function messageLines(message: string, width: number): string[] {
  return message.split("\n").flatMap((paragraph) => wrapped(paragraph, width, style.dim))
}

function detailLines(state: ViewerState, width: number): string[] {
  if (state.failure) return messageLines(state.failure, width)
  const selectedRow = state.rows[state.selectedRowIndex]
  if (!selectedRow) {
    if (state.isLoading) return messageLines("Asking Stele what this change touches…", width)
    return messageLines("This change touches no statement in the catalog, and no code the catalog leaves unmapped.", width)
  }
  return selectedRow.kind === "statement"
    ? statementDetailLines(state, selectedRow.statement, width)
    : unmappedDetailLines(state, selectedRow.symbol, width)
}

export function scrollOffsetFor(anchorLineIndex: number, lineCount: number, visibleCount: number): number {
  const lastOffset = Math.max(0, lineCount - visibleCount)
  return Math.min(lastOffset, Math.max(0, anchorLineIndex - Math.floor(visibleCount / 2)))
}

export function frame(
  title: string,
  footer: string,
  contentLines: string[],
  scrollOffset: number,
  isFocused: boolean,
  width: number,
  height: number,
): string[] {
  if (height <= 0) return []
  const focusedStyle: Colorize = (text) => style.green(style.bold(text))
  const border = isFocused ? focusedStyle : style.dim
  const label = isFocused ? focusedStyle : plain
  const innerWidth = width - 2
  const innerHeight = height - 2
  const shownTitle = truncateToWidth(title, innerWidth - 2)
  const shownFooter = truncateToWidth(footer, innerWidth - 2)
  const topRule = "─".repeat(Math.max(0, innerWidth - 1 - displayWidth(shownTitle)))
  const bottomRule = "─".repeat(Math.max(0, innerWidth - 1 - displayWidth(shownFooter)))
  const framed = [border("╭─") + label(shownTitle) + border(`${topRule}╮`)]
  for (let lineIndex = 0; lineIndex < innerHeight; lineIndex++) {
    const contentLine = contentLines[scrollOffset + lineIndex] ?? ""
    const padding = " ".repeat(Math.max(0, innerWidth - displayWidth(contentLine)))
    framed.push(border("│") + contentLine + padding + border("│"))
  }
  framed.push(border(`╰${bottomRule}`) + label(shownFooter) + border("─╯"))
  return framed.slice(0, height)
}

function hintLine(statusMessage: string, width: number): string {
  const status = truncateToWidth(statusMessage, Math.floor(width / 2))
  const availableWidth = width - 3 - displayWidth(status)
  let hints = ""
  let hintsWidth = 0
  for (const [key, action] of KEY_HINTS) {
    const separator = hintsWidth > 0 ? "   " : ""
    const hintWidth = displayWidth(`${separator}${key} ${action}`)
    if (hintsWidth + hintWidth > availableWidth) break
    hints += `${separator}${style.bold(style.cyan(key))} ${style.dim(action)}`
    hintsWidth += hintWidth
  }
  const gap = " ".repeat(Math.max(0, width - 2 - hintsWidth - displayWidth(status)))
  return ` ${hints}${gap}${status} `
}

function positionFooter(scrollOffset: number, lineCount: number, visibleCount: number): string {
  if (lineCount <= visibleCount) return ""
  return `${Math.min(lineCount, scrollOffset + visibleCount)}/${lineCount}`
}

export function renderScreen(state: ViewerState, width: number, height: number): RenderedScreen {
  if (width < 50 || height < 12) {
    return { lines: [truncateToWidth("RexyStele needs a larger pane", width)], largestDetailScrollOffset: 0 }
  }
  const panelsHeight = height - 2
  const isSideBySide = width >= SIDE_BY_SIDE_WIDTH
  const listWidth = isSideBySide ? Math.min(Math.max(40, Math.floor(width * 0.36)), 64) : width
  const listHeight = isSideBySide ? panelsHeight : Math.max(5, Math.min(Math.floor(panelsHeight * 0.4), state.rows.length + 6))
  const detailWidth = isSideBySide ? width - listWidth : width
  const detailHeight = isSideBySide ? panelsHeight : panelsHeight - listHeight

  const list = listLines(state, listWidth - 2)
  const listScrollOffset = scrollOffsetFor(list.selectedLineIndex, list.lines.length, listHeight - 2)
  const listTitle = state.isLoading ? "Touched · asking Stele…" : "Touched"
  const listFooter = state.rows.length > 0 ? `${state.selectedRowIndex + 1} of ${state.rows.length}` : ""
  const listPanel = frame(listTitle, listFooter, list.lines, listScrollOffset, true, listWidth, listHeight)

  const detail = detailLines(state, detailWidth - 2)
  const largestDetailScrollOffset = Math.max(0, detail.length - (detailHeight - 2))
  const detailScrollOffset = Math.min(state.detailScrollOffset, largestDetailScrollOffset)
  const detailTitle = state.failure ? "Problem" : "Statement"
  const detailFooter = positionFooter(detailScrollOffset, detail.length, detailHeight - 2)
  const detailPanel = frame(detailTitle, detailFooter, detail, detailScrollOffset, false, detailWidth, detailHeight)

  const panels = isSideBySide
    ? listPanel.map((listLine, lineIndex) => listLine + (detailPanel[lineIndex] ?? ""))
    : [...listPanel, ...detailPanel]
  return {
    lines: [headerLine(state, width), ...panels, hintLine(state.statusMessage, width)],
    largestDetailScrollOffset,
  }
}
