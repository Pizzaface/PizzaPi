import * as React from "react";
import * as XLSX from "xlsx";

import { cn } from "@/lib/utils";
import { SpreadsheetTable } from "@/components/session-viewer/csv-table";

/**
 * Preview an .xlsx/.xls/.ods workbook inline as a sortable spreadsheet.
 *
 * Parses the base64 bytes with SheetJS into rows and hands them to the shared
 * SpreadsheetTable, so a workbook sorts and scrolls exactly like a CSV. Lazy
 * loaded (see ArtifactCard) so SheetJS never enters the main bundle. `raw:false`
 * keeps the workbook's formatted values (e.g. "$1,299.00"), which the table
 * still sorts numerically.
 */
export default function XlsxPreview({ content, full = false }: { content: string; full?: boolean }) {
  const workbook = React.useMemo(() => {
    try {
      return XLSX.read(content, { type: "base64" });
    } catch {
      return null;
    }
  }, [content]);

  const sheetNames = workbook?.SheetNames ?? [];
  const [active, setActive] = React.useState(0);
  const activeIndex = Math.min(active, Math.max(0, sheetNames.length - 1));
  const activeName = sheetNames[activeIndex];

  const { header, rows } = React.useMemo(() => {
    if (!workbook || !activeName) return { header: null as string[] | null, rows: [] as string[][] };
    const sheet = workbook.Sheets[activeName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });
    if (aoa.length === 0) return { header: null, rows: [] };
    const headerRow = (aoa[0] ?? []).map((c) => (c == null ? "" : String(c)));
    const bodyRows = aoa.slice(1).map((r) => headerRow.map((_, i) => (r[i] == null ? "" : String(r[i]))));
    return { header: headerRow, rows: bodyRows };
  }, [workbook, activeName]);

  if (!workbook) {
    return <div className="px-3 py-6 text-center text-sm text-muted-foreground">Could not read this spreadsheet.</div>;
  }

  return (
    <div className={cn("flex flex-col", full && "h-full min-h-0")}>
      {sheetNames.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2 py-1">
          {sheetNames.map((name, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                "shrink-0 rounded px-2 py-0.5 text-xs transition-colors",
                i === activeIndex ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className={cn(full && "min-h-0 flex-1")}>
        <SpreadsheetTable header={header} rows={rows} full={full} />
      </div>
    </div>
  );
}
