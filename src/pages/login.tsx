import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    // For demo, redirect directly to dashboard
    window.location.href = "/dashboard";
  };

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes orbit1 {
          0% { transform: rotate(0deg) translateX(150px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(150px) rotate(-360deg); }
        }
        @keyframes orbit2 {
          0% { transform: rotate(0deg) translateX(225px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(225px) rotate(-360deg); }
        }
        @keyframes orbit3 {
          0% { transform: rotate(0deg) translateX(300px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(300px) rotate(-360deg); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .btn-shimmer {
          position: relative;
          overflow: hidden;
        }
        .btn-shimmer::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255,255,255,0.15),
            transparent
          );
          transform: translateX(-100%);
        }
        .btn-shimmer:hover::after {
          animation: shimmer 1.5s ease-in-out;
        }
        .login-input:focus {
          border-color: #6B5C32 !important;
          box-shadow: 0 0 0 3px rgba(107,92,50,0.2);
          outline: none;
        }
        .orbit-dot {
          width: 6px;
          height: 6px;
          background: #6B5C32;
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
        }
      `}</style>

      <div className="flex min-h-screen">
        {/* Left Panel - Login Form */}
        <div
          className="flex w-full lg:w-1/2 items-center justify-center p-8 relative"
          style={{
            backgroundColor: "#1F1D1B",
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(107,92,50,.06) 0 1px, transparent 1px 60px), repeating-linear-gradient(90deg, rgba(107,92,50,.06) 0 1px, transparent 1px 60px)",
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl p-10"
            style={{
              backgroundColor: "rgba(255,255,255,.04)",
              border: "1px solid rgba(107,92,50,.2)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
            }}
          >
            {/* Logo Row */}
            <div className="flex items-center gap-3 mb-10">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-lg"
                style={{
                  border: "1.5px solid rgba(107,92,50,.5)",
                  backgroundColor: "rgba(107,92,50,.1)",
                }}
              >
                <span className="text-lg font-bold text-white">H</span>
              </div>
              <span
                className="text-white font-bold"
                style={{ fontSize: "22px", letterSpacing: "3px" }}
              >
                HOOKKA
              </span>
            </div>

            {/* Title */}
            <h2 className="text-2xl font-bold text-white mb-1">
              Welcome back
            </h2>
            <p
              className="mb-8"
              style={{
                color: "rgba(255,255,255,.45)",
                fontSize: "13px",
              }}
            >
              Sign in to your manufacturing intelligence platform
            </p>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="email"
                  className="block mb-2 uppercase font-medium"
                  style={{
                    color: "rgba(255,255,255,.5)",
                    fontSize: "12px",
                    letterSpacing: "0.05em",
                  }}
                >
                  Email Address
                </label>
                <input
                  id="email"
                  type="text"
                  placeholder="you@hookka.com.my"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="login-input w-full rounded-lg px-4 py-3 text-white transition-all duration-200"
                  style={{
                    backgroundColor: "rgba(255,255,255,.06)",
                    border: "1.5px solid rgba(107,92,50,.3)",
                    fontSize: "14px",
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block mb-2 uppercase font-medium"
                  style={{
                    color: "rgba(255,255,255,.5)",
                    fontSize: "12px",
                    letterSpacing: "0.05em",
                  }}
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="login-input w-full rounded-lg px-4 py-3 text-white transition-all duration-200"
                  style={{
                    backgroundColor: "rgba(255,255,255,.06)",
                    border: "1.5px solid rgba(107,92,50,.3)",
                    fontSize: "14px",
                  }}
                />
              </div>

              {/* Remember me + Forgot password */}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded"
                    style={{ accentColor: "#6B5C32" }}
                  />
                  <span
                    style={{
                      color: "rgba(255,255,255,.45)",
                      fontSize: "13px",
                    }}
                  >
                    Remember me
                  </span>
                </label>
                <a
                  href="#"
                  className="hover:underline"
                  style={{
                    color: "#8B7A4E",
                    fontSize: "13px",
                  }}
                >
                  Forgot Password?
                </a>
              </div>

              {/* Sign In Button */}
              <button
                type="submit"
                disabled={loading}
                className="btn-shimmer w-full rounded-lg font-semibold text-white transition-all duration-200 hover:opacity-90 disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, #6B5C32, #8B7A4E)",
                  padding: "14px",
                  fontSize: "15px",
                }}
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>
          </div>

          {/* Footer */}
          <div
            className="absolute bottom-6 left-0 right-0 text-center"
            style={{
              color: "rgba(255,255,255,.25)",
              fontSize: "11px",
              letterSpacing: "0.03em",
            }}
          >
            HOOKKA INDUSTRIES SDN BHD &bull; 202501060540 (1661946-X)
          </div>
        </div>

        {/* Right Panel - Brand Side */}
        <div
          className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden"
          style={{
            backgroundColor: "#1F1D1B",
            backgroundImage:
              "radial-gradient(ellipse at center, rgba(107,92,50,.08) 0%, transparent 70%)",
          }}
        >
          {/* Orbit Rings */}
          <div
            className="absolute rounded-full"
            style={{
              width: "300px",
              height: "300px",
              border: "1px solid rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: "450px",
              height: "450px",
              border: "1px solid rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: "600px",
              height: "600px",
              border: "1px dashed rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />

          {/* Orbit Dots */}
          <div
            className="absolute"
            style={{
              top: "50%",
              left: "50%",
              width: 0,
              height: 0,
            }}
          >
            <div
              className="orbit-dot"
              style={{ animation: "orbit1 12s linear infinite" }}
            />
            <div
              className="orbit-dot"
              style={{ animation: "orbit2 18s linear infinite reverse" }}
            />
            <div
              className="orbit-dot"
              style={{ animation: "orbit3 25s linear infinite" }}
            />
          </div>

          {/* Center Content */}
          <div className="relative z-10 flex flex-col items-center text-center">
            {/* Logo Hexagon */}
            <div className="relative mb-6" style={{ width: "100px", height: "100px" }}>
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{
                  border: "1.5px solid rgba(107,92,50,.4)",
                  borderRadius: "16px",
                  transform: "rotate(45deg)",
                }}
              >
                <span
                  className="font-bold text-white"
                  style={{
                    fontSize: "42px",
                    transform: "rotate(-45deg)",
                  }}
                >
                  H
                </span>
              </div>
            </div>

            {/* Brand Name */}
            <h1
              className="text-white mb-2"
              style={{
                fontSize: "42px",
                fontWeight: 900,
                letterSpacing: "6px",
              }}
            >
              HOOKKA
            </h1>

            {/* Tagline */}
            <p
              className="uppercase mb-6"
              style={{
                color: "#8B7A4E",
                fontSize: "13px",
                letterSpacing: "4px",
              }}
            >
              Manufacturing Intelligence Platform
            </p>

            {/* Gold Divider */}
            <div
              className="mb-6"
              style={{
                width: "60px",
                height: "1px",
                background:
                  "linear-gradient(90deg, transparent, #6B5C32, transparent)",
              }}
            />

            {/* Badge */}
            <div
              className="mb-10 px-4 py-1.5 rounded-full"
              style={{
                border: "1px solid rgba(107,92,50,.4)",
                color: "#8B7A4E",
                fontSize: "11px",
                letterSpacing: "3px",
              }}
            >
              INDUSTRY 4.0
            </div>

            {/* Stats Row */}
            <div className="flex gap-10">
              <div className="text-center">
                <div className="text-2xl font-bold text-white">156</div>
                <div
                  style={{
                    color: "rgba(255,255,255,.3)",
                    fontSize: "10px",
                    letterSpacing: "0.05em",
                  }}
                  className="uppercase mt-1"
                >
                  Active PO
                </div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-white">8</div>
                <div
                  style={{
                    color: "rgba(255,255,255,.3)",
                    fontSize: "10px",
                    letterSpacing: "0.05em",
                  }}
                  className="uppercase mt-1"
                >
                  Departments
                </div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-white">99.7%</div>
                <div
                  style={{
                    color: "rgba(255,255,255,.3)",
                    fontSize: "10px",
                    letterSpacing: "0.05em",
                  }}
                  className="uppercase mt-1"
                >
                  Uptime
                </div>
              </div>
            </div>
          </div>

          {/* Corner Floating Text - Top Left */}
          <div
            className="absolute"
            style={{
              top: "24px",
              left: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            HOOKKA INDUSTRIES
          </div>

          {/* Corner Floating Text - Top Right */}
          <div
            className="absolute flex items-center gap-2"
            style={{
              top: "24px",
              right: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            <span
              className="inline-block rounded-full"
              style={{
                width: "6px",
                height: "6px",
                backgroundColor: "#22c55e",
                animation: "blink 2s ease-in-out infinite",
              }}
            />
            SYSTEM ONLINE
          </div>

          {/* Corner Floating Text - Bottom Left */}
          <div
            className="absolute"
            style={{
              bottom: "24px",
              left: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            ERP v2.0 // 2026
          </div>

          {/* Corner Floating Text - Bottom Right */}
          <div
            className="absolute"
            style={{
              bottom: "24px",
              right: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            ISO 9001:2015
          </div>
        </div>
      </div>
    </>
  );
}
