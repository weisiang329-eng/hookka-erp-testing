// ---------------------------------------------------------------------------
// ObjectPageHeader — record detail page header (SAP Object Page pattern,
// Odoo "form view" header, Oracle Fusion record page).
//
// Shape:
//   ┌──────────────────────────────────────────────────────────┐
//   │ ←   <Title>   <Badges...>          <Actions...>          │
//   │     <Subtitle>                                           │
//   └──────────────────────────────────────────────────────────┘
//
// Adoption pattern:
//   <ObjectPageHeader
//     backTo="/sales"
//     title={order.companySOId}
//     subtitle={`${order.customerName} · ${order.customerState}`}
//     badges={<Badge variant="status" status={order.status} />}
//     actions={
//       <>
//         <Button onClick={pdf}>PDF</Button>
//         <Button onClick={edit}>Edit</Button>
//       </>
//     }
//   />
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ObjectPageHeader({
  backTo,
  onBack,
  title,
  subtitle,
  badges,
  actions,
  pager,
}: {
  /** URL the back arrow navigates to. Pass `onBack` instead for custom logic. */
  backTo?: string;
  /** Custom back handler. Wins over `backTo` if both are provided. */
  onBack?: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Status chips, lock indicators, etc. — rendered next to the title. */
  badges?: ReactNode;
  /** Buttons — rendered on the right edge. */
  actions?: ReactNode;
  /** Optional <RecordPager /> rendered between subtitle and actions. */
  pager?: ReactNode;
}) {
  const navigate = useNavigate();
  const handleBack = onBack ?? (backTo ? () => navigate(backTo) : undefined);

  return (
    <div className="flex items-center gap-4">
      {handleBack && (
        <Button variant="ghost" size="icon" onClick={handleBack} aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-bold text-[#1F1D1B] doc-number truncate">{title}</h1>
          {badges}
        </div>
        {subtitle && (
          <p className="text-xs text-[#6B7280] mt-0.5">{subtitle}</p>
        )}
      </div>
      {pager && <div className="flex items-center">{pager}</div>}
      {actions && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {actions}
        </div>
      )}
    </div>
  );
}
