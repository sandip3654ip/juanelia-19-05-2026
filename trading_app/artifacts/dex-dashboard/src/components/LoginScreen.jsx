import { useState, useRef, useEffect } from "react";
import { Zap, Shield, Smartphone } from "lucide-react";

export default function LoginScreen({ onLogin }) {
  const [phone, setPhone]       = useState("");
  const [otp, setOtp]           = useState("");
  const [step, setStep]         = useState("phone"); // "phone" | "otp"
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [countdown, setCountdown] = useState(0);
  const otpRef   = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (countdown <= 0) return;
    timerRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(timerRef.current); return 0; }
        return c - 1;
      });
    }, 1_000);
    return () => clearInterval(timerRef.current);
  }, [countdown]);

  async function sendOtp() {
    if (phone.trim().length < 10) { setError("Enter a valid 10-digit number"); return; }
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setStep("otp");
      setCountdown(30);
      setTimeout(() => otpRef.current?.focus(), 80);
    } catch (e) {
      setError(e.message ?? "Failed to send OTP");
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp() {
    if (otp.trim().length < 6) { setError("Enter the 6-digit OTP"); return; }
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp: otp.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      localStorage.setItem("mm_token", d.token);
      onLogin();
    } catch (e) {
      setError(e.message ?? "Verification failed");
      setOtp("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#0a0c10",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0 16px",
    }}>
      {/* Background grid pattern */}
      <div style={{
        position: "absolute", inset: 0, opacity: 0.04,
        backgroundImage: "linear-gradient(#22c55e 1px,transparent 1px),linear-gradient(90deg,#22c55e 1px,transparent 1px)",
        backgroundSize: "40px 40px",
        pointerEvents: "none",
      }} />

      <div style={{
        width: "100%", maxWidth: 380,
        background: "#111318",
        border: "1px solid #1e2330",
        borderRadius: 16,
        padding: "32px 28px",
        boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(34,197,94,0.06)",
        position: "relative",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "rgba(34,197,94,0.08)",
            border: "1px solid rgba(34,197,94,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <Zap size={22} color="#22c55e" />
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: "#f0f4f8", letterSpacing: -0.5 }}>
              MONEY MACHINE
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#4a5568", letterSpacing: 2, textTransform: "uppercase", marginTop: 1 }}>
              Secure Access Portal
            </div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <Shield size={16} color="#374151" />
          </div>
        </div>

        {/* Step header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>
            {step === "phone" ? "Enter your mobile number" : "Verify OTP"}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
            {step === "phone"
              ? "OTP will be sent to your registered number only"
              : `6-digit OTP sent to ••••••${phone.slice(-4)} · Valid for 5 minutes`}
          </div>
        </div>

        {/* Phone input */}
        {step === "phone" && (
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 11, fontWeight: 600, color: "#9ca3af",
              marginBottom: 8, textTransform: "uppercase", letterSpacing: 1,
            }}>
              <Smartphone size={11} />
              Mobile Number
            </label>
            <div style={{ position: "relative" }}>
              <span style={{
                position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
                fontSize: 14, fontWeight: 600, color: "#4b5563",
                borderRight: "1px solid #1e2330", paddingRight: 10,
              }}>+91</span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={phone}
                onChange={e => { setPhone(e.target.value.replace(/\D/g, "")); setError(""); }}
                onKeyDown={e => e.key === "Enter" && sendOtp()}
                placeholder="9XXXXXXXXX"
                autoFocus
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "12px 14px 12px 68px",
                  background: "#0d1117",
                  border: `1px solid ${error ? "#ef4444" : "#1e2330"}`,
                  borderRadius: 10,
                  color: "#f0f4f8",
                  fontSize: 16, fontWeight: 600, outline: "none",
                  fontFamily: "'Courier New', monospace",
                  letterSpacing: 2,
                  transition: "border-color 0.15s",
                }}
                onFocus={e => { if (!error) e.target.style.borderColor = "#22c55e40"; }}
                onBlur={e => { if (!error) e.target.style.borderColor = "#1e2330"; }}
              />
            </div>
          </div>
        )}

        {/* OTP input */}
        {step === "otp" && (
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: "block", fontSize: 11, fontWeight: 600, color: "#9ca3af",
              marginBottom: 8, textTransform: "uppercase", letterSpacing: 1,
            }}>
              One-Time Password
            </label>
            <input
              ref={otpRef}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={e => { setOtp(e.target.value.replace(/\D/g, "")); setError(""); }}
              onKeyDown={e => e.key === "Enter" && verifyOtp()}
              placeholder="______"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "14px",
                background: "#0d1117",
                border: `1px solid ${error ? "#ef4444" : "#1e2330"}`,
                borderRadius: 10,
                color: "#22c55e",
                fontSize: 28, fontWeight: 800, outline: "none",
                textAlign: "center",
                letterSpacing: 12,
                fontFamily: "'Courier New', monospace",
                transition: "border-color 0.15s",
              }}
              onFocus={e => { if (!error) e.target.style.borderColor = "#22c55e40"; }}
              onBlur={e => { if (!error) e.target.style.borderColor = "#1e2330"; }}
            />
            {/* OTP progress dots */}
            <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 10 }}>
              {[0,1,2,3,4,5].map(i => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: i < otp.length ? "#22c55e" : "#1e2330",
                  transition: "background 0.1s",
                }} />
              ))}
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div style={{
            padding: "10px 12px", borderRadius: 8, marginBottom: 14,
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.3)",
            fontSize: 12, color: "#f87171", fontWeight: 500, lineHeight: 1.4,
          }}>
            ⚠ {error}
          </div>
        )}

        {/* Primary CTA */}
        <button
          onClick={step === "phone" ? sendOtp : verifyOtp}
          disabled={loading || (step === "phone" && phone.length < 10) || (step === "otp" && otp.length < 6)}
          style={{
            width: "100%", padding: "13px",
            background: loading
              ? "#1a2030"
              : ((step === "phone" && phone.length < 10) || (step === "otp" && otp.length < 6))
              ? "#151c28"
              : "#22c55e",
            color: loading ? "#4b5563" : ((step === "phone" && phone.length < 10) || (step === "otp" && otp.length < 6)) ? "#374151" : "#000",
            border: "none", borderRadius: 10,
            fontSize: 14, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer",
            transition: "all 0.15s",
            letterSpacing: 0.5,
          }}
        >
          {loading
            ? "Please wait…"
            : step === "phone"
            ? "Send OTP →"
            : "Verify & Login →"}
        </button>

        {/* Resend / Back */}
        {step === "otp" && (
          <div style={{ marginTop: 16, textAlign: "center" }}>
            {countdown > 0 ? (
              <span style={{ fontSize: 12, color: "#4b5563" }}>
                Resend OTP in <strong style={{ color: "#6b7280" }}>{countdown}s</strong>
              </span>
            ) : (
              <button
                onClick={() => { setStep("phone"); setOtp(""); setError(""); }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: 12, color: "#22c55e", fontWeight: 600,
                  padding: 0,
                }}
              >
                ← Change number / Resend OTP
              </button>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #1e2330", textAlign: "center" }}>
          <span style={{ fontSize: 11, color: "#374151" }}>
            Access restricted to registered users only
          </span>
        </div>
      </div>
    </div>
  );
}
