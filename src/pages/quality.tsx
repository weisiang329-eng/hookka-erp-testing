import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatDateDMY } from "@/lib/utils";
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Plus,
  Trash2,
  X,
  ClipboardCheck,
  BarChart3,
  FileText,
  Loader2,
  MessageSquareWarning,
  Bug,
  PackageX,
  TrendingUp,
  Camera,
  RotateCcw,
  Clock,
  Wrench,
  Lightbulb,
  ExternalLink,
  ScanLine,
  Search,
} from "lucide-react";
import type { QCInspection, QCDefect, ProductionOrder } from "@/lib/mock-data";

// ─── Tab type ────────────────────────────────────────────────────────────────
type Tab = "inspections" | "returns" | "defect-tracker" | "supplier-ncr" | "reports";

// ─── Defect type / severity maps ─────────────────────────────────────────────
const DEFECT_TYPE_LABELS: Record<string, string> = {
  FABRIC: "Fabric Defect",
  ALIGNMENT: "Alignment",
  STRUCTURAL: "Structural",
  STAIN: "Stain",
  DIMENSION: "Dimension",
  FINISH: "Finish",
  OTHER: "Other",
};

const SEVERITY_LABELS: Record<string, string> = {
  MINOR: "Minor",
  MAJOR: "Major",
  CRITICAL: "Critical",
};

const RESPONSIBLE_DEPT_LABELS: Record<string, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  FOAM: "Foam",
  WOOD_CUT: "Wood Cutting",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
  LOGISTICS: "Logistics",
  RAW_MATERIAL: "Raw Material",
};

// 8 production departments available for QC inspection
const QC_DEPARTMENTS = ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING", "UPHOLSTERY", "PACKING"] as const;
type QCDepartment = (typeof QC_DEPARTMENTS)[number];

const COMPONENT_TYPE_LABELS: Record<string, string> = {
  HB: "Headboard",
  DIVAN: "Divan",
  BACK_CUSHION: "Back Cushion",
  ARMREST: "Armrest",
  SEAT_CUSHION: "Seat Cushion",
};

const DEPT_CHECKLIST: Record<string, string[]> = {
  FAB_CUT: ["Fabric pattern alignment", "Cut dimensions accuracy", "No fabric defects (tears, stains)", "Correct fabric type/colour per order"],
  FAB_SEW: ["Seam quality and strength", "Stitch consistency", "Thread colour match", "No loose threads", "Piping/trim alignment"],
  FOAM: ["Foam density matches spec", "Correct dimensions", "No deformation or damage", "Proper foam type per BOM"],
  WOOD_CUT: ["Timber dimensions accuracy", "Wood moisture content", "No cracks or knots", "Correct timber grade"],
  FRAMING: ["Frame squareness", "Joint strength", "Correct dimensions", "No structural defects", "Hardware properly installed"],
  WEBBING: ["Webbing tension consistency", "Correct spacing", "Secure stapling", "No sagging"],
  UPHOLSTERY: ["Fabric tension and alignment", "No wrinkles or bubbles", "Pattern matching at seams", "Cushion firmness", "Overall appearance"],
  PACKING: ["Correct product in package", "All parts included", "Hardware bag complete", "Protective wrapping adequate", "Label accuracy"],
};

// ─── Returns & Complaints ────────────────────────────────────────────────────
type IssueType = "PRODUCT_DEFECT" | "WRONG_ITEM" | "DAMAGED_IN_TRANSIT" | "MISSING_PARTS" | "OTHER";
type ActionRequired = "REPLACE_UNIT" | "REWORK" | "FIELD_SERVICE" | "RETURN_REFUND" | "PARTS_ONLY";
type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type ReturnStatus = "OPEN" | "IN_PROGRESS" | "PENDING_PARTS" | "RESOLVED" | "CLOSED";

interface ReturnCase {
  id: string;
  caseNo: string;
  customer: string;
  soRef: string;
  product: string;
  issueType: IssueType;
  description: string;
  actionRequired: ActionRequired;
  priority: Priority;
  assignedTo: string;
  status: ReturnStatus;
  createdDate: string;
  responsibleDept: string;
  needsRework: boolean;
  needsRemake: boolean;
  needsRD: boolean;
  rdProjectId?: string;
  isRawMaterialIssue: boolean;
  problemArea: string;
  /** If the case was created from a scanned FG unit QR, the unit's serial. */
  unitSerial?: string;
}

// ─── Defect Tracker ──────────────────────────────────────────────────────────
type DefectSource = "QC" | "RETURN" | "SUPPLIER";
type DefectTrackerStatus =
  | "IDENTIFIED"
  | "REWORK_IN_PROGRESS"
  | "REWORK_COMPLETE"
  | "SCRAPPED"
  | "RETURNED_TO_SUPPLIER";
type DefectAction = "REWORK" | "SCRAP" | "RETURN_TO_SUPPLIER";

interface DefectEntry {
  id: string;
  defectId: string;
  source: DefectSource;
  product: string;
  defectType: string;
  severity: "MINOR" | "MAJOR" | "CRITICAL";
  status: DefectTrackerStatus;
  assignedTo: string;
  description: string;
  action: DefectAction;
  date: string;
  wipCode?: string;
  reworkDept?: string;
}

// ─── Supplier NCR ─────────────────────────────────────────────────────────────
type NCRIssueType = "WRONG_SPEC" | "DAMAGED" | "SHORT_DELIVERY" | "QUALITY_FAIL";
type NCRStatus = "OPEN" | "INVESTIGATING" | "CLAIM_SUBMITTED" | "RESOLVED" | "CLOSED";

interface SupplierNCR {
  id: string;
  ncrNo: string;
  supplier: string;
  materialCode: string;
  materialName: string;
  issueType: NCRIssueType;
  qtyAffected: number;
  claimAmount: number;
  description: string;
  status: NCRStatus;
  date: string;
}

// ─── ID generators ───────────────────────────────────────────────────────────
function genRCNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `RC-${yymm}-${String(Math.floor(Math.random() * 900) + 100)}`;
}
function genDFTNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `DFT-${yymm}-${String(Math.floor(Math.random() * 900) + 100)}`;
}
function genNCRNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `NCR-${yymm}-${String(Math.floor(Math.random() * 900) + 100)}`;
}

// ─── Sample data ─────────────────────────────────────────────────────────────
const SAMPLE_RETURNS: ReturnCase[] = [
  {
    id: "rc-1", caseNo: "RC-2603-001", customer: "Houzs PG", soRef: "SO-2509-238-01",
    product: "HILTON(A) BEDFRAME Queen", issueType: "PRODUCT_DEFECT",
    description: "Fabric tear on left arm seam noticed upon delivery inspection.",
    actionRequired: "REWORK", priority: "HIGH", assignedTo: "KHIN MAUNG LIN",
    status: "IN_PROGRESS", createdDate: "2026-03-18",
    responsibleDept: "FAB_SEW", needsRework: true, needsRemake: false, needsRD: false,
    isRawMaterialIssue: false, problemArea: "Left arm seam, approximately 15cm from the top edge",
  },
  {
    id: "rc-2", caseNo: "RC-2603-002", customer: "Carress", soRef: "SO-2509-244-01",
    product: "JAGER BEDFRAME Queen", issueType: "WRONG_ITEM",
    description: "Delivered Divan in Caramel but order specified Cream fabric.",
    actionRequired: "REPLACE_UNIT", priority: "URGENT", assignedTo: "AUNG THEIN WIN",
    status: "OPEN", createdDate: "2026-03-20",
    responsibleDept: "FAB_CUT", needsRework: false, needsRemake: true, needsRD: false,
    isRawMaterialIssue: false, problemArea: "Entire Divan unit — wrong fabric colour used",
  },
  {
    id: "rc-3", caseNo: "RC-2603-003", customer: "The Conts", soRef: "SO-2510-012-01",
    product: "OSLO SOFA 3-Seater", issueType: "DAMAGED_IN_TRANSIT",
    description: "Corner foam crushed during transit. Packaging insufficient.",
    actionRequired: "PARTS_ONLY", priority: "MEDIUM", assignedTo: "ZAW WIN",
    status: "PENDING_PARTS", createdDate: "2026-03-22",
    responsibleDept: "PACKING", needsRework: true, needsRemake: false, needsRD: false,
    isRawMaterialIssue: false, problemArea: "Front-left corner foam panel crushed",
  },
  {
    id: "rc-4", caseNo: "RC-2604-004", customer: "Houzs KL", soRef: "SO-2510-019-01",
    product: "BALI DIVAN King", issueType: "MISSING_PARTS",
    description: "Bed legs and hardware bag missing from packaging.",
    actionRequired: "PARTS_ONLY", priority: "MEDIUM", assignedTo: "KHIN MAUNG LIN",
    status: "RESOLVED", createdDate: "2026-04-02",
    responsibleDept: "PACKING", needsRework: false, needsRemake: false, needsRD: false,
    isRawMaterialIssue: false, problemArea: "Hardware bag and 4x bed legs not included in packaging",
  },
  {
    id: "rc-5", caseNo: "RC-2604-005", customer: "Carress", soRef: "SO-2511-005-01",
    product: "HILTON(B) BEDFRAME Super King", issueType: "PRODUCT_DEFECT",
    description: "Structural crack in headboard frame reported after 2 weeks of use.",
    actionRequired: "REPLACE_UNIT", priority: "URGENT", assignedTo: "AUNG THEIN WIN",
    status: "OPEN", createdDate: "2026-04-10",
    responsibleDept: "FRAMING", needsRework: false, needsRemake: true, needsRD: true,
    isRawMaterialIssue: true, problemArea: "Headboard frame — structural crack along left vertical support",
  },
];

