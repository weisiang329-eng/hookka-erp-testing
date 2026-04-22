// Barrel export for src/components/ui — import from "@/components/ui".

// Existing primitives
export { Badge } from "./badge";
export { Button } from "./button";
export { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./card";
export { DataGrid, type Column, type ContextMenuItem, type DataGridProps } from "./data-grid";
export { DataTable } from "./data-table";
export { default as DocumentFlowDiagram, type DocumentFlowDiagramProps } from "./document-flow-diagram";
export { ErrorBoundary, ErrorFallback, WithErrorBoundary } from "./error-boundary";
export { FormField, type FormFieldProps } from "./form-field";
export { Input } from "./input";
export { SearchableSelect, type SearchableOption, type SearchableSelectProps } from "./searchable-select";
export { BatchImportDialog, type ImportColumn, type ImportRow, type BatchImportDialogProps } from "./batch-import-dialog";
export { LoadingButton, type LoadingButtonProps } from "./loading-button";
export {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonTable,
  SkeletonDetailPage,
  SkeletonDashboard,
} from "./skeleton";
export { ToastProvider, useToast } from "./toast";

// New shared components (Phase 3)
export { PageHeader, type PageHeaderProps } from "./page-header";
export { FilterBar, type FilterBarProps, type FilterBarSearchProps } from "./filter-bar";
export { Tabs, type TabItem, type TabsProps } from "./tabs";
export {
  StatusBadge,
  getAnyStatusStyle,
  type StatusBadgeKind,
  type StatusBadgeProps,
} from "./status-badge";
