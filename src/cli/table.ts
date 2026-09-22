import stringWidth from "string-width";
import { type TerminalContext, terminalText } from "./output.js";

export interface Column {
  label: string;
  numeric?: boolean;
}
type Value = string | number;
type Fact = readonly [string, Value];
const segments = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Safe text only: controls are escaped before measuring or wrapping. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "",
    used = 0;
  for (const { segment } of segments.segment(text)) {
    const size = stringWidth(segment);
    if (used + size > width && line) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += segment;
    used += size;
  }
  lines.push(line);
  return lines;
}
const safe = (value: Value) => terminalText(String(value));

/** Non-interactive ASCII output. No ANSI, process globals, stdin or cursor state. */
export class TextRenderer {
  readonly width: number;
  private readonly plain: boolean;
  private readonly lines: string[] = [];

  constructor(terminal?: TerminalContext) {
    const columns = terminal?.columns;
    this.width =
      terminal?.isTTY &&
      Number.isInteger(columns) &&
      columns !== undefined &&
      columns >= 20 &&
      columns <= 500
        ? columns
        : 100;
    this.plain = terminal?.term === "dumb";
    // Deliberately no color in any mode, including NO_COLOR and redirected output.
  }

  text(value: string): void {
    this.lines.push(...wrap(safe(value), this.width));
  }
  section(title: string, keepTogether = false): void {
    if (this.lines.length) this.lines.push("");
    if (keepTogether) this.lines.push(safe(title));
    else this.text(title);
    if (!this.plain)
      this.lines.push(
        "-".repeat(Math.min(this.width, stringWidth(safe(title)))),
      );
  }
  facts(items: readonly Fact[]): void {
    let line = "";
    for (const [label, value] of items) {
      const part = `${safe(label)}: ${safe(value)}`;
      if (line && stringWidth(`${line}  |  ${part}`) > this.width) {
        this.lines.push(...wrap(line, this.width));
        line = "";
      }
      line += `${line ? "  |  " : ""}${part}`;
    }
    if (line) this.lines.push(...wrap(line, this.width));
  }

  table(
    columns: readonly Column[],
    rows: readonly (readonly Value[])[],
    cardTitle?: string,
  ): void {
    if (!rows.length) return;
    const headers = columns.map((c) => safe(c.label));
    const cells = rows.map((row) => columns.map((_, i) => safe(row[i] ?? "")));
    const widths = headers.map((header, i) => {
      let width = stringWidth(header);
      for (const row of cells)
        width = Math.max(width, stringWidth(row[i] ?? ""));
      return width;
    });
    if (
      !this.plain &&
      widths.reduce((a, b) => a + b, 0) + 3 * (columns.length - 1) <= this.width
    ) {
      const rowText = (row: readonly string[]) =>
        row
          .map((cell, i) => {
            const padding = " ".repeat((widths[i] ?? 0) - stringWidth(cell));
            return columns[i]?.numeric ? padding + cell : cell + padding;
          })
          .join(" | ")
          .trimEnd();
      this.lines.push(rowText(headers));
      this.lines.push(widths.map((width) => "-".repeat(width)).join("-+-"));
      for (const row of cells) this.lines.push(rowText(row));
      return;
    }
    const labelWidth = Math.max(
      ...headers.slice(cardTitle ? 1 : 0).map((label) => stringWidth(label)),
    );
    for (const [index, row] of cells.entries()) {
      if (index) this.lines.push("");
      // Preserve copyable identities even on terminals narrower than a UUID.
      if (cardTitle) this.lines.push(`${safe(cardTitle)} ${row[0] ?? ""}`);
      for (let i = cardTitle ? 1 : 0; i < headers.length; i++) {
        const label = headers[i] ?? "";
        const prefix = `  ${label}${" ".repeat(labelWidth - stringWidth(label))}: `;
        const value = row[i] ?? "";
        if (stringWidth(prefix) >= this.width - 2) {
          this.lines.push(...wrap(`  ${label}:`, this.width));
          this.lines.push(
            ...wrap(value, this.width - 4).map((part) => `    ${part}`),
          );
        } else {
          const parts = wrap(value, this.width - stringWidth(prefix));
          for (const [n, part] of parts.entries())
            this.lines.push(
              `${n ? " ".repeat(stringWidth(prefix)) : prefix}${part}`,
            );
        }
      }
    }
  }
  finish(): string {
    return `${this.lines.join("\n")}\n`;
  }
}
