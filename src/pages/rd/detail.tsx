import { useState, useEffect, useCallback, useRef } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  ArrowLeft,
  Calendar,
  Users,
  Beaker,
  Clock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Layers,
  Pencil,
  Plus,
  X,
  Package,
  Trash2,
  ImagePlus,
} from "lucide-react";
import type { RDProject, RDProjectStage, RDPrototypeType, RDBOMItem } from "@/types";
import type { RawMaterial } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { RdProjectSchema } from "@/lib/schemas/rd-project";
import { compressImage } from "@/lib/image-compress";

const RDMutationSchema = mutationWithData(RdProjectSchema);

const STAGES: RDProjectStage[] = ["CONCEPT", "DESIGN", "PROTOTYPE", "TESTING", "APPROVED", "PRODUCTION_READY"];

const STAGE_COLORS: Record<RDProjectStage, string> = {
  CONCEPT: "#6366F1",
  DESIGN: "#3B82F6",
  PROTOTYPE: "#F59E0B",
  TESTING: "#F97316",
  APPROVED: "#10B981",
  PRODUCTION_READY: "#06B6D4",
};

const STAGE_LABELS: Record<RDProjectStage, string> = {
  CONCEPT: "Concept",
  DESIGN: "Design",
  PROTOTYPE: "Prototype",
  TESTING: "Testing",
  APPROVED: "Approved",
  PRODUCTION_READY: "Production Ready",
};

const CATEGORY_COLORS: Record<string, string> = {
  SOFA: "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]",
  BEDFRAME: "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]",
  ACCESSORY: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]",
};

