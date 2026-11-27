const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function displayWidth(text: string): number {
  return Bun.stringWidth(text)
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (displayWidth(text) <= maxWidth) return text
  let truncated = ""
  let usedWidth = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = displayWidth(segment)
    if (usedWidth + segmentWidth > maxWidth - 1) break
    truncated += segment
    usedWidth += segmentWidth
  }
  return truncated + "…"
}

export function fitToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width)
  return truncated + " ".repeat(Math.max(0, width - displayWidth(truncated)))
}

export function wrapToWidth(text: string, width: number): string[] {
  const lines: string[] = []
  let currentLine = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = currentLine ? `${currentLine} ${word}` : word
    if (displayWidth(candidate) <= width) {
      currentLine = candidate
      continue
    }
    if (currentLine) lines.push(currentLine)
    currentLine = truncateToWidth(word, width)
  }
  lines.push(currentLine)
  return lines
}

// Prompts and titles come from a transcript and may hold line breaks or escape codes.
export function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
}

// An OSC 8 hyperlink: the terminal opens the address when the text is clicked.
export function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}

function paired(startCode: number, endCode: number) {
  return (text: string) => `\x1b[${startCode}m${text}\x1b[${endCode}m`
}

// Each style ends with its own off code, so styles nest without a full reset.
export const style = {
  bold: paired(1, 22),
  dim: paired(2, 22),
  red: paired(31, 39),
  green: paired(32, 39),
  yellow: paired(33, 39),
  magenta: paired(35, 39),
  cyan: paired(36, 39),
  blueBackground: paired(44, 49),
}

export type Colorize = (text: string) => string
export const plain: Colorize = (text) => text
