/** One data row for a live chart. */
export type Row = Record<string, string | number | boolean | null>;

const MAX_ROWS = 5000;

/**
 * Parses a metrics file into rows: JSON Lines (`.jsonl`, `.ndjson`: one object per line) or CSV
 * (`.csv`, header row first; double-quoted fields may contain commas). Numeric-looking CSV values
 * become numbers. Malformed lines, including a half-written last line, are skipped. Only the
 * last 5000 rows are kept.
 */
export function parseDataFile(name: string, text: string): Row[] {
  const rows = /\.(jsonl|ndjson)$/i.test(name) ? parseJsonLines(text) : parseCsv(text);
  return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
}

function parseJsonLines(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) rows.push(value as Row);
    } catch {
      // incomplete or malformed line
    }
  }
  return rows;
}

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) continue;
    const row: Row = {};
    header.forEach((key, i) => {
      const cell = cells[i];
      row[key] = cell !== "" && !Number.isNaN(Number(cell)) ? Number(cell) : cell;
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}