const STATUS_OPTIONS = ["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
const CATEGORY_OPTIONS = ["BEDFRAME", "SOFA", "ACCESSORY"] as const;

const PROTO_TYPE_LABELS: Record<RDPrototypeType, string> = {
  FABRIC_SEWING: "Fabric Sewing",
  FRAMING: "Framing",
};
const PROTO_TYPE_COLORS: Record<RDPrototypeType, string> = {
  FABRIC_SEWING: "bg-pink-100 text-pink-700",
  FRAMING: "bg-[#FBE4CE] text-[#B8601A]",
};

const LABOUR_RATE_SEN = 1500; // RM 15/hr

// ─── Modal Overlay ──────────────────────────────────────────────────────────

function ModalOverlay({ open, onClose, title, children, wide }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className={`relative w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-xl bg-white border border-[#E2DDD8] shadow-xl max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E2DDD8] px-6 py-4">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Field helpers ──────────────────────────────────────────────────────────

const labelClass = "block text-xs font-semibold text-gray-500 mb-1";
const inputClass = "w-full rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30 focus:border-[#6B5C32]";
const selectClass = inputClass;

export default function RDProjectDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [project, setProject] = useState<RDProject | null>(null);
  const [advancing, setAdvancing] = useState(false);

  // Edit project modal — projectType + clone-source fields are mirror-
  // for-mirror with the Create dialog (src/pages/rd/index.tsx) so users
  // can switch a project's type after creation and fill in the
  // competitor-source fields on existing rows that pre-date the CLONE
  // feature.
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    projectType: "DEVELOPMENT" as RDProject["projectType"],
    productCategory: "BEDFRAME" as RDProject["productCategory"],
    targetLaunchDate: "",
    totalBudget: 0,
    assignedTeamStr: "",
    status: "ACTIVE" as RDProject["status"],
    sourceProductName: "",
    sourceBrand: "",
    sourcePurchaseRef: "",
    sourcePriceRM: "", // RM string; converted to sen on save
    sourceNotes: "",
  });

  // Add prototype modal
  const [protoOpen, setProtoOpen] = useState(false);
  const [protoSaving, setProtoSaving] = useState(false);
  const [protoForm, setProtoForm] = useState({
    prototypeType: "FRAMING" as RDPrototypeType,
    version: "",
    description: "",
    labourHours: 0,
    testResults: "",
    feedback: "",
    improvements: "",
    defects: "",
    createdDate: new Date().toISOString().slice(0, 10),
  });

  // Production BOM
  const [bomOpen, setBomOpen] = useState(false);
  const [bomSaving, setBomSaving] = useState(false);
  const [bomForm, setBomForm] = useState({
    materialCode: "",
    materialName: "",
    qty: 1,
    unit: "PCS",
    unitCostRM: 0,
  });

  // Material Issuance modal — 2-step picker: Category (itemGroup) → Specific RawMaterial.
  const [issuanceOpen, setIssuanceOpen] = useState(false);
  const [issuanceSaving, setIssuanceSaving] = useState(false);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [rmCategory, setRmCategory] = useState<string>("");
  const [issuanceForm, setIssuanceForm] = useState({
    materialId: "",
    materialCode: "",
    materialName: "",
    unit: "",
    unitCostRM: 0,
    balanceQty: 0,
    qty: 1,
    issuedBy: "",
    notes: "",
  });

  // Labour Hours Log modal
  const [labourOpen, setLabourOpen] = useState(false);
  const [labourSaving, setLabourSaving] = useState(false);
  const [labourForm, setLabourForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    workerName: "",
    department: "R&D",
    hours: 1,
    description: "",
  });

  // Stage photos
  const [stagePhotos, setStagePhotos] = useState<Record<string, string[]>>({});
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoUploadStage, setPhotoUploadStage] = useState<string | null>(null);

  // Cover photo upload — separate from per-stage photos. One photo per project,
  // stored as a JPEG data URL via @/lib/image-compress.
  const coverPhotoInputRef = useRef<HTMLInputElement>(null);
  const [coverPhotoSaving, setCoverPhotoSaving] = useState(false);

  const rdUrl = id ? `/api/rd-projects/${id}` : null;
  const { data: projectResp, loading, refresh: refreshProjectHook } = useCachedJson<{ data?: RDProject }>(rdUrl);
  const { data: inventoryResp, refresh: refreshInventoryHook } = useCachedJson<{ data?: { rawMaterials?: RawMaterial[] } }>("/api/inventory");

  const fetchProject = useCallback(() => {
    if (rdUrl) invalidateCachePrefix(rdUrl);
    invalidateCachePrefix("/api/rd-projects");
    refreshProjectHook();
  }, [rdUrl, refreshProjectHook]);

  const fetchRawMaterials = useCallback(() => {
    invalidateCachePrefix("/api/inventory");
    refreshInventoryHook();
  }, [refreshInventoryHook]);

  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR project + inventory data into mutable local state */
  useEffect(() => {
    if (projectResp) setProject(projectResp.data ?? null);
  }, [projectResp]);

  useEffect(() => {
    setRawMaterials(inventoryResp?.data?.rawMaterials ?? []);
  }, [inventoryResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ─── Advance Stage ──────────────────────────────────────────────────────

  const handleAdvanceStage = async () => {
    if (!project) return;
    const currentIndex = STAGES.indexOf(project.currentStage);
    if (currentIndex >= STAGES.length - 1) return;

    const nextStage = STAGES[currentIndex + 1];
    setAdvancing(true);

    try {
      const updatedMilestones = project.milestones.map((m) => {
        if (m.stage === project.currentStage) {
          return { ...m, actualDate: new Date().toISOString().slice(0, 10), approvedBy: "Current User" };
        }
        return m;
      });

      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { currentStage: nextStage, milestones: updatedMilestones },
      });
      if (data.data) setProject(data.data as RDProject);
      toast.success(`Advanced to ${STAGE_LABELS[nextStage]}`);
    } catch {
      toast.error("Failed to advance stage");
    } finally {
      setAdvancing(false);
    }
  };

  // ─── Edit Project ───────────────────────────────────────────────────────

  const openEditModal = () => {
    if (!project) return;
    setEditForm({
      name: project.name,
      description: project.description,
      projectType: project.projectType,
      productCategory: project.productCategory,
      targetLaunchDate: project.targetLaunchDate,
      totalBudget: project.totalBudget / 100, // sen to RM
      assignedTeamStr: project.assignedTeam.join(", "),
      status: project.status,
      sourceProductName: project.sourceProductName ?? "",
      sourceBrand: project.sourceBrand ?? "",
      sourcePurchaseRef: project.sourcePurchaseRef ?? "",
      // Stored in sen on the row; the editor field uses RM. Empty string
      // (not "0") when there's nothing recorded so the input renders
      // as an empty placeholder instead of "0.00".
      sourcePriceRM:
        typeof project.sourcePriceSen === "number"
          ? (project.sourcePriceSen / 100).toString()
          : "",
      sourceNotes: project.sourceNotes ?? "",
    });
    setEditOpen(true);
  };

  const handleEditSave = async () => {
    if (!project) return;
    setEditSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: editForm.name.trim(),
        description: editForm.description.trim(),
        projectType: editForm.projectType,
        productCategory: editForm.productCategory,
        targetLaunchDate: editForm.targetLaunchDate,
        totalBudget: Math.round(editForm.totalBudget * 100), // RM to sen
        assignedTeam: editForm.assignedTeamStr.split(",").map((s) => s.trim()).filter(Boolean),
        status: editForm.status,
      };
      // Clone-source fields: send when projectType === 'CLONE' (write or
      // clear). When projectType is changing AWAY from CLONE, blank them
      // so we don't carry stale data on the row. Other types just
      // ignore these columns.
      if (editForm.projectType === "CLONE") {
        payload.sourceProductName = editForm.sourceProductName.trim() || null;
        payload.sourceBrand = editForm.sourceBrand.trim() || null;
        payload.sourcePurchaseRef = editForm.sourcePurchaseRef.trim() || null;
        const priceTrimmed = editForm.sourcePriceRM.trim().replace(/,/g, "");
        if (priceTrimmed) {
          const rm = parseFloat(priceTrimmed);
          payload.sourcePriceSen =
            Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : null;
        } else {
          payload.sourcePriceSen = null;
        }
        payload.sourceNotes = editForm.sourceNotes.trim() || null;
      } else if (project.projectType === "CLONE") {
        payload.sourceProductName = null;
        payload.sourceBrand = null;
        payload.sourcePurchaseRef = null;
        payload.sourcePriceSen = null;
        payload.sourceNotes = null;
      }
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: payload,
      });
      if (data.data) setProject(data.data as RDProject);
      setEditOpen(false);
      toast.success("Project updated successfully");
    } catch {
      toast.error("Failed to update project");
    } finally {
      setEditSaving(false);
    }
  };

  // ─── Add Prototype ──────────────────────────────────────────────────────

  const getNextVersion = (pType: RDPrototypeType): string => {
    if (!project) return "v1";
    const count = project.prototypes.filter((p) => p.prototypeType === pType).length;
    return `v${count + 1}`;
  };

  const openProtoModal = (pType: RDPrototypeType) => {
    const nextVersion = getNextVersion(pType);
    setProtoForm({
      prototypeType: pType,
      version: nextVersion,
      description: "",
      labourHours: 0,
      testResults: "",
      feedback: "",
      improvements: "",
      defects: "",
      createdDate: new Date().toISOString().slice(0, 10),
    });
    setProtoOpen(true);
  };

  const handleProtoSave = async () => {
    if (!project) return;
    if (!protoForm.version.trim()) {
      toast.warning("Version is required");
      return;
    }
    setProtoSaving(true);
    try {
      const newProto = {
        id: `proto-${Date.now()}`,
        projectId: project.id,
        prototypeType: protoForm.prototypeType,
        version: protoForm.version.trim(),
        description: protoForm.description.trim(),
        materialsCost: 0,
        labourHours: protoForm.labourHours,
        testResults: protoForm.testResults.trim(),
        feedback: protoForm.feedback.trim(),
        improvements: protoForm.improvements.trim(),
        defects: protoForm.defects.trim(),
        createdDate: protoForm.createdDate,
      };
      const updatedPrototypes = [...project.prototypes, newProto];
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { prototypes: updatedPrototypes },
      });
      if (data.data) setProject(data.data as RDProject);
      setProtoOpen(false);
      toast.success("Prototype added successfully");
    } catch {
      toast.error("Failed to add prototype");
    } finally {
      setProtoSaving(false);
    }
  };

  // ─── Production BOM ────────────────────────────────────────────────────

  const handleAddBomItem = async () => {
    if (!project) return;
    if (!bomForm.materialCode.trim() || !bomForm.materialName.trim()) {
      toast.warning("Material code and name are required");
      return;
    }
    setBomSaving(true);
    try {
      const newItem: RDBOMItem = {
        id: `rdbom-${Date.now()}`,
        materialCode: bomForm.materialCode.trim(),
        materialName: bomForm.materialName.trim(),
        qty: bomForm.qty,
        unit: bomForm.unit,
        unitCostSen: Math.round(bomForm.unitCostRM * 100),
      };
      const updatedBOM = [...(project.productionBOM || []), newItem];
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { productionBOM: updatedBOM },
      });
      if (data.data) setProject(data.data as RDProject);
      setBomOpen(false);
      setBomForm({ materialCode: "", materialName: "", qty: 1, unit: "PCS", unitCostRM: 0 });
      toast.success("Material added to Production BOM");
    } catch {
      toast.error("Failed to add material");
    } finally {
      setBomSaving(false);
    }
  };

  const handleRemoveBomItem = async (itemId: string) => {
    if (!project) return;
    const updatedBOM = (project.productionBOM || []).filter((b) => b.id !== itemId);
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { productionBOM: updatedBOM },
      });
      if (data.data) setProject(data.data as RDProject);
      toast.success("Material removed");
    } catch {
      toast.error("Failed to remove material");
    }
  };

  // ─── Material Issuance ─────────────────────────────────────────────────

  const openIssuanceModal = () => {
    fetchRawMaterials();
    setRmCategory("");
    setIssuanceForm({
      materialId: "",
      materialCode: "",
      materialName: "",
      unit: "",
      unitCostRM: 0,
      balanceQty: 0,
      qty: 1,
      issuedBy: "",
      notes: "",
    });
    setIssuanceOpen(true);
  };

  // Step 2 of the picker: pick a specific RawMaterial within the selected category.
  const selectRawMaterialById = (materialId: string) => {
    const rm = rawMaterials.find((r) => r.id === materialId);
    if (!rm) {
      setIssuanceForm((f) => ({
        ...f,
        materialId: "",
        materialCode: "",
        materialName: "",
        unit: "",
        unitCostRM: 0,
        balanceQty: 0,
      }));
      return;
    }
    setIssuanceForm((f) => ({
      ...f,
      materialId: rm.id,
      materialCode: rm.itemCode,
      materialName: rm.description,
      unit: rm.baseUOM,
      unitCostRM: 0, // FIFO estimated — no cost data on RawMaterial, user enters manually
      balanceQty: rm.balanceQty,
    }));
  };

  const handleIssueMaterial = async () => {
    if (!project) return;
    if (!issuanceForm.materialId) {
      toast.warning("Please select a material");
      return;
    }
    if (issuanceForm.qty <= 0) {
      toast.warning("Quantity must be greater than 0");
      return;
    }
    if (!issuanceForm.issuedBy.trim()) {
      toast.warning("Issued By is required");
      return;
    }
    setIssuanceSaving(true);
    try {
      const res = await fetch(`/api/rd-projects/${id}/issue-material`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          materialId: issuanceForm.materialId,
          qty: issuanceForm.qty,
          issuedBy: issuanceForm.issuedBy.trim(),
          notes: issuanceForm.notes.trim(),
          unitCostSen: Math.round(issuanceForm.unitCostRM * 100),
        }),
      });
      if (res.ok) {
        await fetchProject();
        setIssuanceOpen(false);
        toast.success("Material issued successfully");
      } else {
        toast.error("Failed to issue material");
      }
    } catch {
      toast.error("Failed to issue material");
    } finally {
      setIssuanceSaving(false);
    }
  };

  const handleRemoveIssuance = async (issuanceId: string) => {
    if (!project) return;
    const updated = (project.materialIssuances || []).filter((i) => i.id !== issuanceId);
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { materialIssuances: updated },
      });
      if (data.data) setProject(data.data as RDProject);
      toast.success("Issuance removed");
    } catch {
      toast.error("Failed to remove issuance");
    }
  };

  // ─── Labour Hours Log ──────────────────────────────────────────────────

  const openLabourModal = () => {
    setLabourForm({
      date: new Date().toISOString().slice(0, 10),
      workerName: "",
      department: "R&D",
      hours: 1,
      description: "",
    });
    setLabourOpen(true);
  };

  const handleLogLabour = async () => {
    if (!project) return;
    if (!labourForm.workerName.trim()) {
      toast.warning("Worker name is required");
      return;
    }
    if (labourForm.hours <= 0) {
      toast.warning("Hours must be greater than 0");
      return;
    }
    setLabourSaving(true);
    try {
      const res = await fetch(`/api/rd-projects/${id}/labour-log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: labourForm.date,
          workerName: labourForm.workerName.trim(),
          department: labourForm.department.trim(),
          hours: labourForm.hours,
          description: labourForm.description.trim(),
        }),
      });
      if (res.ok) {
        await fetchProject();
        setLabourOpen(false);
        toast.success("Labour hours logged successfully");
      } else {
        toast.error("Failed to log labour hours");
      }
    } catch {
      toast.error("Failed to log labour hours");
    } finally {
      setLabourSaving(false);
    }
  };

  // ─── Stage Photo Upload ────────────────────────────────────────────────
  const handlePhotoUpload = (stage: string) => {
    setPhotoUploadStage(stage);
    photoInputRef.current?.click();
  };

  const handlePhotoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !photoUploadStage) return;
    const newPhotos: string[] = [];
    for (let i = 0; i < files.length; i++) {
      newPhotos.push(URL.createObjectURL(files[i]));
    }
    setStagePhotos((prev) => ({
      ...prev,
      [photoUploadStage]: [...(prev[photoUploadStage] || []), ...newPhotos],
    }));
    // Also save to milestone photos array
    if (project) {
      const updatedMilestones = project.milestones.map((m) => {
        if (m.stage === photoUploadStage) {
          return { ...m, photos: [...(m.photos || []), ...newPhotos] };
        }
        return m;
      });
      fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { milestones: updatedMilestones },
      }).then((data) => {
        if (data.data) setProject(data.data as RDProject);
      }).catch(() => {});
    }
    setPhotoUploadStage(null);
    e.target.value = "";
  };

  const removeStagePhoto = (stage: string, index: number) => {
    setStagePhotos((prev) => {
      const updated = [...(prev[stage] || [])];
      URL.revokeObjectURL(updated[index]);
      updated.splice(index, 1);
      return { ...prev, [stage]: updated };
    });
  };

  // Reorder a photo within a milestone's photos[] array (swap adjacent).
  // The leftmost photo is the implicit cover (Ask 2 in the project card).
  const handleReorderPhoto = async (stage: string, index: number, direction: -1 | 1) => {
    if (!project) return;
    const milestone = project.milestones.find((m) => m.stage === stage);
    if (!milestone) return;
    const localPhotos = stagePhotos[stage];
    const sourcePhotos = (localPhotos && localPhotos.length > 0 ? localPhotos : milestone.photos) || [];
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= sourcePhotos.length) return;
    const reordered = [...sourcePhotos];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

    // Optimistic local update so the user sees the swap instantly
    setStagePhotos((prev) => ({ ...prev, [stage]: reordered }));
    const previousProject = project;
    const updatedMilestones = project.milestones.map((m) =>
      m.stage === stage ? { ...m, photos: reordered } : m,
    );
    setProject({ ...project, milestones: updatedMilestones });

    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { milestones: updatedMilestones },
      });
      if (data.data) setProject(data.data as RDProject);
    } catch {
      // Rollback on error
      setProject(previousProject);
      setStagePhotos((prev) => ({ ...prev, [stage]: sourcePhotos }));
      toast.error("Failed to reorder photo");
    }
  };

  // ─── Target Date (editable in-place; same model as Target Launch Date) ────
  const handleTargetDateChange = async (stage: string, newDate: string) => {
    if (!project) return;
    const previousProject = project;
    const updatedMilestones = project.milestones.map((m) =>
      m.stage === stage ? { ...m, targetDate: newDate } : m,
    );
    // Optimistic local update
    setProject({ ...project, milestones: updatedMilestones });
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { milestones: updatedMilestones },
      });
      if (data.data) setProject(data.data as RDProject);
    } catch {
      setProject(previousProject);
      toast.error("Failed to update target date");
    }
  };

  // ─── Cover Photo ────────────────────────────────────────────────────────
  // Dedicated cover photo (separate from milestone photos[]). One image per
  // project, stored as a JPEG data URL in rd_projects.cover_photo_url.

  const handleCoverPhotoUpload = async (file: File | null) => {
    if (!file || !project) return;
    setCoverPhotoSaving(true);
    try {
      const dataUrl = await compressImage(file, { maxDim: 1280, quality: 0.85 });
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { coverPhotoUrl: dataUrl },
      });
      if (data.data) setProject(data.data as RDProject);
      toast.success("Cover photo updated");
    } catch {
      toast.error("Failed to upload cover photo");
    } finally {
      setCoverPhotoSaving(false);
    }
  };

  const handleCoverPhotoRemove = async () => {
    if (!project) return;
    setCoverPhotoSaving(true);
    try {
      const data = await fetchJson(`/api/rd-projects/${id}`, RDMutationSchema, {
        method: "PUT",
        body: { coverPhotoUrl: null },
      });
      if (data.data) setProject(data.data as RDProject);
      toast.success("Cover photo removed");
    } catch {
      toast.error("Failed to remove cover photo");
    } finally {
      setCoverPhotoSaving(false);
    }
  };

  // ─── Computed Cost Summary ─────────────────────────────────────────────

  const materialCostSen = project
    ? (project.materialIssuances || []).reduce((sum, i) => sum + i.totalCostSen, 0)
    : 0;
  const totalLabourHours = project
    ? (project.labourLogs || []).reduce((sum, l) => sum + l.hours, 0)
    : 0;
  const labourCostSen = totalLabourHours * LABOUR_RATE_SEN;
  const totalRDCostSen = materialCostSen + labourCostSen;

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate("/rd")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to R&D
        </Button>
        <div className="text-center py-16 text-gray-400">Project not found.</div>
      </div>
    );
  }

  const currentStageIndex = STAGES.indexOf(project.currentStage);
  const budgetPct = project.totalBudget > 0 ? Math.round((project.actualCost / project.totalBudget) * 100) : 0;
  const remaining = project.totalBudget - project.actualCost;

  // Step 1 of the picker: distinct active itemGroups, sorted alphabetically.
  const rmCategoryOptions = Array.from(
    new Set(
      rawMaterials
        .filter((rm) => rm.isActive)
        .map((rm) => rm.itemGroup)
        .filter(Boolean),
    ),
  ).sort();

  // Step 2 of the picker: materials in the chosen itemGroup, sorted by itemCode.
  const rmInCategory = rmCategory
    ? rawMaterials
        .filter((rm) => rm.isActive && rm.itemGroup === rmCategory)
        .sort((a, b) => a.itemCode.localeCompare(b.itemCode))
    : [];

  // Cover photo for the header thumbnail. First milestone with photos wins;
  // local stagePhotos override the persisted set so a fresh upload appears immediately.
  const coverPhoto: string | undefined = (() => {
    for (const m of project.milestones) {
      const local = stagePhotos[m.stage];
      const photos = local && local.length > 0 ? local : m.photos;
      if (photos && photos.length > 0) return photos[0];
    }
    return undefined;
  })();

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" onClick={() => navigate("/rd")} className="gap-2">
        <ArrowLeft className="h-4 w-4" /> Back to R&D
      </Button>

      {/* Cover Photo — glanceable thumbnail of what this project is about.
          Square 1:1 box capped at 320px wide because uploaded shots are
          typically square product photos; a full-width banner crops them. */}
      <div className="rounded-xl border border-[#E2DDD8] bg-[#FAF9F8] overflow-hidden w-full max-w-[320px] aspect-square">
        {project.coverPhotoUrl ? (
          <div className="relative h-full w-full">
            <img
              src={project.coverPhotoUrl}
              alt={`${project.name} cover`}
              className="h-full w-full object-cover bg-[#FAF9F8]"
            />
            <div className="absolute top-2 right-2 flex items-center gap-1.5">
              <label className="inline-flex items-center gap-1.5 cursor-pointer rounded-lg border border-[#E2DDD8] bg-white/95 hover:bg-white px-2.5 py-1 text-xs font-medium text-[#1F1D1B] shadow-sm">
                <ImagePlus className="h-3.5 w-3.5" />
                {coverPhotoSaving ? "Saving..." : "Replace"}
                <input
                  ref={coverPhotoInputRef}
                  type="file"
                  accept="image/*"
                  disabled={coverPhotoSaving}
                  onChange={(e) => {
                    void handleCoverPhotoUpload(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                  className="hidden"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleCoverPhotoRemove()}
                disabled={coverPhotoSaving}
                className="inline-flex items-center justify-center rounded-lg border border-[#E2DDD8] bg-white/95 hover:bg-white p-1.5 text-gray-500 hover:text-[#9A3A2D] shadow-sm disabled:opacity-50"
                title="Remove cover photo"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <label className="flex h-full w-full flex-col items-center justify-center cursor-pointer text-gray-400 hover:text-[#6B5C32] hover:bg-[#F0ECE9] transition-colors">
            <ImagePlus className="h-8 w-8 mb-2" />
            <span className="text-sm font-medium">
              {coverPhotoSaving ? "Uploading..." : "Upload cover photo"}
            </span>
            <span className="text-xs mt-1 text-gray-400">
              A glanceable thumbnail of this project
            </span>
            <input
              type="file"
              accept="image/*"
              disabled={coverPhotoSaving}
              onChange={(e) => {
                void handleCoverPhotoUpload(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
              className="hidden"
            />
          </label>
        )}
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 flex-1 min-w-0">
          {/* Cover thumbnail — first milestone photo, or placeholder slot. */}
          {coverPhoto ? (
            <img
              src={coverPhoto}
              alt={`${project.name} cover`}
              className="h-20 w-20 rounded-lg object-cover border border-[#E2DDD8] flex-shrink-0"
            />
          ) : (
            <div
              className="h-20 w-20 rounded-lg border border-dashed border-[#D0C9C0] bg-[#F0ECE9] flex flex-col items-center justify-center text-[10px] text-gray-400 leading-tight flex-shrink-0"
              title="Upload a milestone photo to set a cover"
              aria-label="No cover photo yet"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 mb-0.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              <span className="font-medium">Cover</span>
            </div>
          )}
          <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-sm font-mono text-gray-400">{project.code}</span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${CATEGORY_COLORS[project.productCategory]}`}>
              {project.productCategory}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border ${
                project.projectType === "IMPROVEMENT"
                  ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
                  : project.projectType === "CLONE"
                  ? "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]"
                  : "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]"
              }`}
            >
              {project.projectType === "IMPROVEMENT"
                ? "Improvement"
                : project.projectType === "CLONE"
                ? "Clone / Replicate"
                : "Research"}
            </span>
            <Badge variant="status" status={project.status}>{project.status.replace(/_/g, " ")}</Badge>
          </div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">{project.name}</h1>
          {project.serviceId && (
            <p className="text-xs text-gray-400 mt-0.5">
              Service Ref: <span className="font-mono font-medium text-[#6B5C32]">{project.serviceId}</span>
            </p>
          )}
          <p className="text-sm text-gray-500 mt-1">{project.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" onClick={openEditModal} className="gap-1.5">
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          {currentStageIndex < STAGES.length - 1 && project.status === "ACTIVE" && (
            <Button variant="primary" onClick={handleAdvanceStage} disabled={advancing}>
              {advancing ? "Advancing..." : `Advance to ${STAGE_LABELS[STAGES[currentStageIndex + 1]]}`}
              {!advancing && <ChevronRight className="h-4 w-4 ml-1" />}
            </Button>
          )}
        </div>
      </div>

      {/* Stage Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Stage Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-0">
            {STAGES.map((stage, i) => {
              const isCompleted = i < currentStageIndex;
              const isCurrent = i === currentStageIndex;
              const isFuture = i > currentStageIndex;
              return (
                <div key={stage} className="flex-1 flex flex-col items-center relative">
                  {/* Connector line */}
                  {i > 0 && (
                    <div
                      className="absolute top-4 right-1/2 w-full h-0.5"
                      style={{ backgroundColor: isCompleted || isCurrent ? STAGE_COLORS[stage] : "#E2DDD8" }}
                    />
                  )}
                  {/* Circle */}
                  <div
                    className="relative z-10 h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold border-2"
                    style={{
                      backgroundColor: isCompleted ? STAGE_COLORS[stage] : isCurrent ? "white" : "#F9FAFB",
                      borderColor: isFuture ? "#E2DDD8" : STAGE_COLORS[stage],
                      color: isCompleted ? "white" : isCurrent ? STAGE_COLORS[stage] : "#9CA3AF",
                    }}
                  >
                    {isCompleted ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </div>
                  <p
                    className="text-[10px] font-medium mt-1 text-center"
                    style={{ color: isFuture ? "#9CA3AF" : STAGE_COLORS[stage] }}
                  >
                    {STAGE_LABELS[stage]}
                  </p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Clone source — only shown for CLONE projects with at least one field set */}
      {project.projectType === "CLONE" &&
        (project.sourceProductName ||
          project.sourceBrand ||
          project.sourcePurchaseRef ||
          (typeof project.sourcePriceSen === "number" && project.sourcePriceSen > 0) ||
          project.sourceNotes) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Package className="h-4 w-4 text-gray-400" /> Clone Source
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {project.sourceProductName && (
                  <div>
                    <dt className="text-xs text-gray-400">Product / Model</dt>
                    <dd className="text-[#1F1D1B] font-medium">{project.sourceProductName}</dd>
                  </div>
                )}
                {project.sourceBrand && (
                  <div>
                    <dt className="text-xs text-gray-400">Brand / Supplier</dt>
                    <dd className="text-[#1F1D1B] font-medium">{project.sourceBrand}</dd>
                  </div>
                )}
                {project.sourcePurchaseRef && (
                  <div>
                    <dt className="text-xs text-gray-400">Purchase Ref / Invoice No.</dt>
                    <dd className="font-mono text-[#6B5C32]">{project.sourcePurchaseRef}</dd>
                  </div>
                )}
                {typeof project.sourcePriceSen === "number" && project.sourcePriceSen > 0 && (
                  <div>
                    <dt className="text-xs text-gray-400">Purchase Price</dt>
                    <dd className="text-[#1F1D1B] font-medium tabular-nums">
                      {formatCurrency(project.sourcePriceSen)}
                    </dd>
                  </div>
                )}
                {project.sourceNotes && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-gray-400">Notes</dt>
                    <dd className="text-[#1F1D1B] whitespace-pre-wrap">{project.sourceNotes}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
        )}

      <div className="grid grid-cols-2 gap-6">
        {/* Milestones */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-400" /> Milestones
            </CardTitle>
          </CardHeader>
          <CardContent>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handlePhotoFileChange}
            />
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Stage</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Target</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Actual</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Approved By</th>
                  <th className="text-left py-2 text-xs font-semibold text-gray-500">Photos</th>
                </tr>
              </thead>
              <tbody>
                {project.milestones.map((m) => {
                  const photos = stagePhotos[m.stage] || m.photos || [];
                  return (
                    <tr key={m.stage} className="border-b border-[#E2DDD8]/50 align-top">
                      <td className="py-2">
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                          style={{ backgroundColor: STAGE_COLORS[m.stage] }}
                        >
                          {STAGE_LABELS[m.stage]}
                        </span>
                      </td>
                      <td className="py-2 text-xs">
                        {/* Target: editable; persisted ISO date stripped to YYYY-MM-DD, blank when unset */}
                        <input
                          type="date"
                          value={(m.targetDate || "").slice(0, 10)}
                          onChange={(e) => handleTargetDateChange(m.stage, e.target.value)}
                          className="rounded border border-[#E2DDD8] px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30 text-gray-600"
                          title="Target completion date"
                        />
                      </td>
                      <td className="py-2 text-xs">
                        {m.actualDate ? (
                          <span className="text-[#4F7C3A] font-medium">{formatDate(m.actualDate)}</span>
                        ) : (
                          <span className="text-gray-300">--</span>
                        )}
                      </td>
                      <td className="py-2 text-xs text-gray-600">{m.approvedBy || <span className="text-gray-300">--</span>}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {photos.map((photo, idx) => {
                            const isFirst = idx === 0;
                            const isLast = idx === photos.length - 1;
                            return (
                              <div key={idx} className="relative group/photo">
                                <img
                                  src={photo}
                                  alt={`${STAGE_LABELS[m.stage]} photo ${idx + 1}`}
                                  className={`h-10 w-10 rounded-md object-cover border cursor-pointer hover:ring-2 hover:ring-[#6B5C32]/40 ${
                                    isFirst ? "border-[#6B5C32] ring-1 ring-[#6B5C32]/30" : "border-[#E2DDD8]"
                                  }`}
                                  onClick={() => window.open(photo, "_blank")}
                                  title={isFirst ? "Cover photo (shown on project card)" : `Photo ${idx + 1}`}
                                />
                                {/* Left chevron — disabled for first */}
                                <button
                                  onClick={() => handleReorderPhoto(m.stage, idx, -1)}
                                  disabled={isFirst}
                                  className="absolute top-1/2 -left-2 -translate-y-1/2 hidden group-hover/photo:flex h-4 w-4 items-center justify-center rounded-full bg-white border border-[#E2DDD8] shadow text-gray-500 hover:text-[#6B5C32] disabled:opacity-30 disabled:cursor-not-allowed"
                                  title="Move left"
                                >
                                  <ChevronLeft className="h-3 w-3" />
                                </button>
                                {/* Right chevron — disabled for last */}
                                <button
                                  onClick={() => handleReorderPhoto(m.stage, idx, 1)}
                                  disabled={isLast}
                                  className="absolute top-1/2 -right-2 -translate-y-1/2 hidden group-hover/photo:flex h-4 w-4 items-center justify-center rounded-full bg-white border border-[#E2DDD8] shadow text-gray-500 hover:text-[#6B5C32] disabled:opacity-30 disabled:cursor-not-allowed"
                                  title="Move right"
                                >
                                  <ChevronRight className="h-3 w-3" />
                                </button>
                                <button
                                  onClick={() => removeStagePhoto(m.stage, idx)}
                                  className="absolute -top-1.5 -right-1.5 hidden group-hover/photo:flex h-4 w-4 items-center justify-center rounded-full bg-[#9A3A2D] text-white text-[8px]"
                                >
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              </div>
                            );
                          })}
                          <button
                            onClick={() => handlePhotoUpload(m.stage)}
                            className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-[#D0C9C0] text-gray-400 hover:border-[#6B5C32] hover:text-[#6B5C32] hover:bg-[#F0ECE9] transition-colors"
                            title={`Add photo for ${STAGE_LABELS[m.stage]}`}
                          >
                            <ImagePlus className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Budget Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-gray-400" /> Budget
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-3 rounded-lg bg-[#F0ECE9]">
                <p className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(project.totalBudget)}</p>
                <p className="text-xs text-gray-500">Total Budget</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-[#FAEFCB]">
                <p className="text-lg font-bold text-[#9C6F1E]">{formatCurrency(project.actualCost)}</p>
                <p className="text-xs text-gray-500">Actual Cost</p>
              </div>
              <div className="text-center p-3 rounded-lg" style={{ backgroundColor: remaining >= 0 ? "#F0FDF4" : "#FEF2F2" }}>
                <p className={`text-lg font-bold ${remaining >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}`}>{formatCurrency(Math.abs(remaining))}</p>
                <p className="text-xs text-gray-500">{remaining >= 0 ? "Remaining" : "Over Budget"}</p>
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Budget Utilisation</span>
                <span className="font-medium" style={{ color: budgetPct > 90 ? "#DC2626" : budgetPct > 70 ? "#D97706" : "#16A34A" }}>
                  {budgetPct}%
                </span>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(budgetPct, 100)}%`,
                    backgroundColor: budgetPct > 90 ? "#DC2626" : budgetPct > 70 ? "#D97706" : "#16A34A",
                  }}
                />
              </div>
            </div>

            {/* R&D Cost Breakdown */}
            <div className="pt-3 border-t border-[#E2DDD8] space-y-2">
              <p className="text-xs font-semibold text-gray-500">R&D Cost Breakdown</p>
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Material Cost</span>
                  <span className="font-medium text-[#1F1D1B]">{formatCurrency(materialCostSen)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Labour Cost ({totalLabourHours}h x RM 15/hr)</span>
                  <span className="font-medium text-[#1F1D1B]">{formatCurrency(labourCostSen)}</span>
                </div>
                <div className="flex justify-between text-sm pt-1 border-t border-dashed border-[#E2DDD8]">
                  <span className="font-semibold text-[#1F1D1B]">Total R&D Cost</span>
                  <span className="font-bold text-[#1F1D1B]">{formatCurrency(totalRDCostSen)}</span>
                </div>
              </div>
            </div>

            {/* Team & Info */}
            <div className="pt-3 border-t border-[#E2DDD8] space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-gray-400" />
                <span className="text-gray-500">Target Launch:</span>
                <span className="font-medium">{formatDate(project.targetLaunchDate)}</span>
              </div>
              <div className="flex items-start gap-2 text-sm">
                <Users className="h-4 w-4 text-gray-400 mt-0.5" />
                <span className="text-gray-500">Team:</span>
                <div className="flex flex-wrap gap-1">
                  {project.assignedTeam.map((name) => (
                    <span key={name} className="inline-flex items-center rounded-full bg-[#F0ECE9] px-2 py-0.5 text-xs text-[#6B5C32]">
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Prototypes — split by type */}
      {(["FABRIC_SEWING", "FRAMING"] as RDPrototypeType[]).map((pType) => {
        const typeProtos = project.prototypes.filter((p) => p.prototypeType === pType);
        return (
          <Card key={pType}>
            <CardHeader>
              <div className="flex items-center justify-between w-full">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Beaker className="h-4 w-4 text-gray-400" />
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${PROTO_TYPE_COLORS[pType]}`}>
                    {PROTO_TYPE_LABELS[pType]}
                  </span>
                  Prototypes ({typeProtos.length})
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openProtoModal(pType)}
                  className="gap-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" /> Add {PROTO_TYPE_LABELS[pType]}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {typeProtos.length === 0 ? (
                <div className="text-center py-6 text-gray-300 text-sm">No {PROTO_TYPE_LABELS[pType].toLowerCase()} prototypes yet.</div>
              ) : (
                <div className="space-y-4">
                  {typeProtos.map((proto) => (
                    <div key={proto.id} className="border border-[#E2DDD8] rounded-lg p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-full bg-[#6B5C32] text-white px-2.5 py-0.5 text-xs font-semibold">
                              {proto.version}
                            </span>
                            <span className="text-xs text-gray-400">{formatDate(proto.createdDate)}</span>
                          </div>
                          <p className="text-sm font-medium text-[#1F1D1B] mt-1">{proto.description}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="h-3.5 w-3.5 text-gray-400" />
                        <span className="text-gray-500">Labour Hours:</span>
                        <span className="font-medium">{proto.labourHours}h</span>
                      </div>
                      {/* Improvements section */}
                      {proto.improvements && (
                        <div className="rounded-lg bg-[#EEF3E4] border border-[#C6DBA8] p-3">
                          <p className="text-xs font-semibold text-[#4F7C3A] mb-0.5">Improvements</p>
                          <p className="text-xs text-[#4F7C3A] whitespace-pre-wrap">{proto.improvements}</p>
                        </div>
                      )}
                      {/* Defects section */}
                      {proto.defects && (
                        <div className="rounded-lg bg-[#FAEFCB] border border-[#E8D597] p-3">
                          <p className="text-xs font-semibold text-[#9C6F1E] mb-0.5">Defects</p>
                          <p className="text-xs text-[#9C6F1E] whitespace-pre-wrap">{proto.defects}</p>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <p className="text-xs text-gray-500 mb-0.5">Test Results</p>
                          <p className="text-xs text-[#1F1D1B] bg-[#F0ECE9] rounded p-2">{proto.testResults || "\u2014"}</p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500 mb-0.5">Feedback</p>
                          <p className="text-xs text-[#1F1D1B] bg-[#F0ECE9] rounded p-2">{proto.feedback || "\u2014"}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Production BOM — visible when at APPROVED or PRODUCTION_READY */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardTitle className="text-sm flex items-center gap-2">
              <Layers className="h-4 w-4 text-gray-400" /> Production BOM — Raw Materials
              {(project.productionBOM || []).length > 0 && (
                <span className="text-xs font-normal text-gray-400">
                  ({(project.productionBOM || []).length} items)
                </span>
              )}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={() => setBomOpen(true)} className="gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> Add Material
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {(project.productionBOM || []).length === 0 ? (
            <div className="text-center py-8 text-gray-300 text-sm">
              No raw materials added yet. Add materials to calculate production cost.
            </div>
          ) : (
            <div className="space-y-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Code</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Material</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Qty</th>
                    <th className="text-center py-2 px-2 text-xs font-semibold text-gray-500">Unit</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Unit Cost</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Total</th>
                    <th className="text-center py-2 px-2 text-xs font-semibold text-gray-500 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {(project.productionBOM || []).map((item) => (
                    <tr key={item.id} className="border-b border-[#E2DDD8]/50 hover:bg-[#F0ECE9]/50">
                      <td className="py-2 px-2 text-xs font-mono text-gray-500">{item.materialCode}</td>
                      <td className="py-2 px-2 text-sm font-medium text-[#1F1D1B]">{item.materialName}</td>
                      <td className="py-2 px-2 text-right text-sm">{item.qty}</td>
                      <td className="py-2 px-2 text-center text-xs text-gray-500">{item.unit}</td>
                      <td className="py-2 px-2 text-right text-sm">{formatCurrency(item.unitCostSen)}</td>
                      <td className="py-2 px-2 text-right text-sm font-semibold">{formatCurrency(item.unitCostSen * item.qty)}</td>
                      <td className="py-2 px-2 text-center">
                        <button
                          onClick={() => handleRemoveBomItem(item.id)}
                          className="text-gray-300 hover:text-[#7A2E24] transition-colors"
                          title="Remove"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Cost Summary */}
              <div className="border-t-2 border-[#E2DDD8] pt-3 flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  Total Raw Material Cost ({(project.productionBOM || []).length} items)
                </div>
                <div className="text-lg font-bold text-[#1F1D1B]">
                  {formatCurrency((project.productionBOM || []).reduce((sum, item) => sum + item.unitCostSen * item.qty, 0))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Material Issuance Log */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardTitle className="text-sm flex items-center gap-2">
              <Package className="h-4 w-4 text-gray-400" />
              Material Issuance — Raw Material Usage
              <span className="text-xs font-normal font-mono text-gray-400">{project.code}</span>
            </CardTitle>
            <Button variant="outline" size="sm" onClick={openIssuanceModal} className="gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> Issue Material
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {(project.materialIssuances || []).length === 0 ? (
            <div className="text-center py-8 text-gray-300 text-sm">
              No materials issued yet. Issue raw materials to track R&D consumption.
            </div>
          ) : (
            <div className="space-y-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Date</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Material Code</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Material Name</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Qty</th>
                    <th className="text-center py-2 px-2 text-xs font-semibold text-gray-500">Unit</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Unit Cost (RM)</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Total (RM)</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Issued By</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Notes</th>
                    <th className="text-center py-2 px-2 text-xs font-semibold text-gray-500 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {(project.materialIssuances || []).map((iss) => (
                    <tr key={iss.id} className="border-b border-[#E2DDD8]/50 hover:bg-[#F0ECE9]/50">
                      <td className="py-2 px-2 text-xs text-gray-600">{formatDate(iss.issuedDate)}</td>
                      <td className="py-2 px-2 text-xs font-mono text-gray-500">{iss.materialCode}</td>
                      <td className="py-2 px-2 text-sm text-[#1F1D1B]">{iss.materialName}</td>
                      <td className="py-2 px-2 text-right text-sm">{iss.qty}</td>
                      <td className="py-2 px-2 text-center text-xs text-gray-500">{iss.unit}</td>
                      <td className="py-2 px-2 text-right text-sm">{formatCurrency(iss.unitCostSen)}</td>
                      <td className="py-2 px-2 text-right text-sm font-semibold">{formatCurrency(iss.totalCostSen)}</td>
                      <td className="py-2 px-2 text-xs text-gray-600">{iss.issuedBy}</td>
                      <td className="py-2 px-2 text-xs text-gray-500 max-w-[120px] truncate" title={iss.notes}>{iss.notes || "\u2014"}</td>
                      <td className="py-2 px-2 text-center">
                        <button
                          onClick={() => handleRemoveIssuance(iss.id)}
                          className="text-gray-300 hover:text-[#7A2E24] transition-colors"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t-2 border-[#E2DDD8] pt-3 flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  Total Material Issuance ({(project.materialIssuances || []).length} entries)
                </div>
                <div className="text-lg font-bold text-[#1F1D1B]">
                  {formatCurrency(materialCostSen)}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Labour Hours Log */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="h-4 w-4 text-gray-400" />
              Labour Hours Log
              {totalLabourHours > 0 && (
                <span className="text-xs font-normal text-gray-400">
                  ({totalLabourHours}h total)
                </span>
              )}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={openLabourModal} className="gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> Log Hours
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {(project.labourLogs || []).length === 0 ? (
            <div className="text-center py-8 text-gray-300 text-sm">
              No labour hours logged yet. Log hours to track R&D labour cost.
            </div>
          ) : (
            <div className="space-y-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Date</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Worker Name</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Department</th>
                    <th className="text-right py-2 px-2 text-xs font-semibold text-gray-500">Hours</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-gray-500">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {(project.labourLogs || []).map((log) => (
                    <tr key={log.id} className="border-b border-[#E2DDD8]/50 hover:bg-[#F0ECE9]/50">
                      <td className="py-2 px-2 text-xs text-gray-600">{formatDate(log.date)}</td>
                      <td className="py-2 px-2 text-sm font-medium text-[#1F1D1B]">{log.workerName}</td>
                      <td className="py-2 px-2 text-xs text-gray-500">{log.department}</td>
                      <td className="py-2 px-2 text-right text-sm font-medium">{log.hours}h</td>
                      <td className="py-2 px-2 text-xs text-gray-600">{log.description || "\u2014"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t-2 border-[#E2DDD8] pt-3 flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  Total Labour Hours ({(project.labourLogs || []).length} entries)
                </div>
                <div className="text-lg font-bold text-[#1F1D1B]">
                  {totalLabourHours}h
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Edit Project Modal ──────────────────────────────────────────── */}
      <ModalOverlay open={editOpen} onClose={() => setEditOpen(false)} title="Edit Project">
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Name</label>
            <input
              className={inputClass}
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={3}
              value={editForm.description}
              onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div>
            <label className={labelClass}>Project Type</label>
            <select
              className={selectClass}
              value={editForm.projectType}
              onChange={(e) =>
                setEditForm((f) => ({
                  ...f,
                  projectType: e.target.value as RDProject["projectType"],
                }))
              }
            >
              <option value="DEVELOPMENT">New Product Research</option>
              <option value="IMPROVEMENT">Improvement / Repair</option>
              <option value="CLONE">Clone / Replicate Competitor</option>
            </select>
          </div>
          {/* Clone source fieldset — mirrors the Create dialog fieldset.
              Switching projectType AWAY from CLONE wipes these on save
              (handleEditSave nulls them) so we don't carry stale data. */}
          {editForm.projectType === "CLONE" && (
            <div className="rounded-lg border border-dashed border-[#E2DDD8] bg-[#FBF9F6] p-3 space-y-3">
              <p className="text-xs text-gray-500">
                Source product info — what we bought to reverse-engineer.
              </p>
              <div>
                <label className={labelClass}>Source Product / Model Name</label>
                <input
                  className={inputClass}
                  value={editForm.sourceProductName}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, sourceProductName: e.target.value }))
                  }
                  placeholder="e.g. Comfy Recliner Pro"
                />
              </div>
              <div>
                <label className={labelClass}>Source Brand / Supplier</label>
                <input
                  className={inputClass}
                  value={editForm.sourceBrand}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, sourceBrand: e.target.value }))
                  }
                  placeholder="e.g. ABC Furniture Sdn Bhd"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Purchase Reference</label>
                  <input
                    className={inputClass}
                    value={editForm.sourcePurchaseRef}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, sourcePurchaseRef: e.target.value }))
                    }
                    placeholder="INV-2026-0421"
                  />
                </div>
                <div>
                  <label className={labelClass}>Purchase Price (RM)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    className={inputClass}
                    value={editForm.sourcePriceRM}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, sourcePriceRM: e.target.value }))
                    }
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Source Notes</label>
                <textarea
                  className={`${inputClass} resize-none`}
                  rows={3}
                  value={editForm.sourceNotes}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, sourceNotes: e.target.value }))
                  }
                  placeholder="Dimensions, key specs, why we want to copy..."
                />
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Category</label>
              <select
                className={selectClass}
                value={editForm.productCategory}
                onChange={(e) => setEditForm((f) => ({ ...f, productCategory: e.target.value as RDProject["productCategory"] }))}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Status</label>
              <select
                className={selectClass}
                value={editForm.status}
                onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value as RDProject["status"] }))}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Target Launch Date</label>
              <input
                type="date"
                className={inputClass}
                value={editForm.targetLaunchDate}
                onChange={(e) => setEditForm((f) => ({ ...f, targetLaunchDate: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelClass}>Budget (RM)</label>
              <input
                type="number"
                className={inputClass}
                min={0}
                step={0.01}
                value={editForm.totalBudget}
                onChange={(e) => setEditForm((f) => ({ ...f, totalBudget: parseFloat(e.target.value) || 0 }))}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Team Members (comma-separated)</label>
            <input
              className={inputClass}
              value={editForm.assignedTeamStr}
              onChange={(e) => setEditForm((f) => ({ ...f, assignedTeamStr: e.target.value }))}
              placeholder="Ahmad Razif, Tan Mei Ling"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleEditSave} disabled={editSaving}>
              {editSaving ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Add Prototype Modal ─────────────────────────────────────────── */}
      <ModalOverlay open={protoOpen} onClose={() => setProtoOpen(false)} title={`Add ${PROTO_TYPE_LABELS[protoForm.prototypeType]} Prototype`}>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Prototype Type</label>
              <select
                className={`${selectClass} bg-gray-50`}
                value={protoForm.prototypeType}
                disabled
              >
                <option value="FABRIC_SEWING">Fabric Sewing</option>
                <option value="FRAMING">Framing</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Version</label>
              <input
                className={`${inputClass} bg-gray-50`}
                value={protoForm.version}
                disabled
              />
            </div>
            <div>
              <label className={labelClass}>Date</label>
              <input
                type="date"
                className={inputClass}
                value={protoForm.createdDate}
                onChange={(e) => setProtoForm((f) => ({ ...f, createdDate: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={3}
              value={protoForm.description}
              onChange={(e) => setProtoForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Describe this prototype iteration..."
            />
          </div>
          <div>
            <label className={labelClass}>Labour Hours</label>
            <input
              type="number"
              className={inputClass}
              min={0}
              step={0.5}
              value={protoForm.labourHours}
              onChange={(e) => setProtoForm((f) => ({ ...f, labourHours: parseFloat(e.target.value) || 0 }))}
            />
          </div>
          {/* Improvements — only show if version > v1 */}
          {protoForm.version !== "v1" && (
            <div>
              <label className={labelClass}>Improvements (from previous version)</label>
              <textarea
                className={`${inputClass} resize-none`}
                rows={2}
                value={protoForm.improvements}
                onChange={(e) => setProtoForm((f) => ({ ...f, improvements: e.target.value }))}
                placeholder="What was improved from the previous version..."
              />
            </div>
          )}
          <div>
            <label className={labelClass}>Defects</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={2}
              value={protoForm.defects}
              onChange={(e) => setProtoForm((f) => ({ ...f, defects: e.target.value }))}
              placeholder="Known defects or shortcomings of this version..."
            />
          </div>
          <div>
            <label className={labelClass}>Test Results</label>
            <input
              className={inputClass}
              value={protoForm.testResults}
              onChange={(e) => setProtoForm((f) => ({ ...f, testResults: e.target.value }))}
              placeholder="Summary of testing outcomes..."
            />
          </div>
          <div>
            <label className={labelClass}>Feedback</label>
            <input
              className={inputClass}
              value={protoForm.feedback}
              onChange={(e) => setProtoForm((f) => ({ ...f, feedback: e.target.value }))}
              placeholder="Team / stakeholder feedback..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => setProtoOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleProtoSave} disabled={protoSaving}>
              {protoSaving ? "Adding..." : "Add Prototype"}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Add BOM Material Modal ────────────────────────────────────────── */}
      <ModalOverlay open={bomOpen} onClose={() => setBomOpen(false)} title="Add Raw Material to Production BOM">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Material Code</label>
              <input
                className={inputClass}
                value={bomForm.materialCode}
                onChange={(e) => setBomForm((f) => ({ ...f, materialCode: e.target.value }))}
                placeholder="e.g. RM-WD-001"
              />
            </div>
            <div>
              <label className={labelClass}>Material Name</label>
              <input
                className={inputClass}
                value={bomForm.materialName}
                onChange={(e) => setBomForm((f) => ({ ...f, materialName: e.target.value }))}
                placeholder="e.g. Plywood 18mm"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Quantity</label>
              <input
                type="number"
                className={inputClass}
                min={0.01}
                step={0.01}
                value={bomForm.qty}
                onChange={(e) => setBomForm((f) => ({ ...f, qty: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div>
              <label className={labelClass}>Unit</label>
              <select
                className={selectClass}
                value={bomForm.unit}
                onChange={(e) => setBomForm((f) => ({ ...f, unit: e.target.value }))}
              >
                <option value="PCS">PCS</option>
                <option value="METER">METER</option>
                <option value="ROLL">ROLL</option>
                <option value="KG">KG</option>
                <option value="BOX">BOX</option>
                <option value="SET">SET</option>
                <option value="SHEET">SHEET</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Unit Cost (RM)</label>
              <input
                type="number"
                className={inputClass}
                min={0}
                step={0.01}
                value={bomForm.unitCostRM}
                onChange={(e) => setBomForm((f) => ({ ...f, unitCostRM: parseFloat(e.target.value) || 0 }))}
              />
            </div>
          </div>
          {bomForm.qty > 0 && bomForm.unitCostRM > 0 && (
            <div className="bg-[#F0ECE9] rounded-lg p-3 flex items-center justify-between">
              <span className="text-sm text-gray-500">Line Total</span>
              <span className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(Math.round(bomForm.unitCostRM * bomForm.qty * 100))}</span>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => setBomOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleAddBomItem} disabled={bomSaving}>
              {bomSaving ? "Adding..." : "Add Material"}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Issue Material Modal ──────────────────────────────────────────── */}
      <ModalOverlay open={issuanceOpen} onClose={() => setIssuanceOpen(false)} title="Issue Raw Material" wide>
        <div className="space-y-4">
          {/* 2-step picker: Category (itemGroup) → Specific raw material */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Category</label>
              <select
                className={selectClass}
                value={rmCategory}
                onChange={(e) => {
                  setRmCategory(e.target.value);
                  // Reset the specific material whenever category changes
                  selectRawMaterialById("");
                }}
              >
                <option value="">-- Select category --</option>
                {rmCategoryOptions.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Raw Material</label>
              <select
                className={selectClass}
                value={issuanceForm.materialId}
                onChange={(e) => selectRawMaterialById(e.target.value)}
                disabled={!rmCategory}
              >
                <option value="">{rmCategory ? "-- Select material --" : "-- Pick a category first --"}</option>
                {rmInCategory.map((rm) => (
                  <option key={rm.id} value={rm.id}>
                    {rm.itemCode} — {rm.description} (balance: {rm.balanceQty} {rm.baseUOM})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {issuanceForm.materialId && (
            <div className="bg-[#F0ECE9] rounded-lg p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Selected:</span>
                <span className="font-medium">{issuanceForm.materialCode} - {issuanceForm.materialName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Balance Available:</span>
                <span className="font-medium">{issuanceForm.balanceQty} {issuanceForm.unit}</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Quantity</label>
              <input
                type="number"
                className={inputClass}
                min={0.01}
                step={0.01}
                value={issuanceForm.qty}
                onChange={(e) => setIssuanceForm((f) => ({ ...f, qty: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div>
              <label className={labelClass}>Unit</label>
              <input
                className={`${inputClass} bg-gray-50`}
                value={issuanceForm.unit}
                disabled
                placeholder="Auto-filled"
              />
            </div>
            <div>
              <label className={labelClass}>Unit Cost (RM)</label>
              <input
                type="number"
                className={inputClass}
                min={0}
                step={0.01}
                value={issuanceForm.unitCostRM}
                onChange={(e) => setIssuanceForm((f) => ({ ...f, unitCostRM: parseFloat(e.target.value) || 0 }))}
                placeholder="FIFO estimated"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Issued By</label>
              <input
                className={inputClass}
                value={issuanceForm.issuedBy}
                onChange={(e) => setIssuanceForm((f) => ({ ...f, issuedBy: e.target.value }))}
                placeholder="R&D person name"
              />
            </div>
            <div>
              <label className={labelClass}>Notes</label>
              <input
                className={inputClass}
                value={issuanceForm.notes}
                onChange={(e) => setIssuanceForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes..."
              />
            </div>
          </div>

          {issuanceForm.qty > 0 && issuanceForm.unitCostRM > 0 && (
            <div className="bg-[#F0ECE9] rounded-lg p-3 flex items-center justify-between">
              <span className="text-sm text-gray-500">Line Total</span>
              <span className="text-lg font-bold text-[#1F1D1B]">{formatCurrency(Math.round(issuanceForm.unitCostRM * issuanceForm.qty * 100))}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => setIssuanceOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleIssueMaterial} disabled={issuanceSaving}>
              {issuanceSaving ? "Issuing..." : "Issue Material"}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      {/* ─── Log Labour Hours Modal ────────────────────────────────────────── */}
      <ModalOverlay open={labourOpen} onClose={() => setLabourOpen(false)} title="Log Labour Hours">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Date</label>
              <input
                type="date"
                className={inputClass}
                value={labourForm.date}
                onChange={(e) => setLabourForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
            <div>
              <label className={labelClass}>Worker Name</label>
              <input
                className={inputClass}
                value={labourForm.workerName}
                onChange={(e) => setLabourForm((f) => ({ ...f, workerName: e.target.value }))}
                placeholder="e.g. Ahmad Razif"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Department</label>
              <input
                className={inputClass}
                value={labourForm.department}
                onChange={(e) => setLabourForm((f) => ({ ...f, department: e.target.value }))}
                placeholder="e.g. R&D"
              />
            </div>
            <div>
              <label className={labelClass}>Hours</label>
              <input
                type="number"
                className={inputClass}
                min={0.5}
                step={0.5}
                value={labourForm.hours}
                onChange={(e) => setLabourForm((f) => ({ ...f, hours: parseFloat(e.target.value) || 0 }))}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              className={`${inputClass} resize-none`}
              rows={3}
              value={labourForm.description}
              onChange={(e) => setLabourForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What work was done..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
            <Button variant="ghost" onClick={() => setLabourOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleLogLabour} disabled={labourSaving}>
              {labourSaving ? "Logging..." : "Log Hours"}
            </Button>
          </div>
        </div>
      </ModalOverlay>
    </div>
  );
}
