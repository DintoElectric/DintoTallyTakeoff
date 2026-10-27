import type { Zone } from './zones.ts';
import type { AreaRow } from './areas.ts';
export type { Zone } from './zones.ts';
export type { AreaRow, AreaCountRow } from './areas.ts';

export type Role = 'viewer' | 'estimator' | 'admin';
export type SheetKind = 'floor_plan' | 'legend' | 'site_plan' | 'schedule' | 'other';
export type CountStatus = 'not_counted' | 'needs_review' | 'reviewed';
export type DetectionStatus = 'unreviewed' | 'confirmed' | 'rejected';
export type MarkerShape = 'rect' | 'circle' | 'square' | 'diamond';
export type ProjectStatus = 'splitting' | 'counting' | 'in_review' | 'exported';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  limits: { maxFileBytes: number; maxPages: number; chunkBytes: number };
}

export interface ProjectRow {
  id: string;
  name: string;
  location: string | null;
  client: string | null;
  bid_due: string | null;
  status: ProjectStatus;
  review_threshold: number;
  created_by_name: string | null;
  created_at: string;
  sheet_count: number;
  items_counted: number;
  progress: number; // 0..1, reviewed sheets / sheets enabled for counting
}

export interface DrawingFileRow {
  id: string;
  project_id: string;
  file_name: string;
  size_bytes: number;
  page_count: number | null;
  chunk_count: number;
  rev_no: number;
  upload_status: 'uploading' | 'processing' | 'ready' | 'failed';
  error: string | null;
}

export interface SheetRow {
  id: string;
  project_id: string;
  file_id: string;
  page: number;
  number: string | null;
  title: string | null;
  kind: SheetKind;
  floor: string | null;
  scale: string | null;
  page_width_pt: number;
  page_height_pt: number;
  rotation: number;
  count_enabled: boolean;
  count_status: CountStatus;
  read_source: 'text' | 'ocr' | 'manual';
  title_unsure: boolean;
  version: number;
  detection_count: number;
  flagged_count: number;
  exclusion_zones: Zone[] | null; // null = automatic (from the matchlines)
}

export interface ItemTypeRow {
  id: string;
  project_id: string | null; // the project whose library it belongs to (null: from before libraries were per project)
  length_ft: number | null;  // feet per fixture, for linear fixtures; the export totals footage from it
  code: string;
  name: string;
  spec: string | null;
  category_id: string | null;
  unit: string;
  detection_mode: 'auto' | 'manual';
  marker_shape: MarkerShape;
  marker_glyph: string | null;
  sample_count: number;
  detection_count: number;
  /** Fixture (lighting) or device: the counting tab it is in. Empty means decided from its category and name. */
  count_group?: 'fixture' | 'device' | null;
}

export interface CategoryRow { id: string; name: string; sort: number }

export interface Detection {
  id: string;
  sheet_id: string;
  item_type_id: string;
  x: number;
  y: number;
  bbox: { x: number; y: number; w: number; h: number } | null;
  confidence: number | null;
  source: 'auto' | 'manual';
  status: DetectionStatus;
  /** The ceiling it sits in, read from the ceiling plan: drop (grid), sheetrock, or open. Null when not read. */
  ceiling?: 'drop' | 'sheetrock' | 'open' | null;
  created_by_name?: string | null;
  confirmed_by_name?: string | null;
}

export type DetectionOp =
  | { op: 'add'; detection: Omit<Detection, 'sheet_id' | 'created_by_name' | 'confirmed_by_name'> }
  | { op: 'update'; id: string; fields: Partial<Pick<Detection, 'item_type_id' | 'status' | 'x' | 'y' | 'ceiling'>> }
  | { op: 'delete'; id: string };

export interface CountRow { sheet_id: string; item_type_id: string; n: number; flagged: number }

export interface ExportData {
  project: ProjectRow;
  sheets: SheetRow[];
  items: ItemTypeRow[];
  categories: CategoryRow[];
  counts: CountRow[];
  detections: (Detection & { sheet_id: string })[];
  areas?: AreaRow[]; // named count areas (absent on older servers)
  panels?: import('./panels.ts').Panel[]; // panels with their circuits (absent on older servers)
}
