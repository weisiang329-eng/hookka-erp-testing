// ComingSoon — Phase-1 placeholder screen so every nav link resolves to a real
// route. Phase 2 replaces these with the actual module list/detail screens.
import { useNavigate } from "react-router-dom";
import { Hammer } from "lucide-react";
import { MobileHeader } from "../components";
import { M } from "../theme";

export function ComingSoon({ title }: { title: string }) {
  const navigate = useNavigate();
  return (
    <>
      <MobileHeader title={title} onBack={() => navigate(-1)} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: "80px 24px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            backgroundColor: "#F0EAD8",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Hammer size={28} strokeWidth={1.75} color={M.taupe} />
        </div>
        <div style={{ fontSize: 17, fontWeight: 700, color: M.raisin }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: M.muted, maxWidth: 260 }}>
          This screen arrives in the next phase of the mobile app. The desktop
          version is fully available.
        </div>
      </div>
    </>
  );
}