const SAMPLE_DEFECTS: DefectEntry[] = [
  {
    id: "dft-1", defectId: "DFT-2603-011", source: "QC", product: "HILTON(A) BEDFRAME Queen",
    defectType: "FABRIC", severity: "MAJOR", status: "REWORK_IN_PROGRESS",
    assignedTo: "KHIN MAUNG LIN", description: "Fabric pilling on seat panel.",
    action: "REWORK", date: "2026-03-14",
  },
  {
    id: "dft-2", defectId: "DFT-2603-012", source: "RETURN", product: "JAGER BEDFRAME Queen",
    defectType: "ALIGNMENT", severity: "CRITICAL", status: "SCRAPPED",
    assignedTo: "ZAW WIN", description: "Headboard frame misaligned beyond repair tolerance.",
    action: "SCRAP", date: "2026-03-21",
  },
  {
    id: "dft-3", defectId: "DFT-2604-013", source: "SUPPLIER", product: "OSLO SOFA 3-Seater",
    defectType: "STRUCTURAL", severity: "CRITICAL", status: "RETURNED_TO_SUPPLIER",
    assignedTo: "AUNG THEIN WIN", description: "Foam density below spec (28kg vs 32kg required).",
    action: "RETURN_TO_SUPPLIER", date: "2026-04-01",
  },
  {
    id: "dft-4", defectId: "DFT-2604-014", source: "QC", product: "BALI DIVAN King",
    defectType: "STAIN", severity: "MINOR", status: "REWORK_COMPLETE",
    assignedTo: "KHIN MAUNG LIN", description: "Oil stain on base fabric, cleaned successfully.",
    action: "REWORK", date: "2026-04-05",
  },
  {
    id: "dft-5", defectId: "DFT-2604-015", source: "QC", product: "HILTON(B) BEDFRAME Super King",
    defectType: "DIMENSION", severity: "MAJOR", status: "IDENTIFIED",
    assignedTo: "ZAW WIN", description: "Divan width 3cm over spec. Requires re-cut.",
    action: "REWORK", date: "2026-04-11",
  },
  {
    id: "dft-6", defectId: "DFT-2604-016", source: "RETURN", product: "OSLO SOFA 2-Seater",
    defectType: "FINISH", severity: "MINOR", status: "REWORK_IN_PROGRESS",
    assignedTo: "KHIN MAUNG LIN", description: "Loose thread on cushion piping.",
    action: "REWORK", date: "2026-04-13",
  },
];

const SAMPLE_NCRS: SupplierNCR[] = [
  {
    id: "ncr-1", ncrNo: "NCR-2603-001", supplier: "Foam Supplies Sdn Bhd",
    materialCode: "FM-32-YLW", materialName: "32kg Yellow Foam Sheet",
    issueType: "QUALITY_FAIL", qtyAffected: 50, claimAmount: 3200,
    description: "Foam density measured at 28kg instead of 32kg. Full batch rejected.",
    status: "CLAIM_SUBMITTED", date: "2026-03-25",
  },
  {
    id: "ncr-2", ncrNo: "NCR-2604-002", supplier: "Fabric World Trading",
    materialCode: "FB-CREAM-54", materialName: "Cream Fabric Roll 54\"",
    issueType: "WRONG_SPEC", qtyAffected: 12, claimAmount: 1800,
    description: "Delivered Ivory shade instead of Cream. Colour mismatch confirmed against sample.",
    status: "OPEN", date: "2026-04-03",
  },
  {
    id: "ncr-3", ncrNo: "NCR-2604-003", supplier: "Timber Frame Supplies",
    materialCode: "WD-PINE-38", materialName: "Pine Timber 38mm",
    issueType: "SHORT_DELIVERY", qtyAffected: 30, claimAmount: 0,
    description: "PO qty was 80 pcs, only 50 pcs delivered. Balance pending.",
    status: "INVESTIGATING", date: "2026-04-08",
  },
  {
    id: "ncr-4", ncrNo: "NCR-2604-004", supplier: "Foam Supplies Sdn Bhd",
    materialCode: "FM-28-WHT", materialName: "28kg White Foam Pillow",
    issueType: "DAMAGED", qtyAffected: 20, claimAmount: 900,
    description: "20 foam pillows arrived with moisture damage — unusable.",
    status: "RESOLVED", date: "2026-04-12",
  },
];

// ─── Empty form helpers ───────────────────────────────────────────────────────
function emptyDefect(): Omit<QCDefect, "id"> {
  return { type: "FABRIC", severity: "MINOR", description: "", actionTaken: "REWORK" };
}

function emptyReturn(): Omit<ReturnCase, "id" | "caseNo" | "createdDate"> {
  return {
    customer: "", soRef: "", product: "", issueType: "PRODUCT_DEFECT",
    description: "", actionRequired: "REWORK", priority: "MEDIUM",
    assignedTo: "", status: "OPEN",
    responsibleDept: "", needsRework: false, needsRemake: false,
    needsRD: false, isRawMaterialIssue: false, problemArea: "",
    unitSerial: undefined,
  };
}

function emptyDefectEntry(): Omit<DefectEntry, "id" | "defectId" | "date"> {
  return {
    source: "QC", product: "", defectType: "FABRIC", severity: "MINOR",
    status: "IDENTIFIED", assignedTo: "", description: "", action: "REWORK",
  };
}

