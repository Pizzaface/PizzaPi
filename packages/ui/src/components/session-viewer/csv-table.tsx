import * as React from "react";
import { ChevronDownIcon, ChevronUpIcon, ChevronsUpDownIcon } from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingFn,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";
import { parseCsv } from "@/components/session-viewer/csv";

type CsvRow = string[];

/** Rows above this get virtualized so a big spreadsheet stays smooth. */
const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 29;

function isNumericValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  // Tolerate thousands separators and currency/percent so a "$1,299.00"
  // column still sorts numerically.
  return /^[-+]?[$€£]?\s?[\d,]*\.?\d+%?$/.test(v);
}

function toNumber(value: string): number {
  const n = Number.parseFloat(value.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

const numericSort: SortingFn<CsvRow> = (a, b, columnId) =>
  toNumber(a.getValue(columnId)) - toNumber(b.getValue(columnId));

/**
 * A CSV/TSV rendered as a sortable spreadsheet via TanStack Table.
 *
 * Click a header to sort (numeric columns sort by value, not text); the header
 * sticks while scrolling, and large tables virtualize their rows.
 */
export function CsvTable({ content, full = false }: { content: string; full?: boolean }) {
  const { header, rows, truncated } = React.useMemo(
    () => parseCsv(content, full ? 100_000 : 50),
    [content, full],
  );
  return <SpreadsheetTable header={header} rows={rows} truncated={truncated} full={full} />;
}

/**
 * The sortable spreadsheet itself, over already-parsed data. Shared by the CSV
 * preview and the XLSX viewer so every tabular format sorts and scrolls the
 * same way.
 */
export function SpreadsheetTable({
  header,
  rows,
  truncated = false,
  full = false,
}: {
  header: string[] | null;
  rows: CsvRow[];
  truncated?: boolean;
  full?: boolean;
}) {
  // Which columns are numeric (every non-empty cell parses as a number).
  const numericColumns = React.useMemo(() => {
    if (!header) return [] as boolean[];
    return header.map((_, c) => {
      let sawNumber = false;
      for (const row of rows) {
        const cell = (row[c] ?? "").trim();
        if (!cell) continue;
        if (!isNumericValue(cell)) return false;
        sawNumber = true;
      }
      return sawNumber;
    });
  }, [header, rows]);

  const columns = React.useMemo<ColumnDef<CsvRow>[]>(() => {
    if (!header) return [];
    return header.map((label, c) => ({
      id: String(c),
      header: label || `Column ${c + 1}`,
      accessorFn: (row) => row[c] ?? "",
      sortingFn: numericColumns[c] ? numericSort : "text",
    }));
  }, [header, numericColumns]);

  const [sorting, setSorting] = React.useState<SortingState>([]);
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const sortedRows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualize = full && sortedRows.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: virtualize,
  });

  if (!header) {
    return <div className="px-3 py-6 text-center text-sm text-muted-foreground">Empty file.</div>;
  }

  const virtualItems = virtualize ? virtualizer.getVirtualItems() : [];
  const paddingTop = virtualize && virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualize && virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;
  const bodyRows = virtualize ? virtualItems.map((vi) => sortedRows[vi.index]!) : sortedRows;

  const renderRows = (tableRows: typeof sortedRows) =>
    tableRows.map((row, i) => (
      <tr key={row.id} className={cn(i % 2 === 1 && "bg-muted/20")}>
        {row.getVisibleCells().map((cell) => {
          const numeric = numericColumns[Number(cell.column.id)];
          return (
            <td
              key={cell.id}
              className={cn(
                "border-b border-border/50 px-2 py-1",
                numeric ? "text-right tabular-nums" : "text-left",
              )}
            >
              {cell.getValue<string>()}
            </td>
          );
        })}
      </tr>
    ));

  const [srOpen, setSrOpen] = React.useState(false);

  return (
    <div className={cn("flex flex-col", full && "h-full")}>
      {virtualize && (
        <details
          className="border-b border-border px-3 py-2 text-xs"
          open={srOpen}
          onToggle={(event) => setSrOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-muted-foreground">
            Screen reader table with {truncated ? "the first" : "all"} {sortedRows.length} rows
          </summary>
          {srOpen && (
            <div className="mt-2 max-h-96 overflow-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((h) => (
                        <th
                          key={h.id}
                          scope="col"
                          className="border-b border-border px-2 py-1 text-left"
                        >
                          {String(h.column.columnDef.header)}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>{renderRows(sortedRows)}</tbody>
              </table>
            </div>
          )}
        </details>
      )}
      <div ref={scrollRef} className={cn("overflow-auto", full ? "flex-1" : "max-h-96")}>
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const numeric = numericColumns[Number(h.column.id)];
                  const sorted = h.column.getIsSorted();
                  const toggleSorting = h.column.getToggleSortingHandler();
                  return (
                    <th
                      key={h.id}
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                      className="border-b border-border p-0 font-medium"
                    >
                      <button
                        type="button"
                        onClick={toggleSorting}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleSorting?.(event);
                          }
                        }}
                        className={cn(
                          "flex w-full select-none items-center gap-1 px-2 py-1.5 hover:bg-muted",
                          numeric ? "flex-row-reverse text-right" : "text-left",
                        )}
                        title="Sort"
                      >
                        <span className="truncate">{String(h.column.columnDef.header)}</span>
                        {sorted === "asc" ? (
                          <ChevronUpIcon className="size-3 shrink-0" />
                        ) : sorted === "desc" ? (
                          <ChevronDownIcon className="size-3 shrink-0" />
                        ) : (
                          <ChevronsUpDownIcon className="size-3 shrink-0 opacity-30" />
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && <tr style={{ height: paddingTop }} aria-hidden />}
            {renderRows(bodyRows)}
            {paddingBottom > 0 && <tr style={{ height: paddingBottom }} aria-hidden />}
          </tbody>
        </table>
      </div>
      {truncated && (
        <div className="border-t border-border px-3 py-1.5 text-center text-[0.65rem] text-muted-foreground">
          Showing the first {sortedRows.length} rows.
        </div>
      )}
    </div>
  );
}
