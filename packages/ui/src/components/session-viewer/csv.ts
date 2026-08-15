/**
 * Minimal RFC4180-ish CSV/TSV reader for artifact previews.
 *
 * Handles the things a naive split breaks on: quoted fields containing the
 * delimiter, escaped quotes (""), and CRLF. It is a preview reader, not a
 * data pipeline.
 *
 * ponytail: single-pass scanner, no streaming — previews are capped at a few
 * dozen rows. Swap in a real CSV library if artifacts ever need full parsing.
 */

export interface ParsedCsv {
  /** Header cells, or null when the input has no rows. */
  header: string[] | null;
  /** Body rows, capped by `maxRows`. */
  rows: string[][];
  /** True when rows were dropped to satisfy the cap. */
  truncated: boolean;
}

/** Delimiter guess: tabs win only when the first line actually has them. */
function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  return firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
}

/** Parse `text`, returning at most `maxRows` body rows. */
export function parseCsv(text: string, maxRows = 50): ParsedCsv {
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // Skip the blank record produced by a trailing newline.
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    sawAnyChar = true;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n") {
      endRecord();
      // Read one row past the cap: that extra row is what proves there was
      // more to show, so `truncated` is honest rather than merely "we stopped".
      if (records.length >= maxRows + 2) break;
    } else if (char !== "\r") {
      field += char;
    }
  }

  // Flush a final record that wasn't newline-terminated.
  if (sawAnyChar && (field !== "" || record.length > 0)) endRecord();

  if (records.length === 0) return { header: null, rows: [], truncated: false };

  const [header, ...body] = records;
  const truncated = body.length > maxRows;
  return { header: header!, rows: truncated ? body.slice(0, maxRows) : body, truncated };
}