function emptyNCR(): Omit<SupplierNCR, "id" | "ncrNo" | "date"> {
  return {
    supplier: "", materialCode: "", materialName: "", issueType: "QUALITY_FAIL",
    qtyAffected: 0, claimAmount: 0, description: "", status: "OPEN",
  };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
function KpiCard({
  icon,
  iconBg,
  iconColor,
  value,
  label,
  valueColor,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  value: string | number;
  label: string;
  valueColor?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`rounded-lg ${iconBg} p-2.5`}>
          <span className={iconColor}>{icon}</span>
        </div>
        <div>
          <p className={`text-2xl font-bold ${valueColor ?? "text-[#1F1D1B]"}`}>{value}</p>
          <p className="text-xs text-[#6B7280]">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-[#374151] mb-1">{label}</label>
      {children}
    </div>
  );
}

const INPUT_CLS =
  "w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]";

function SimpleBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-[#1F1D1B]">{label}</span>
        <span className="text-sm font-bold text-[#1F1D1B]">{count}</span>
      </div>
      <div className="h-2 rounded-full bg-[#F0ECE9]">
        <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function QualityPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("inspections");

  // ── Inspections state ──────────────────────────────────────────────────────
  const [inspections, setInspections] = useState<QCInspection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInspForm, setShowInspForm] = useState(false);
  const [productionOrders, setProductionOrders] = useState<ProductionOrder[]>([]);
  const [viewInspection, setViewInspection] = useState<QCInspection | null>(null);
  const [formPOId, setFormPOId] = useState("");
  const [formDepartment, setFormDepartment] = useState<QCDepartment>("UPHOLSTERY");
  const [formResult, setFormResult] = useState<"PASS" | "FAIL" | "CONDITIONAL_PASS">("PASS");
  const [formDefects, setFormDefects] = useState<Omit<QCDefect, "id">[]>([]);
  const [formNotes, setFormNotes] = useState("");
  const [formProductType, setFormProductType] = useState<"BEDFRAME" | "SOFA">("BEDFRAME");
  const [formComponentType, setFormComponentType] = useState("");
  const [formChecklist, setFormChecklist] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  // ── Returns state ──────────────────────────────────────────────────────────
  const [returns, setReturns] = useState<ReturnCase[]>(SAMPLE_RETURNS);
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnForm, setReturnForm] = useState(emptyReturn());
  const [viewReturn, setViewReturn] = useState<ReturnCase | null>(null);
  const [creatingRDProject, setCreatingRDProject] = useState(false);

  // Scan-to-create return case
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanSerial, setScanSerial] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");

  // ── Defect Tracker state ───────────────────────────────────────────────────
  const [defects, setDefects] = useState<DefectEntry[]>(SAMPLE_DEFECTS);
  const [showDefectForm, setShowDefectForm] = useState(false);
  const [defectForm, setDefectForm] = useState(emptyDefectEntry());
  const [viewDefect, setViewDefect] = useState<DefectEntry | null>(null);

  // ── Supplier NCR state ─────────────────────────────────────────────────────
  const [ncrs, setNcrs] = useState<SupplierNCR[]>(SAMPLE_NCRS);
  const [showNCRForm, setShowNCRForm] = useState(false);
  const [ncrForm, setNcrForm] = useState(emptyNCR());
  const [viewNCR, setViewNCR] = useState<SupplierNCR | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchInspections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/qc-inspections");
      const json = await res.json();
      if (json.success) setInspections(json.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  const fetchProductionOrders = useCallback(async () => {
    try {
      const res = await fetch("/api/production-orders");
      const json = await res.json();
      if (json.success) {
        setProductionOrders(
          json.data.filter((po: ProductionOrder) =>
            po.status === "IN_PROGRESS" || po.status === "COMPLETED"
          )
        );
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchInspections();
    fetchProductionOrders();
  }, [fetchInspections, fetchProductionOrders]);

  // ── Inspection KPIs ────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const mtd = inspections.filter((i) => i.inspectionDate.startsWith(monthStr));
    const passCount = mtd.filter((i) => i.result === "PASS").length;
    const passRate = mtd.length > 0 ? ((passCount / mtd.length) * 100).toFixed(1) : "0.0";
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split("T")[0];
    const failedThisWeek = inspections.filter(
      (i) => i.result === "FAIL" && i.inspectionDate >= weekAgoStr
    ).length;
    const openDefects = inspections
      .filter((i) => i.result === "FAIL" || i.result === "CONDITIONAL_PASS")
      .reduce((sum, i) => sum + i.defects.length, 0);
    return { passRate, totalMTD: mtd.length, failedThisWeek, openDefects };
  }, [inspections]);

  // ── Inspection form handlers ───────────────────────────────────────────────
  const resetInspForm = () => {
    setFormPOId(""); setFormDepartment("UPHOLSTERY");
    setFormResult("PASS"); setFormDefects([]); setFormNotes("");
    setFormProductType("BEDFRAME"); setFormComponentType(""); setFormChecklist({});
  };

  const handleInspSubmit = async () => {
    if (!formPOId) return;
    setSubmitting(true);
    const selectedPO = productionOrders.find((po) => po.id === formPOId);
    try {
      const res = await fetch("/api/qc-inspections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productionOrderId: formPOId,
          poNo: selectedPO?.poNo || "",
          productCode: selectedPO?.productCode || "",
          productName: selectedPO?.productName || "",
          customerName: selectedPO?.customerName || "",
          department: formDepartment,
          productType: formProductType,
          componentType: formComponentType || undefined,
          checklist: Object.keys(formChecklist).length > 0 ? formChecklist : undefined,
          result: formResult,
          defects: formResult !== "PASS" ? formDefects : [],
          notes: formNotes,
        }),
      });
      const json = await res.json();
      if (json.success) { setShowInspForm(false); resetInspForm(); fetchInspections(); }
    } catch { /* ignore */ }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/qc-inspections/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (json.success) fetchInspections();
    } catch { /* ignore */ }
  };

  // Create rework entry from an inspection's defect
  const handleCreateRework = (inspection: QCInspection) => {
    if (inspection.defects.length === 0) return;
    const firstDefect = inspection.defects[0];
    const entry: DefectEntry = {
      id: `dft-${Date.now()}`,
      defectId: genDFTNo(),
      source: "QC",
      product: inspection.productName,
      defectType: firstDefect.type,
      severity: firstDefect.severity,
      status: "IDENTIFIED",
      assignedTo: inspection.inspectorName,
      description: firstDefect.description || `From inspection ${inspection.inspectionNo}`,
      action: "REWORK",
      date: new Date().toISOString().split("T")[0],
    };
    setDefects((prev) => [entry, ...prev]);
    setTab("defect-tracker");
  };

  // ── Returns handlers ───────────────────────────────────────────────────────
  const handleAddReturn = async () => {
    const newCase: ReturnCase = {
      id: `rc-${Date.now()}`,
      caseNo: genRCNo(),
      ...returnForm,
      createdDate: new Date().toISOString().split("T")[0],
    };
    setReturns((prev) => [newCase, ...prev]);
    setShowReturnForm(false);
    setReturnForm(emptyReturn());

    // If the case is linked to a specific FG unit, mark that unit RETURNED.
    if (newCase.unitSerial) {
      try {
        await fetch("/api/fg-units/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serial: newCase.unitSerial, action: "RETURN" }),
        });
      } catch {
        // Non-fatal — case is still created, unit just not auto-flagged.
      }
    }
  };

  // Lookup a scanned FG unit, prefill the return form, and open it.
  const handleScanLookup = async () => {
    const s = scanSerial.trim();
    if (!s) return;
    setScanLoading(true);
    setScanError("");
    try {
      const res = await fetch(`/api/fg-units?serial=${encodeURIComponent(s)}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.data) && data.data.length > 0) {
        const u = data.data[0];
        setReturnForm({
          ...emptyReturn(),
          customer: u.customerName || "",
          soRef: u.soNo || "",
          product: u.productName || "",
          description: "",
          unitSerial: u.unitSerial,
        });
        setShowScanModal(false);
        setShowReturnForm(true);
        setScanSerial("");
      } else {
        setScanError("Unit not found");
      }
    } catch {
      setScanError("Network error. Please try again.");
    }
    setScanLoading(false);
  };

  const handleCreateRDProject = async (rc: ReturnCase) => {
    setCreatingRDProject(true);
    try {
      const guessCategory = rc.product.toLowerCase().includes("sofa") ? "SOFA"
        : rc.product.toLowerCase().includes("cushion") || rc.product.toLowerCase().includes("accessory") ? "ACCESSORY"
        : "BEDFRAME";
      const res = await fetch("/api/rd-projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `[IMPROVEMENT] ${rc.product} - ${rc.caseNo}`,
          projectType: "IMPROVEMENT",
          productCategory: guessCategory,
          serviceId: rc.caseNo,
          description: `Improvement project created from return case ${rc.caseNo}. Problem: ${rc.description}. Area: ${rc.problemArea}`,
        }),
      });
      if (!res.ok) throw new Error("Failed to create R&D project");
      const json = await res.json();
      const rdProject = json.data;
      setReturns((prev) =>
        prev.map((r) => r.id === rc.id ? { ...r, rdProjectId: rdProject.id } : r)
      );
      if (viewReturn && viewReturn.id === rc.id) {
        setViewReturn({ ...viewReturn, rdProjectId: rdProject.id });
      }
      // Also update returnForm if it's the same case being created
      alert(`R&D Improvement Project created: ${rdProject.code}`);
    } catch {
      alert("Failed to create R&D project");
    } finally {
      setCreatingRDProject(false);
    }
  };

  const returnKpis = useMemo(() => {
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const open = returns.filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS" || r.status === "PENDING_PARTS").length;
    const resolvedMTD = returns.filter((r) =>
      (r.status === "RESOLVED" || r.status === "CLOSED") && r.createdDate.startsWith(monthStr)
    ).length;
    const pending = returns.filter((r) => r.status === "PENDING_PARTS").length;
    return { open, resolvedMTD, avgDays: 4.2, pending };
  }, [returns]);

  // ── Defect Tracker handlers ────────────────────────────────────────────────
  const handleAddDefect = () => {
    const entry: DefectEntry = {
      id: `dft-${Date.now()}`,
      defectId: genDFTNo(),
      ...defectForm,
      date: new Date().toISOString().split("T")[0],
    };
    setDefects((prev) => [entry, ...prev]);
    setShowDefectForm(false);
    setDefectForm(emptyDefectEntry());
  };

  const defectKpis = useMemo(() => {
    const active = defects.filter((d) => d.status === "IDENTIFIED" || d.status === "REWORK_IN_PROGRESS").length;
    const pendingRework = defects.filter((d) => d.status === "REWORK_IN_PROGRESS").length;
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const scrapped = defects.filter((d) => d.status === "SCRAPPED" && d.date.startsWith(monthStr)).length;
    const complete = defects.filter((d) => d.status === "REWORK_COMPLETE").length;
    const attempted = defects.filter((d) => d.action === "REWORK").length;
    const reworkRate = attempted > 0 ? Math.round((complete / attempted) * 100) : 0;
    return { active, pendingRework, scrapped, reworkRate };
  }, [defects]);

  // ── NCR handlers ───────────────────────────────────────────────────────────
  const handleAddNCR = () => {
    const entry: SupplierNCR = {
      id: `ncr-${Date.now()}`,
      ncrNo: genNCRNo(),
      ...ncrForm,
      date: new Date().toISOString().split("T")[0],
    };
    setNcrs((prev) => [entry, ...prev]);
    setShowNCRForm(false);
    setNcrForm(emptyNCR());
  };

  const ncrKpis = useMemo(() => {
    const open = ncrs.filter((n) => n.status === "OPEN" || n.status === "INVESTIGATING").length;
    const resolved = ncrs.filter((n) => n.status === "RESOLVED" || n.status === "CLOSED").length;
    const totalClaims = ncrs.reduce((s, n) => s + n.claimAmount, 0);
    const supplierCounts: Record<string, number> = {};
    ncrs.forEach((n) => { supplierCounts[n.supplier] = (supplierCounts[n.supplier] || 0) + 1; });
    const repeatOffenders = Object.values(supplierCounts).filter((c) => c > 1).length;
    return { open, resolved, totalClaims, repeatOffenders };
  }, [ncrs]);

  // ── Defect analysis (from inspections) ────────────────────────────────────
  const defectAnalysis = useMemo(() => {
    const allDefects = inspections.flatMap((i) => i.defects);
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byDept: Record<string, number> = {};
    const byProduct: Record<string, number> = {};
    for (const d of allDefects) {
      byType[d.type] = (byType[d.type] || 0) + 1;
      bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
    }
    for (const insp of inspections) {
      if (insp.defects.length > 0) {
        byDept[insp.department] = (byDept[insp.department] || 0) + insp.defects.length;
        byProduct[insp.productName] = (byProduct[insp.productName] || 0) + insp.defects.length;
      }
    }
    const returnsByType: Record<string, number> = {};
    returns.forEach((r) => {
      returnsByType[r.issueType] = (returnsByType[r.issueType] || 0) + 1;
    });
    return { byType, bySeverity, byDept, byProduct, returnsByType, total: allDefects.length };
  }, [inspections, returns]);

  // ── Supplier quality score (simple mock) ──────────────────────────────────
  const supplierQuality = useMemo(() => {
    const scoreMap: Record<string, { ncrs: number; score: number }> = {};
    ncrs.forEach((n) => {
      if (!scoreMap[n.supplier]) scoreMap[n.supplier] = { ncrs: 0, score: 100 };
      scoreMap[n.supplier].ncrs += 1;
      scoreMap[n.supplier].score = Math.max(0, 100 - scoreMap[n.supplier].ncrs * 15);
    });
    return Object.entries(scoreMap).map(([supplier, data]) => ({ supplier, ...data }));
  }, [ncrs]);

  // ── QC Pass rate trend (last 7 dates) ─────────────────────────────────────
  const passRateTrend = useMemo(() => {
    const dateMap: Record<string, { pass: number; total: number }> = {};
    inspections.forEach((i) => {
      if (!dateMap[i.inspectionDate]) dateMap[i.inspectionDate] = { pass: 0, total: 0 };
      dateMap[i.inspectionDate].total += 1;
      if (i.result === "PASS") dateMap[i.inspectionDate].pass += 1;
    });
    return Object.entries(dateMap)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7)
      .map(([date, { pass, total }]) => ({
        date,
        rate: total > 0 ? Math.round((pass / total) * 100) : 0,
        total,
      }));
  }, [inspections]);

  // ── Inspections columns ────────────────────────────────────────────────────
  const inspColumns: Column<QCInspection>[] = [
    {
      key: "inspectionNo", label: "Inspection No",
      render: (_v, row) => <span className="font-mono text-xs">{row.inspectionNo}</span>,
    },
    {
      key: "poNo", label: "SO ID",
      render: (_v, row) => <span className="font-mono text-xs">{row.poNo}</span>,
    },
    { key: "productName", label: "Product" },
    {
      key: "department", label: "Department",
      render: (_v, row) => <Badge>{RESPONSIBLE_DEPT_LABELS[row.department] || row.department}</Badge>,
    },
    {
      key: "result", label: "Result",
      render: (_v, row) => <Badge variant="status" status={row.result} />,
    },
    {
      key: "defects", label: "Defects",
      render: (_v, row) => row.defects.length > 0
        ? <span className="text-xs font-medium text-[#9A3A2D]">{row.defects.length}</span>
        : <span className="text-xs text-[#9CA3AF]">0</span>,
    },
    { key: "inspectorName", label: "Inspector" },
    {
      key: "inspectionDate", label: "Date",
      render: (_v, row) => <span>{formatDateDMY(row.inspectionDate)}</span>,
    },
  ];

  const inspContextMenu: ContextMenuItem[] = [
    { label: "View", action: (row: QCInspection) => setViewInspection(row) },
    { label: "Create Rework Entry", action: (row: QCInspection) => handleCreateRework(row) },
    { separator: true, label: "", action: () => {} },
    { label: "Delete", danger: true, action: (row: QCInspection) => handleDelete(row.id) },
    { separator: true, label: "", action: () => {} },
    { label: "Refresh", action: () => fetchInspections() },
  ];

  // ── Returns columns ────────────────────────────────────────────────────────
  const returnColumns: Column<ReturnCase>[] = [
    {
      key: "caseNo", label: "Case No",
      render: (_v, row) => <span className="font-mono text-xs">{row.caseNo}</span>,
    },
    { key: "customer", label: "Customer" },
    { key: "product", label: "Product" },
    {
      key: "issueType", label: "Issue Type",
      render: (_v, row) => (
        <span className="text-xs">{row.issueType.replace(/_/g, " ")}</span>
      ),
    },
    {
      key: "responsibleDept", label: "Dept",
      render: (_v, row) => (
        <span className="text-xs">{RESPONSIBLE_DEPT_LABELS[row.responsibleDept] || row.responsibleDept || "—"}</span>
      ),
    },
    {
      key: "priority", label: "Priority",
      render: (_v, row) => <Badge variant="status" status={row.priority} />,
    },
    {
      key: "status", label: "Status",
      render: (_v, row) => <Badge variant="status" status={row.status} />,
    },
    { key: "assignedTo", label: "Assigned To" },
    {
      key: "unitSerial" as keyof ReturnCase, label: "Unit",
      render: (_v, row) => row.unitSerial
        ? <span className="inline-flex items-center rounded-full bg-[#F0ECE9] text-[#6B5C32] border border-[#E2DDD8] px-1.5 py-0.5 text-[10px] font-mono">{row.unitSerial}</span>
        : <span className="text-xs text-[#9CA3AF]">—</span>,
    },
    {
      key: "rdProjectId" as keyof ReturnCase, label: "R&D",
      render: (_v, row) => row.rdProjectId
        ? <span className="inline-flex items-center rounded-full bg-[#E0EDF0] text-[#3E6570] border border-[#A8CAD2] px-1.5 py-0.5 text-[10px] font-medium"><Lightbulb className="h-3 w-3 mr-0.5" />R&D</span>
        : <span className="text-xs text-[#9CA3AF]">—</span>,
    },
    {
      key: "createdDate", label: "Created",
      render: (_v, row) => <span>{formatDateDMY(row.createdDate)}</span>,
    },
  ];

  const returnContextMenu: ContextMenuItem[] = [
    { label: "View", action: (row: ReturnCase) => setViewReturn(row) },
    { separator: true, label: "", action: () => {} },
    { label: "Delete", danger: true, action: (row: ReturnCase) => setReturns((p) => p.filter((r) => r.id !== row.id)) },
  ];

  // ── Defect tracker columns ─────────────────────────────────────────────────
  const defectColumns: Column<DefectEntry>[] = [
    {
      key: "defectId", label: "Defect ID",
      render: (_v, row) => <span className="font-mono text-xs">{row.defectId}</span>,
    },
    {
      key: "source", label: "Source",
      render: (_v, row) => <Badge>{row.source}</Badge>,
    },
    { key: "product", label: "Product" },
    {
      key: "defectType", label: "Defect Type",
      render: (_v, row) => <span className="text-xs">{DEFECT_TYPE_LABELS[row.defectType] || row.defectType}</span>,
    },
    {
      key: "severity", label: "Severity",
      render: (_v, row) => <Badge variant="status" status={row.severity} />,
    },
    {
      key: "status", label: "Status",
      render: (_v, row) => (
        <span className="text-xs font-medium">{row.status.replace(/_/g, " ")}</span>
      ),
    },
    { key: "assignedTo", label: "Assigned To" },
    {
      key: "date", label: "Date",
      render: (_v, row) => <span>{formatDateDMY(row.date)}</span>,
    },
  ];

  const defectContextMenu: ContextMenuItem[] = [
    { label: "View", action: (row: DefectEntry) => setViewDefect(row) },
    { separator: true, label: "", action: () => {} },
    { label: "Delete", danger: true, action: (row: DefectEntry) => setDefects((p) => p.filter((d) => d.id !== row.id)) },
  ];

  // ── NCR columns ────────────────────────────────────────────────────────────
  const ncrColumns: Column<SupplierNCR>[] = [
    {
      key: "ncrNo", label: "NCR No",
      render: (_v, row) => <span className="font-mono text-xs">{row.ncrNo}</span>,
    },
    { key: "supplier", label: "Supplier" },
    { key: "materialCode", label: "Material Code" },
    {
      key: "issueType", label: "Issue Type",
      render: (_v, row) => <span className="text-xs">{row.issueType.replace(/_/g, " ")}</span>,
    },
    {
      key: "qtyAffected", label: "Qty Affected",
      render: (_v, row) => <span className="text-xs font-medium">{row.qtyAffected}</span>,
    },
    {
      key: "claimAmount", label: "Claim (RM)",
      render: (_v, row) => (
        <span className={`text-xs font-medium ${row.claimAmount > 0 ? "text-[#9A3A2D]" : "text-[#9CA3AF]"}`}>
          {row.claimAmount > 0 ? `RM ${row.claimAmount.toLocaleString()}` : "—"}
        </span>
      ),
    },
    {
      key: "status", label: "Status",
      render: (_v, row) => <Badge variant="status" status={row.status} />,
    },
    {
      key: "date", label: "Date",
      render: (_v, row) => <span>{formatDateDMY(row.date)}</span>,
    },
  ];

  const ncrContextMenu: ContextMenuItem[] = [
    { label: "View", action: (row: SupplierNCR) => setViewNCR(row) },
    { separator: true, label: "", action: () => {} },
    { label: "Delete", danger: true, action: (row: SupplierNCR) => setNcrs((p) => p.filter((n) => n.id !== row.id)) },
  ];

  // ── Tab config ─────────────────────────────────────────────────────────────
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "inspections", label: "QC Inspections", icon: <ClipboardCheck className="h-4 w-4" /> },
    { id: "returns", label: "Returns & Complaints", icon: <MessageSquareWarning className="h-4 w-4" /> },
    { id: "defect-tracker", label: "Defect Tracker", icon: <Bug className="h-4 w-4" /> },
    { id: "supplier-ncr", label: "Supplier NCR", icon: <PackageX className="h-4 w-4" /> },
    { id: "reports", label: "Reports", icon: <BarChart3 className="h-4 w-4" /> },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">QA / Quality Management</h1>
          <p className="text-xs text-[#6B7280]">QC inspections, returns, defect tracking, and supplier quality</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === "inspections" && (
            <Button variant="primary" onClick={() => { setShowInspForm(!showInspForm); if (showInspForm) resetInspForm(); }}>
              {showInspForm ? <><X className="h-4 w-4" /> Cancel</> : <><Plus className="h-4 w-4" /> New Inspection</>}
            </Button>
          )}
          {tab === "returns" && (
            <>
              <Button variant="outline" onClick={() => { setScanSerial(""); setScanError(""); setShowScanModal(true); }}>
                <ScanLine className="h-4 w-4" /> Scan QR to create case
              </Button>
              <Button variant="primary" onClick={() => { setShowReturnForm(!showReturnForm); if (showReturnForm) setReturnForm(emptyReturn()); }}>
                {showReturnForm ? <><X className="h-4 w-4" /> Cancel</> : <><Plus className="h-4 w-4" /> New Case</>}
              </Button>
            </>
          )}
          {tab === "defect-tracker" && (
            <Button variant="primary" onClick={() => { setShowDefectForm(!showDefectForm); if (showDefectForm) setDefectForm(emptyDefectEntry()); }}>
              {showDefectForm ? <><X className="h-4 w-4" /> Cancel</> : <><Plus className="h-4 w-4" /> Log Defect</>}
            </Button>
          )}
          {tab === "supplier-ncr" && (
            <Button variant="primary" onClick={() => { setShowNCRForm(!showNCRForm); if (showNCRForm) setNcrForm(emptyNCR()); }}>
              {showNCRForm ? <><X className="h-4 w-4" /> Cancel</> : <><Plus className="h-4 w-4" /> New NCR</>}
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8] overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === t.id
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:text-[#1F1D1B] hover:border-[#E2DDD8]"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading spinner (only for inspections tab which fetches from API) */}
      {loading && tab === "inspections" && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
          <span className="ml-2 text-sm text-[#6B7280]">Loading...</span>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TAB 1: QC Inspections                                              */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {!loading && tab === "inspections" && (
        <>
          {/* KPI Cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <KpiCard icon={<CheckCircle2 className="h-5 w-5" />} iconBg="bg-[#EEF3E4]" iconColor="text-[#4F7C3A]" value={`${kpis.passRate}%`} label="Pass Rate (MTD)" valueColor="text-[#4F7C3A]" />
            <KpiCard icon={<ShieldCheck className="h-5 w-5" />} iconBg="bg-[#E0EDF0]" iconColor="text-[#3E6570]" value={kpis.totalMTD} label="Inspections (MTD)" />
            <KpiCard icon={<XCircle className="h-5 w-5" />} iconBg="bg-[#F9E1DA]" iconColor="text-[#9A3A2D]" value={kpis.failedThisWeek} label="Failed This Week" valueColor="text-[#9A3A2D]" />
            <KpiCard icon={<AlertTriangle className="h-5 w-5" />} iconBg="bg-[#FAEFCB]" iconColor="text-[#9C6F1E]" value={kpis.openDefects} label="Open Defects" valueColor="text-[#9C6F1E]" />
          </div>

          {/* New Inspection Form */}
          {showInspForm && (
            <Card>
              <CardHeader className="pb-3"><CardTitle>New QC Inspection</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <FormField label="Production Order">
                  <select value={formPOId} onChange={(e) => setFormPOId(e.target.value)} className={INPUT_CLS}>
                    <option value="">Select a production order...</option>
                    {productionOrders.map((po) => (
                      <option key={po.id} value={po.id}>{po.poNo} - {po.productName} ({po.customerName})</option>
                    ))}
                  </select>
                </FormField>

                <FormField label="Department">
                  <select value={formDepartment} onChange={(e) => { setFormDepartment(e.target.value as QCDepartment); setFormChecklist({}); }} className={INPUT_CLS}>
                    {QC_DEPARTMENTS.map((dept) => (
                      <option key={dept} value={dept}>{RESPONSIBLE_DEPT_LABELS[dept]}</option>
                    ))}
                  </select>
                </FormField>

                <FormField label="Product Type">
                  <div className="flex gap-4">
                    {(["BEDFRAME", "SOFA"] as const).map((pt) => (
                      <label key={pt} className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="productType" value={pt} checked={formProductType === pt} onChange={() => { setFormProductType(pt); setFormComponentType(""); }} className="accent-[#6B5C32]" />
                        <span className="text-sm">{pt === "BEDFRAME" ? "Bedframe" : "Sofa"}</span>
                      </label>
                    ))}
                  </div>
                </FormField>

                <FormField label="Component Type">
                  <select value={formComponentType} onChange={(e) => setFormComponentType(e.target.value)} className={INPUT_CLS}>
                    <option value="">Select component...</option>
                    {formProductType === "BEDFRAME"
                      ? [["HB", "Headboard"], ["DIVAN", "Divan"]].map(([k, v]) => <option key={k} value={k}>{v}</option>)
                      : [["BACK_CUSHION", "Back Cushion"], ["ARMREST", "Armrest"], ["SEAT_CUSHION", "Seat Cushion"]].map(([k, v]) => <option key={k} value={k}>{v}</option>)
                    }
                  </select>
                </FormField>

                {/* Department QC Checklist */}
                {DEPT_CHECKLIST[formDepartment] && (
                  <FormField label="QC Checklist">
                    <div className="space-y-2 rounded-lg border border-[#E2DDD8] p-3 bg-[#FAF9F7]">
                      {DEPT_CHECKLIST[formDepartment].map((item) => (
                        <label key={item} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formChecklist[item] || false}
                            onChange={(e) => setFormChecklist((prev) => ({ ...prev, [item]: e.target.checked }))}
                            className="accent-[#6B5C32] h-4 w-4"
                          />
                          <span className="text-sm">{item}</span>
                        </label>
                      ))}
                    </div>
                  </FormField>
                )}

                <FormField label="Result">
                  <div className="flex gap-4">
                    {([
                      { value: "PASS" as const, label: "Pass", color: "text-[#4F7C3A]" },
                      { value: "FAIL" as const, label: "Fail", color: "text-[#9A3A2D]" },
                      { value: "CONDITIONAL_PASS" as const, label: "Conditional Pass", color: "text-[#9C6F1E]" },
                    ]).map((opt) => (
                      <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="result" value={opt.value} checked={formResult === opt.value} onChange={() => setFormResult(opt.value)} className="accent-[#6B5C32]" />
                        <span className={`text-sm font-medium ${opt.color}`}>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </FormField>

                {/* Photo upload placeholder */}
                <FormField label="Photos">
                  <button className="flex items-center gap-2 rounded-md border border-dashed border-[#E2DDD8] px-4 py-2.5 text-sm text-[#6B7280] hover:border-[#6B5C32] hover:text-[#6B5C32] transition-colors">
                    <Camera className="h-4 w-4" />
                    <span>Attach Photos (placeholder)</span>
                  </button>
                </FormField>

                {/* Defects section */}
                {formResult !== "PASS" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="block text-sm font-medium text-[#374151]">Defects</label>
                      <Button variant="outline" size="sm" onClick={() => setFormDefects([...formDefects, emptyDefect()])}>
                        <Plus className="h-3 w-3" /> Add Defect
                      </Button>
                    </div>
                    {formDefects.map((defect, idx) => (
                      <div key={idx} className="rounded-lg border border-[#E2DDD8] p-3 space-y-2 bg-[#FAF9F7]">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-[#6B7280]">Defect #{idx + 1}</span>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-[#9A3A2D]" onClick={() => setFormDefects(formDefects.filter((_, i) => i !== idx))}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <select value={defect.type} onChange={(e) => { const u = [...formDefects]; u[idx] = { ...u[idx], type: e.target.value as QCDefect["type"] }; setFormDefects(u); }} className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
                            {Object.entries(DEFECT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                          <select value={defect.severity} onChange={(e) => { const u = [...formDefects]; u[idx] = { ...u[idx], severity: e.target.value as QCDefect["severity"] }; setFormDefects(u); }} className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
                            <option value="MINOR">Minor</option>
                            <option value="MAJOR">Major</option>
                            <option value="CRITICAL">Critical</option>
                          </select>
                          <select value={defect.actionTaken} onChange={(e) => { const u = [...formDefects]; u[idx] = { ...u[idx], actionTaken: e.target.value as QCDefect["actionTaken"] }; setFormDefects(u); }} className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
                            <option value="REWORK">Rework</option>
                            <option value="ACCEPT">Accept</option>
                            <option value="REJECT">Reject</option>
                            <option value="REPAIR">Repair</option>
                          </select>
                        </div>
                        <input type="text" placeholder="Defect description..." value={defect.description} onChange={(e) => { const u = [...formDefects]; u[idx] = { ...u[idx], description: e.target.value }; setFormDefects(u); }} className="w-full rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
                      </div>
                    ))}
                    {formDefects.length === 0 && (
                      <p className="text-xs text-[#9CA3AF] italic">No defects added yet. Click &quot;Add Defect&quot; to record issues.</p>
                    )}
                  </div>
                )}

                <FormField label="Notes">
                  <textarea rows={3} value={formNotes} onChange={(e) => setFormNotes(e.target.value)} placeholder="Additional inspection notes..." className={INPUT_CLS} />
                </FormField>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setShowInspForm(false); resetInspForm(); }}>Cancel</Button>
                  <Button variant="primary" onClick={handleInspSubmit} disabled={!formPOId || submitting}>
                    {submitting ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving...</> : "Save Inspection"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* View Modal */}
          {viewInspection && (
            <Card className="border-[#6B5C32]">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle>Inspection Detail: {viewInspection.inspectionNo}</CardTitle>
                  <div className="flex items-center gap-2">
                    {viewInspection.defects.length > 0 && (
                      <Button variant="outline" size="sm" onClick={() => { handleCreateRework(viewInspection); setViewInspection(null); }}>
                        <RotateCcw className="h-3 w-3" /> Create Rework Entry
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewInspection(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div><span className="text-[#6B7280]">SO ID:</span> <span className="font-mono">{viewInspection.poNo}</span></div>
                  <div><span className="text-[#6B7280]">Product:</span> {viewInspection.productName}</div>
                  <div><span className="text-[#6B7280]">Customer:</span> {viewInspection.customerName}</div>
                  <div><span className="text-[#6B7280]">Department:</span> {RESPONSIBLE_DEPT_LABELS[viewInspection.department] || viewInspection.department}</div>
                  <div><span className="text-[#6B7280]">Result:</span> <Badge variant="status" status={viewInspection.result} /></div>
                  <div><span className="text-[#6B7280]">Inspector:</span> {viewInspection.inspectorName}</div>
                  <div><span className="text-[#6B7280]">Date:</span> {viewInspection.inspectionDate}</div>
                  {(viewInspection as any).productType && (
                    <div><span className="text-[#6B7280]">Product Type:</span> {(viewInspection as any).productType === "BEDFRAME" ? "Bedframe" : "Sofa"}</div>
                  )}
                  {(viewInspection as any).componentType && (
                    <div><span className="text-[#6B7280]">Component:</span> {COMPONENT_TYPE_LABELS[(viewInspection as any).componentType] || (viewInspection as any).componentType}</div>
                  )}
                </div>
                {(viewInspection as any).checklist && Object.keys((viewInspection as any).checklist).length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-[#374151] mb-2">QC Checklist</p>
                    <div className="space-y-1">
                      {Object.entries((viewInspection as any).checklist as Record<string, boolean>).map(([item, checked]) => (
                        <div key={item} className="flex items-center gap-2 text-sm">
                          {checked
                            ? <CheckCircle2 className="h-3.5 w-3.5 text-[#4F7C3A]" />
                            : <XCircle className="h-3.5 w-3.5 text-[#9A3A2D]" />}
                          <span className={checked ? "text-[#1F1D1B]" : "text-[#9A3A2D]"}>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {viewInspection.notes && (
                  <div className="text-sm"><span className="text-[#6B7280]">Notes:</span> {viewInspection.notes}</div>
                )}
                {viewInspection.defects.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-[#374151] mb-2">Defects ({viewInspection.defects.length})</p>
                    <div className="space-y-2">
                      {viewInspection.defects.map((d) => (
                        <div key={d.id} className="flex items-center gap-3 rounded-lg border border-[#E2DDD8] p-2 text-sm">
                          <Badge variant="status" status={d.severity}>{d.severity}</Badge>
                          <span className="font-medium">{DEFECT_TYPE_LABELS[d.type] || d.type}</span>
                          <span className="text-[#6B7280] flex-1">{d.description}</span>
                          <Badge>{d.actionTaken}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Inspections Table */}
          <Card>
            <CardHeader className="pb-3"><CardTitle>All Inspections</CardTitle></CardHeader>
            <CardContent>
              <DataGrid
                columns={inspColumns}
                data={inspections}
                keyField="id"
                gridId="quality-inspections"
                contextMenuItems={inspContextMenu}
                onDoubleClick={(row) => setViewInspection(row)}
                emptyMessage="No inspections found."
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TAB 2: Returns & Complaints                                         */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === "returns" && (
        <>
          {/* Scan-to-create modal */}
          {showScanModal && (
            <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowScanModal(false)}>
              <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-[#E2DDD8]">
                  <div className="flex items-center gap-2">
                    <ScanLine className="h-5 w-5 text-[#6B5C32]" />
                    <h3 className="font-semibold text-[#1F1D1B]">Scan FG Unit</h3>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowScanModal(false)}><X className="h-4 w-4" /></Button>
                </div>
                <div className="p-4 space-y-3">
                  <FormField label="Unit Serial / Short code">
                    <input
                      autoFocus
                      type="text"
                      value={scanSerial}
                      onChange={(e) => setScanSerial(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !scanLoading) handleScanLookup(); }}
                      placeholder="Scan or type serial..."
                      className={INPUT_CLS + " font-mono"}
                    />
                  </FormField>
                  {scanError && (
                    <div className="rounded-md border border-[#E8B2A1] bg-[#F9E1DA] text-sm text-[#9A3A2D] px-3 py-2">{scanError}</div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setShowScanModal(false)}>Cancel</Button>
                    <Button variant="primary" onClick={handleScanLookup} disabled={!scanSerial.trim() || scanLoading}>
                      {scanLoading ? "Looking up..." : (<><Search className="h-4 w-4" /> Lookup</>)}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* KPI Cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <KpiCard icon={<MessageSquareWarning className="h-5 w-5" />} iconBg="bg-[#F9E1DA]" iconColor="text-[#9A3A2D]" value={returnKpis.open} label="Open Cases" valueColor="text-[#9A3A2D]" />
            <KpiCard icon={<CheckCircle2 className="h-5 w-5" />} iconBg="bg-[#EEF3E4]" iconColor="text-[#4F7C3A]" value={returnKpis.resolvedMTD} label="Resolved This Month" valueColor="text-[#4F7C3A]" />
            <KpiCard icon={<Clock className="h-5 w-5" />} iconBg="bg-[#E0EDF0]" iconColor="text-[#3E6570]" value={`${returnKpis.avgDays}d`} label="Avg Resolution Days" />
            <KpiCard icon={<AlertTriangle className="h-5 w-5" />} iconBg="bg-[#FAEFCB]" iconColor="text-[#9C6F1E]" value={returnKpis.pending} label="Pending Action" valueColor="text-[#9C6F1E]" />
          </div>

          {/* New Return/Complaint Form */}
          {showReturnForm && (
            <Card>
              <CardHeader className="pb-3"><CardTitle>New Return / Complaint Case</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Customer">
                    <input type="text" value={returnForm.customer} onChange={(e) => setReturnForm({ ...returnForm, customer: e.target.value })} placeholder="Customer name..." className={INPUT_CLS} />
                  </FormField>
                  <FormField label="SO Reference">
                    <input type="text" value={returnForm.soRef} onChange={(e) => setReturnForm({ ...returnForm, soRef: e.target.value })} placeholder="SO-YYMM-XXX" className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Product">
                    <input type="text" value={returnForm.product} onChange={(e) => setReturnForm({ ...returnForm, product: e.target.value })} placeholder="Product name..." className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Issue Type">
                    <select value={returnForm.issueType} onChange={(e) => setReturnForm({ ...returnForm, issueType: e.target.value as IssueType })} className={INPUT_CLS}>
                      <option value="PRODUCT_DEFECT">Product Defect</option>
                      <option value="WRONG_ITEM">Wrong Item</option>
                      <option value="DAMAGED_IN_TRANSIT">Damaged in Transit</option>
                      <option value="MISSING_PARTS">Missing Parts</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </FormField>
                  <FormField label="Action Required">
                    <select value={returnForm.actionRequired} onChange={(e) => setReturnForm({ ...returnForm, actionRequired: e.target.value as ActionRequired })} className={INPUT_CLS}>
                      <option value="REPLACE_UNIT">Replace Unit</option>
                      <option value="REWORK">Rework</option>
                      <option value="FIELD_SERVICE">Field Service</option>
                      <option value="RETURN_REFUND">Return / Refund</option>
                      <option value="PARTS_ONLY">Parts Only</option>
                    </select>
                  </FormField>
                  <FormField label="Priority">
                    <select value={returnForm.priority} onChange={(e) => setReturnForm({ ...returnForm, priority: e.target.value as Priority })} className={INPUT_CLS}>
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                      <option value="URGENT">Urgent</option>
                    </select>
                  </FormField>
                  <FormField label="Assigned To">
                    <input type="text" value={returnForm.assignedTo} onChange={(e) => setReturnForm({ ...returnForm, assignedTo: e.target.value })} placeholder="Staff name..." className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Status">
                    <select value={returnForm.status} onChange={(e) => setReturnForm({ ...returnForm, status: e.target.value as ReturnStatus })} className={INPUT_CLS}>
                      <option value="OPEN">Open</option>
                      <option value="IN_PROGRESS">In Progress</option>
                      <option value="PENDING_PARTS">Pending Parts</option>
                      <option value="RESOLVED">Resolved</option>
                      <option value="CLOSED">Closed</option>
                    </select>
                  </FormField>
                </div>
                <FormField label="Description">
                  <textarea rows={3} value={returnForm.description} onChange={(e) => setReturnForm({ ...returnForm, description: e.target.value })} placeholder="Describe the issue in detail..." className={INPUT_CLS} />
                </FormField>

                {/* Responsible Department */}
                <FormField label="Responsible Department">
                  <select value={returnForm.responsibleDept} onChange={(e) => setReturnForm({ ...returnForm, responsibleDept: e.target.value })} className={INPUT_CLS}>
                    <option value="">Select department...</option>
                    {Object.entries(RESPONSIBLE_DEPT_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </FormField>

                {/* Problem Area */}
                <FormField label="Problem Area">
                  <textarea rows={2} value={returnForm.problemArea} onChange={(e) => setReturnForm({ ...returnForm, problemArea: e.target.value })} placeholder="Describe exactly where the problem is..." className={INPUT_CLS} />
                </FormField>

                {/* Action Checkboxes */}
                <div>
                  <label className="block text-sm font-medium text-[#374151] mb-2">Actions</label>
                  <div className="flex flex-wrap gap-6">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={returnForm.needsRework} onChange={(e) => setReturnForm({ ...returnForm, needsRework: e.target.checked })} className="accent-[#6B5C32] h-4 w-4" />
                      <span className="text-sm">Needs Rework</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={returnForm.needsRemake} onChange={(e) => setReturnForm({ ...returnForm, needsRemake: e.target.checked })} className="accent-[#6B5C32] h-4 w-4" />
                      <span className="text-sm">Needs Remake</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={returnForm.isRawMaterialIssue} onChange={(e) => setReturnForm({ ...returnForm, isRawMaterialIssue: e.target.checked })} className="accent-[#6B5C32] h-4 w-4" />
                      <span className="text-sm">Raw Material Issue</span>
                    </label>
                  </div>
                </div>

                {/* R&D Required */}
                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={returnForm.needsRD} onChange={(e) => setReturnForm({ ...returnForm, needsRD: e.target.checked })} className="accent-[#6B5C32] h-4 w-4" />
                    <span className="text-sm font-medium text-[#374151]">Escalate to R&D for improvement</span>
                  </label>
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setShowReturnForm(false); setReturnForm(emptyReturn()); }}>Cancel</Button>
                  <Button variant="primary" onClick={handleAddReturn} disabled={!returnForm.customer || !returnForm.product}>Save Case</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* View Return Modal */}
          {viewReturn && (
            <Card className="border-[#6B5C32]">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle>Case Detail: {viewReturn.caseNo}</CardTitle>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewReturn(null)}><X className="h-4 w-4" /></Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                  <div><span className="text-[#6B7280]">Customer:</span> {viewReturn.customer}</div>
                  <div><span className="text-[#6B7280]">SO Ref:</span> <span className="font-mono">{viewReturn.soRef}</span></div>
                  <div><span className="text-[#6B7280]">Product:</span> {viewReturn.product}</div>
                  <div><span className="text-[#6B7280]">Issue:</span> {viewReturn.issueType.replace(/_/g, " ")}</div>
                  <div><span className="text-[#6B7280]">Action:</span> {viewReturn.actionRequired.replace(/_/g, " ")}</div>
                  <div><span className="text-[#6B7280]">Priority:</span> <Badge variant="status" status={viewReturn.priority} /></div>
                  <div><span className="text-[#6B7280]">Status:</span> <Badge variant="status" status={viewReturn.status} /></div>
                  <div><span className="text-[#6B7280]">Assigned To:</span> {viewReturn.assignedTo}</div>
                  <div><span className="text-[#6B7280]">Created:</span> {formatDateDMY(viewReturn.createdDate)}</div>
                  <div><span className="text-[#6B7280]">Responsible Dept:</span> {RESPONSIBLE_DEPT_LABELS[viewReturn.responsibleDept] || viewReturn.responsibleDept || "—"}</div>
                </div>
                {viewReturn.description && (
                  <div className="text-sm"><span className="text-[#6B7280]">Description:</span> <span className="ml-1">{viewReturn.description}</span></div>
                )}
                {viewReturn.problemArea && (
                  <div className="text-sm"><span className="text-[#6B7280]">Problem Area:</span> <span className="ml-1">{viewReturn.problemArea}</span></div>
                )}

                {/* Action Flags */}
                <div className="flex flex-wrap gap-3">
                  {viewReturn.needsRework && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#FAEFCB] text-[#9C6F1E] border border-[#E8D597] px-2.5 py-0.5 text-xs font-medium"><Wrench className="h-3 w-3" /> Rework</span>
                  )}
                  {viewReturn.needsRemake && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#F9E1DA] text-[#9A3A2D] border border-[#E8B2A1] px-2.5 py-0.5 text-xs font-medium"><RotateCcw className="h-3 w-3" /> Remake</span>
                  )}
                  {viewReturn.isRawMaterialIssue && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#F1E6F0] text-[#6B4A6D] border border-[#D1B7D0] px-2.5 py-0.5 text-xs font-medium"><PackageX className="h-3 w-3" /> Raw Material Issue</span>
                  )}
                  {viewReturn.needsRD && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#E0EDF0] text-[#3E6570] border border-[#A8CAD2] px-2.5 py-0.5 text-xs font-medium"><Lightbulb className="h-3 w-3" /> R&D Escalation</span>
                  )}
                </div>

                {/* Linked FG Unit */}
                {viewReturn.unitSerial && (
                  <div className="border-t border-[#E2DDD8] pt-3 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-[#6B7280]">Linked Unit:</span>
                    <span className="inline-flex items-center rounded-full bg-[#F0ECE9] text-[#6B5C32] border border-[#E2DDD8] px-2 py-0.5 text-xs font-mono">{viewReturn.unitSerial}</span>
                    <a
                      href={`/track?s=${encodeURIComponent(viewReturn.unitSerial)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium text-[#6B5C32] hover:underline"
                    >
                      View unit history <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}

                {/* R&D Project Link / Create Button */}
                {viewReturn.needsRD && (
                  <div className="border-t border-[#E2DDD8] pt-3">
                    {viewReturn.rdProjectId ? (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-[#6B7280]">Linked R&D Project:</span>
                        <button
                          onClick={() => navigate(`/rd/${viewReturn.rdProjectId}`)}
                          className="inline-flex items-center gap-1 text-sm font-medium text-[#6B5C32] hover:text-[#5a4d2a] hover:underline"
                        >
                          <Lightbulb className="h-3.5 w-3.5" />
                          View R&D Project
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCreateRDProject(viewReturn)}
                        disabled={creatingRDProject}
                        className="gap-1.5"
                      >
                        <Lightbulb className="h-3.5 w-3.5" />
                        {creatingRDProject ? "Creating..." : "Create R&D Improvement Project"}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Returns Table */}
          <Card>
            <CardHeader className="pb-3"><CardTitle>All Return Cases</CardTitle></CardHeader>
            <CardContent>
              <DataGrid
                columns={returnColumns}
                data={returns}
                keyField="id"
                gridId="quality-returns"
                contextMenuItems={returnContextMenu}
                onDoubleClick={(row) => setViewReturn(row)}
                emptyMessage="No return cases found."
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TAB 3: Defect Tracker                                               */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === "defect-tracker" && (
        <>
          {/* KPI Cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <KpiCard icon={<Bug className="h-5 w-5" />} iconBg="bg-[#F9E1DA]" iconColor="text-[#9A3A2D]" value={defectKpis.active} label="Active Defects" valueColor="text-[#9A3A2D]" />
            <KpiCard icon={<Wrench className="h-5 w-5" />} iconBg="bg-[#FAEFCB]" iconColor="text-[#9C6F1E]" value={defectKpis.pendingRework} label="Pending Rework" valueColor="text-[#9C6F1E]" />
            <KpiCard icon={<Trash2 className="h-5 w-5" />} iconBg="bg-[#F0ECE9]" iconColor="text-[#6B5C32]" value={defectKpis.scrapped} label="Scrapped This Month" />
            <KpiCard icon={<TrendingUp className="h-5 w-5" />} iconBg="bg-[#EEF3E4]" iconColor="text-[#4F7C3A]" value={`${defectKpis.reworkRate}%`} label="Rework Success Rate" valueColor="text-[#4F7C3A]" />
          </div>

          {/* Log Defect Form */}
          {showDefectForm && (
            <Card>
              <CardHeader className="pb-3"><CardTitle>Log Defect</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Source">
                    <select value={defectForm.source} onChange={(e) => setDefectForm({ ...defectForm, source: e.target.value as DefectSource })} className={INPUT_CLS}>
                      <option value="QC">QC Inspection</option>
                      <option value="RETURN">Customer Return</option>
                      <option value="SUPPLIER">Supplier</option>
                    </select>
                  </FormField>
                  <FormField label="Product">
                    <input type="text" value={defectForm.product} onChange={(e) => setDefectForm({ ...defectForm, product: e.target.value })} placeholder="Product name..." className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Defect Type">
                    <select value={defectForm.defectType} onChange={(e) => setDefectForm({ ...defectForm, defectType: e.target.value })} className={INPUT_CLS}>
                      {Object.entries(DEFECT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Severity">
                    <select value={defectForm.severity} onChange={(e) => setDefectForm({ ...defectForm, severity: e.target.value as "MINOR" | "MAJOR" | "CRITICAL" })} className={INPUT_CLS}>
                      <option value="MINOR">Minor</option>
                      <option value="MAJOR">Major</option>
                      <option value="CRITICAL">Critical</option>
                    </select>
                  </FormField>
                  <FormField label="Action">
                    <select value={defectForm.action} onChange={(e) => setDefectForm({ ...defectForm, action: e.target.value as DefectAction })} className={INPUT_CLS}>
                      <option value="REWORK">Rework</option>
                      <option value="SCRAP">Scrap</option>
                      <option value="RETURN_TO_SUPPLIER">Return to Supplier</option>
                    </select>
                  </FormField>
                  <FormField label="Assigned To">
                    <input type="text" value={defectForm.assignedTo} onChange={(e) => setDefectForm({ ...defectForm, assignedTo: e.target.value })} placeholder="Staff name..." className={INPUT_CLS} />
                  </FormField>
                </div>
                {defectForm.action === "REWORK" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField label="WIP Code">
                      <input type="text" value={defectForm.wipCode || ""} onChange={(e) => setDefectForm({ ...defectForm, wipCode: e.target.value })} placeholder="e.g. WIP-HB-001" className={INPUT_CLS} />
                    </FormField>
                    <FormField label="Rework Department">
                      <select value={defectForm.reworkDept || ""} onChange={(e) => setDefectForm({ ...defectForm, reworkDept: e.target.value })} className={INPUT_CLS}>
                        <option value="">Select department...</option>
                        {QC_DEPARTMENTS.map((dept) => (
                          <option key={dept} value={dept}>{RESPONSIBLE_DEPT_LABELS[dept]}</option>
                        ))}
                      </select>
                    </FormField>
                  </div>
                )}
                <FormField label="Description">
                  <textarea rows={3} value={defectForm.description} onChange={(e) => setDefectForm({ ...defectForm, description: e.target.value })} placeholder="Describe the defect..." className={INPUT_CLS} />
                </FormField>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setShowDefectForm(false); setDefectForm(emptyDefectEntry()); }}>Cancel</Button>
                  <Button variant="primary" onClick={handleAddDefect} disabled={!defectForm.product}>Save Defect</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* View Defect Modal */}
          {viewDefect && (
            <Card className="border-[#6B5C32]">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle>Defect Detail: {viewDefect.defectId}</CardTitle>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewDefect(null)}><X className="h-4 w-4" /></Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                  <div><span className="text-[#6B7280]">Source:</span> <Badge>{viewDefect.source}</Badge></div>
                  <div><span className="text-[#6B7280]">Product:</span> {viewDefect.product}</div>
                  <div><span className="text-[#6B7280]">Defect Type:</span> {DEFECT_TYPE_LABELS[viewDefect.defectType] || viewDefect.defectType}</div>
                  <div><span className="text-[#6B7280]">Severity:</span> <Badge variant="status" status={viewDefect.severity} /></div>
                  <div><span className="text-[#6B7280]">Status:</span> <span className="font-medium text-xs">{viewDefect.status.replace(/_/g, " ")}</span></div>
                  <div><span className="text-[#6B7280]">Action:</span> {viewDefect.action.replace(/_/g, " ")}</div>
                  <div><span className="text-[#6B7280]">Assigned To:</span> {viewDefect.assignedTo}</div>
                  <div><span className="text-[#6B7280]">Date:</span> {formatDateDMY(viewDefect.date)}</div>
                </div>
                {viewDefect.wipCode && (
                  <div className="mt-3 text-sm"><span className="text-[#6B7280]">WIP Code:</span> <span className="ml-1 font-mono">{viewDefect.wipCode}</span></div>
                )}
                {viewDefect.reworkDept && (
                  <div className="mt-1 text-sm"><span className="text-[#6B7280]">Rework Department:</span> <span className="ml-1">{RESPONSIBLE_DEPT_LABELS[viewDefect.reworkDept] || viewDefect.reworkDept}</span></div>
                )}
                {viewDefect.description && (
                  <div className="mt-3 text-sm"><span className="text-[#6B7280]">Description:</span> <span className="ml-1">{viewDefect.description}</span></div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Defects Table */}
          <Card>
            <CardHeader className="pb-3"><CardTitle>All Defect Entries</CardTitle></CardHeader>
            <CardContent>
              <DataGrid
                columns={defectColumns}
                data={defects}
                keyField="id"
                gridId="quality-defects"
                contextMenuItems={defectContextMenu}
                onDoubleClick={(row) => setViewDefect(row)}
                emptyMessage="No defect entries found."
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TAB 4: Supplier NCR                                                 */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === "supplier-ncr" && (
        <>
          {/* KPI Cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <KpiCard icon={<PackageX className="h-5 w-5" />} iconBg="bg-[#F9E1DA]" iconColor="text-[#9A3A2D]" value={ncrKpis.open} label="Open NCRs" valueColor="text-[#9A3A2D]" />
            <KpiCard icon={<CheckCircle2 className="h-5 w-5" />} iconBg="bg-[#EEF3E4]" iconColor="text-[#4F7C3A]" value={ncrKpis.resolved} label="Resolved" valueColor="text-[#4F7C3A]" />
            <KpiCard icon={<FileText className="h-5 w-5" />} iconBg="bg-[#FAEFCB]" iconColor="text-[#9C6F1E]" value={`RM ${ncrKpis.totalClaims.toLocaleString()}`} label="Total Claims (RM)" valueColor="text-[#9C6F1E]" />
            <KpiCard icon={<AlertTriangle className="h-5 w-5" />} iconBg="bg-[#F0ECE9]" iconColor="text-[#6B5C32]" value={ncrKpis.repeatOffenders} label="Repeat Offenders" />
          </div>

          {/* New NCR Form */}
          {showNCRForm && (
            <Card>
              <CardHeader className="pb-3"><CardTitle>New Supplier NCR</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Supplier">
                    <input type="text" value={ncrForm.supplier} onChange={(e) => setNcrForm({ ...ncrForm, supplier: e.target.value })} placeholder="Supplier name..." className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Material Code">
                    <input type="text" value={ncrForm.materialCode} onChange={(e) => setNcrForm({ ...ncrForm, materialCode: e.target.value })} placeholder="e.g. FM-32-YLW" className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Material Name">
                    <input type="text" value={ncrForm.materialName} onChange={(e) => setNcrForm({ ...ncrForm, materialName: e.target.value })} placeholder="Material description..." className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Issue Type">
                    <select value={ncrForm.issueType} onChange={(e) => setNcrForm({ ...ncrForm, issueType: e.target.value as NCRIssueType })} className={INPUT_CLS}>
                      <option value="WRONG_SPEC">Wrong Spec</option>
                      <option value="DAMAGED">Damaged</option>
                      <option value="SHORT_DELIVERY">Short Delivery</option>
                      <option value="QUALITY_FAIL">Quality Fail</option>
                    </select>
                  </FormField>
                  <FormField label="Qty Affected">
                    <input type="number" min={0} value={ncrForm.qtyAffected} onChange={(e) => setNcrForm({ ...ncrForm, qtyAffected: Number(e.target.value) })} className={INPUT_CLS} />
                  </FormField>
                  <FormField label="Claim Amount (RM)">
                    <input type="number" min={0} value={ncrForm.claimAmount} onChange={(e) => setNcrForm({ ...ncrForm, claimAmount: Number(e.target.value) })} className={INPUT_CLS} />
                  </FormField>
                </div>
                <FormField label="Description">
                  <textarea rows={3} value={ncrForm.description} onChange={(e) => setNcrForm({ ...ncrForm, description: e.target.value })} placeholder="Describe the non-conformance..." className={INPUT_CLS} />
                </FormField>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setShowNCRForm(false); setNcrForm(emptyNCR()); }}>Cancel</Button>
                  <Button variant="primary" onClick={handleAddNCR} disabled={!ncrForm.supplier || !ncrForm.materialCode}>Save NCR</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* View NCR Modal */}
          {viewNCR && (
            <Card className="border-[#6B5C32]">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle>NCR Detail: {viewNCR.ncrNo}</CardTitle>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewNCR(null)}><X className="h-4 w-4" /></Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                  <div><span className="text-[#6B7280]">Supplier:</span> {viewNCR.supplier}</div>
                  <div><span className="text-[#6B7280]">Material:</span> <span className="font-mono">{viewNCR.materialCode}</span> — {viewNCR.materialName}</div>
                  <div><span className="text-[#6B7280]">Issue Type:</span> {viewNCR.issueType.replace(/_/g, " ")}</div>
                  <div><span className="text-[#6B7280]">Qty Affected:</span> {viewNCR.qtyAffected}</div>
                  <div><span className="text-[#6B7280]">Claim:</span> <span className="font-medium text-[#9A3A2D]">RM {viewNCR.claimAmount.toLocaleString()}</span></div>
                  <div><span className="text-[#6B7280]">Status:</span> <Badge variant="status" status={viewNCR.status} /></div>
                  <div><span className="text-[#6B7280]">Date:</span> {formatDateDMY(viewNCR.date)}</div>
                </div>
                {viewNCR.description && (
                  <div className="mt-3 text-sm"><span className="text-[#6B7280]">Description:</span> <span className="ml-1">{viewNCR.description}</span></div>
                )}
              </CardContent>
            </Card>
          )}

          {/* NCR Table */}
          <Card>
            <CardHeader className="pb-3"><CardTitle>All Supplier NCRs</CardTitle></CardHeader>
            <CardContent>
              <DataGrid
                columns={ncrColumns}
                data={ncrs}
                keyField="id"
                gridId="quality-ncrs"
                contextMenuItems={ncrContextMenu}
                onDoubleClick={(row) => setViewNCR(row)}
                emptyMessage="No supplier NCRs found."
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TAB 5: Reports                                                       */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === "reports" && (
        <div className="space-y-6">
          {/* Row 1 */}
          <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
            {/* QC Pass Rate Trend */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>QC Pass Rate Trend (Last 7 Dates)</CardTitle></CardHeader>
              <CardContent>
                {passRateTrend.length === 0 ? (
                  <p className="text-sm text-[#9CA3AF] italic">No inspection data available.</p>
                ) : (
                  <div className="space-y-3">
                    {passRateTrend.map(({ date, rate, total }) => (
                      <div key={date} className="flex items-center gap-3">
                        <span className="text-xs text-[#6B7280] w-24 shrink-0">{date}</span>
                        <div className="flex-1 h-5 rounded bg-[#F0ECE9] relative overflow-hidden">
                          <div
                            className={`h-5 rounded transition-all ${rate >= 90 ? "bg-[#4F7C3A]" : rate >= 70 ? "bg-[#9C6F1E]" : "bg-[#9A3A2D]"}`}
                            style={{ width: `${rate}%` }}
                          />
                        </div>
                        <span className="text-xs font-bold text-[#1F1D1B] w-12 text-right">{rate}%</span>
                        <span className="text-xs text-[#9CA3AF] w-12 text-right">({total})</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Defects by Type */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>Defects by Type</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Object.entries(DEFECT_TYPE_LABELS).map(([key, label]) => (
                    <SimpleBar key={key} label={label} count={defectAnalysis.byType[key] || 0} total={defectAnalysis.total} color="bg-[#6B5C32]" />
                  ))}
                  {defectAnalysis.total === 0 && <p className="text-sm text-[#9CA3AF] italic">No defect data yet.</p>}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Row 2 */}
          <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
            {/* Defects by Severity */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>Defects by Severity</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {(["CRITICAL", "MAJOR", "MINOR"] as const).map((sev) => {
                    const count = defectAnalysis.bySeverity[sev] || 0;
                    const colorMap = { CRITICAL: "bg-[#9A3A2D]", MAJOR: "bg-[#9C6F1E]", MINOR: "bg-[#3E6570]" };
                    const textMap = { CRITICAL: "text-[#9A3A2D]", MAJOR: "text-[#9C6F1E]", MINOR: "text-[#3E6570]" };
                    const pct = defectAnalysis.total > 0 ? (count / defectAnalysis.total) * 100 : 0;
                    return (
                      <div key={sev}>
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-sm font-medium ${textMap[sev]}`}>{SEVERITY_LABELS[sev]}</span>
                          <span className={`text-lg font-bold ${textMap[sev]}`}>{count}</span>
                        </div>
                        <div className="h-2 rounded-full bg-[#F0ECE9]">
                          <div className={`h-2 rounded-full ${colorMap[sev]} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                  <div className="pt-2 border-t border-[#E2DDD8]">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-[#6B7280]">Total</span>
                      <span className="text-lg font-bold text-[#1F1D1B]">{defectAnalysis.total}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Top Defective Products */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>Top Defective Products</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Object.entries(defectAnalysis.byProduct)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 6)
                    .map(([product, count]) => (
                      <SimpleBar key={product} label={product} count={count} total={Math.max(...Object.values(defectAnalysis.byProduct), 1)} color="bg-[#F43F5E]" />
                    ))}
                  {Object.keys(defectAnalysis.byProduct).length === 0 && (
                    <p className="text-sm text-[#9CA3AF] italic">No product defect data yet.</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Returns by Issue Type */}
            <Card>
              <CardHeader className="pb-3"><CardTitle>Returns by Issue Type</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Object.entries(defectAnalysis.returnsByType)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => (
                      <SimpleBar key={type} label={type.replace(/_/g, " ")} count={count} total={returns.length} color="bg-[#9C6F1E]" />
                    ))}
                  {returns.length === 0 && <p className="text-sm text-[#9CA3AF] italic">No return data yet.</p>}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Row 3 — Supplier Quality Score */}
          <Card>
            <CardHeader className="pb-3"><CardTitle>Supplier Quality Score</CardTitle></CardHeader>
            <CardContent>
              {supplierQuality.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] italic">No supplier NCR data yet.</p>
              ) : (
                <div className="space-y-3">
                  {supplierQuality
                    .sort((a, b) => a.score - b.score)
                    .map(({ supplier, ncrs: count, score }) => (
                      <div key={supplier} className="flex items-center gap-4">
                        <span className="text-sm font-medium text-[#1F1D1B] w-48 shrink-0 truncate">{supplier}</span>
                        <div className="flex-1 h-4 rounded bg-[#F0ECE9] relative overflow-hidden">
                          <div
                            className={`h-4 rounded transition-all ${score >= 80 ? "bg-[#4F7C3A]" : score >= 60 ? "bg-[#9C6F1E]" : "bg-[#9A3A2D]"}`}
                            style={{ width: `${score}%` }}
                          />
                        </div>
                        <span className={`text-sm font-bold w-12 text-right ${score >= 80 ? "text-[#4F7C3A]" : score >= 60 ? "text-[#9C6F1E]" : "text-[#9A3A2D]"}`}>
                          {score}
                        </span>
                        <span className="text-xs text-[#9CA3AF] w-20 text-right">{count} NCR{count !== 1 ? "s" : ""}</span>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
