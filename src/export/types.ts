export interface ExportOptions {
  sheetIds: Set<string> | null;
  groupBy: 'item' | 'sheet' | 'floor';
  perSheetColumns: boolean;
  subtotals: boolean;
  detectionLog: boolean; // Excel
  snapshots: boolean;    // Word
  preparedBy: string;
}
