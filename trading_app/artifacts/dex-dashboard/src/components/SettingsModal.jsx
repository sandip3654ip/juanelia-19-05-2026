import { useState, useEffect, useCallback, useRef } from "react";
import { Settings, X, Eye, EyeOff, Check, AlertCircle, ChevronDown, ChevronUp, Info, Save, Globe } from "lucide-react";
import { toast } from "sonner";
import { ExchangeIcon } from "./ExchangeIcon";

const KEY_META = {
  BINANCE_API_KEY:       { label: "API Key",    hint: "Read + Spot Trade permissions required" },
  BINANCE_API_SECRET:    { label: "API Secret", hint: "Keep this private and never share" },
  BYBIT_API_KEY:         { label: "API Key",    hint: "Read + Trade permissions required" },
  BYBIT_API_SECRET:      { label: "API Secret", hint: "Keep this private and never share" },
  KUCOIN_API_KEY:        { label: "API Key",    hint: "Read + Trade permissions required" },
  KUCOIN_API_SECRET:     { label: "API Secret", hint: "Keep this private and never share" },
  KUCOIN_API_PASSPHRASE: { label: "Passphrase", hint: "Set when you created the API key" },
  BITGET_API_KEY:        { label: "API Key",    hint: "Read + Trade permissions required" },
  BITGET_API_SECRET:     { label: "API Secret", hint: "Keep this private and never share" },
  BITGET_API_PASSPHRASE: { label: "Passphrase", hint: "Set when you created the API key" },
  COINSWITCH_API_KEY:    { label: "API Key",    hint: "From CoinSwitch Pro dashboard" },
  COINSWITCH_API_SECRET: { label: "API Secret", hint: "Keep this private and never share" },
  TELEGRAM_BOT_TOKEN:    { label: "Bot Token",  hint: "Get from @BotFather on Telegram" },
  TELEGRAM_CHAT_ID:      { label: "Chat ID",    hint: "Your personal or group chat ID" },
};

// Groups shown per page
const FUNDING_GROUP_IDS = ["coinswitch", "telegram"];
const SPOT_GROUP_IDS    = ["binance", "bybit", "kucoin", "bitget", "telegram"];

// Public DEX exchanges (no API keys needed) — shown only in Funding Arb
const PUBLIC_EXCHANGES = [
  { id: "pi42",  label: "Pi42",      note: "Public WebSocket API — no keys needed" },
  { id: "aster", label: "Aster DEX", note: "Public WebSocket API — no keys needed" },
  { id: "delta", label: "Delta",     note: "Public WebSocket API — no keys needed" },
];

// ── CredentialInput ─────────────────────────────────────────────────────────

function CredentialInput({ envKey, status, value, onChange }) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const meta = KEY_META[envKey] ?? { label: envKey, hint: "" };
  const isSecret = envKey.toLowerCase().includes("secret") ||
    envKey.toLowerCase().includes("token") ||
    envKey.toLowerCase().includes("passphrase");
  const isConfigured = status?.configured;
  const isClear = value === "\x00clear";
  const isDirty = value !== "" && !isClear;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[11px] font-bold uppercase tracking-widest"
          style={{ color: "var(--app-text-dimmer)" }}>
          {meta.label}
        </label>
        <div className="flex items-center gap-1.5">
          {isConfigured && !isDirty && !isClear && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{
                background: status.source === "file" ? "var(--app-success-soft)" : "var(--app-warning-soft)",
                color: status.source === "file" ? "var(--app-success)" : "var(--app-warning)",
              }}>
              {status.source === "file" ? "✓ SAVED" : "ENV"}
            </span>
          )}
          {isDirty && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ background: "rgba(96,165,250,0.15)", color: "#60a5fa" }}>
              EDITING
            </span>
          )}
          {isClear && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ background: "var(--app-danger-soft)", color: "var(--app-danger)" }}>
              WILL CLEAR
            </span>
          )}
        </div>
      </div>

      <div className="relative">
        <input
          type={visible ? "text" : "password"}
          className="w-full rounded-lg px-3 py-2.5 text-xs font-mono"
          style={{
            paddingRight: isSecret ? "2.5rem" : "0.75rem",
            background: isClear ? "var(--app-danger-soft)" : isDirty ? "rgba(96,165,250,0.06)" : "var(--app-surface-1)",
            border: `1px solid ${focused ? "var(--app-success)" : isClear ? "var(--app-danger-border)" : isDirty ? "rgba(96,165,250,0.4)" : "var(--app-border-1)"}`,
            color: "var(--app-text-primary)",
            outline: "none",
            transition: "border-color 0.15s",
            boxShadow: focused ? `0 0 0 3px ${isClear ? "var(--app-danger)" : "var(--app-success)"}18` : "none",
          }}
          placeholder={isConfigured && !isDirty && !isClear ? status.masked : `Enter ${meta.label.toLowerCase()}…`}
          value={isClear ? "" : value}
          onChange={(e) => onChange(envKey, e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoComplete="new-password"
          spellCheck={false}
        />
        {isSecret && (
          <button type="button" onClick={() => setVisible((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded"
            style={{ color: "var(--app-text-dimmer)", minHeight: "auto", background: "none", border: "none", cursor: "pointer" }}>
            {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between">
        {meta.hint && (
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>{meta.hint}</span>
        )}
        {isConfigured && !isDirty && !isClear && (
          <button type="button" onClick={() => onChange(envKey, "\x00clear")}
            className="text-[9px] font-bold ml-auto"
            style={{ color: "var(--app-danger)", background: "none", border: "none", padding: 0, cursor: "pointer" }}>
            × Remove
          </button>
        )}
        {isClear && (
          <button type="button" onClick={() => onChange(envKey, "")}
            className="text-[9px] font-bold ml-auto"
            style={{ color: "#60a5fa", background: "none", border: "none", padding: 0, cursor: "pointer" }}>
            ↩ Undo
          </button>
        )}
      </div>
    </div>
  );
}

// ── PublicExchangeCard ───────────────────────────────────────────────────────

function PublicExchangeCard({ exch }) {
  return (
    <div className="rounded-xl overflow-hidden flex-shrink-0"
      style={{ border: "1px solid var(--app-border-1)", background: "var(--app-surface-0)" }}>
      <div className="flex items-center gap-3 px-4 py-3"
        style={{ background: "var(--app-surface-1)" }}>
        <div className="flex-shrink-0">
          <ExchangeIcon name={exch.id} size={30} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-sm" style={{ color: "var(--app-text-bright)" }}>
              {exch.label}
            </span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ background: "rgba(96,165,250,0.12)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.25)" }}>
              PUBLIC
            </span>
          </div>
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>
            {exch.note}
          </span>
        </div>
        <Globe className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#60a5fa" }} />
      </div>
    </div>
  );
}

// ── ExchangeGroupCard ────────────────────────────────────────────────────────

function ExchangeGroupCard({ group, credentials, values, onChange, onSave, saving, isOpen, onToggle }) {
  const cardRef = useRef(null);
  const configuredCount = group.keys.filter((k) => credentials[k]?.configured).length;
  const allConfigured   = configuredCount === group.keys.length;
  const hasChanges      = group.keys.some((k) => values[k] !== undefined && values[k] !== "");

  const borderCol = allConfigured
    ? "var(--app-success-border)"
    : configuredCount > 0 ? "var(--app-warning-border)"
    : "var(--app-border-1)";

  useEffect(() => {
    if (isOpen && cardRef.current) {
      setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
    }
  }, [isOpen]);

  return (
    <div ref={cardRef} className="rounded-xl overflow-hidden flex-shrink-0"
      style={{ border: `1px solid ${borderCol}`, background: "var(--app-surface-0)" }}>

      {/* Header */}
      <button className="w-full flex items-center gap-3 px-4 py-3 text-left"
        onClick={onToggle}
        style={{ background: "var(--app-surface-1)", cursor: "pointer", minHeight: 56 }}>
        <div className="flex-shrink-0">
          <ExchangeIcon name={group.id} size={30} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold text-sm leading-tight" style={{ color: "var(--app-text-bright)" }}>
              {group.label}
            </span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{
                background: allConfigured ? "var(--app-success-soft)"
                  : configuredCount > 0 ? "var(--app-warning-soft)" : "var(--app-surface-2)",
                color: allConfigured ? "var(--app-success)"
                  : configuredCount > 0 ? "var(--app-warning)" : "var(--app-text-dimmer)",
              }}>
              {configuredCount}/{group.keys.length} set
            </span>
          </div>
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>
            {allConfigured
              ? "✓ All credentials configured"
              : configuredCount > 0
              ? `${group.keys.length - configuredCount} credential${group.keys.length - configuredCount > 1 ? "s" : ""} missing`
              : "Not configured — click to set up"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {allConfigured
            ? <Check className="h-3.5 w-3.5" style={{ color: "var(--app-success)" }} />
            : <AlertCircle className="h-3.5 w-3.5"
                style={{ color: configuredCount > 0 ? "var(--app-warning)" : "var(--app-text-dimmer)" }} />
          }
          {isOpen
            ? <ChevronUp  className="h-4 w-4" style={{ color: "var(--app-text-muted)" }} />
            : <ChevronDown className="h-4 w-4" style={{ color: "var(--app-text-muted)" }} />
          }
        </div>
      </button>

      {/* Expanded fields */}
      {isOpen && (
        <div className="px-4 pt-4 pb-4 flex flex-col gap-4"
          style={{ background: "var(--app-surface-0)", borderTop: `1px solid ${borderCol}` }}>
          {group.keys.map((k) => (
            <CredentialInput
              key={k}
              envKey={k}
              status={credentials[k]}
              value={values[k] ?? ""}
              onChange={onChange}
            />
          ))}
          <button
            disabled={saving || !hasChanges}
            onClick={() => onSave(group.keys)}
            className="flex items-center justify-center gap-1.5 w-full py-3 rounded-xl text-xs font-extrabold transition-all mt-1"
            style={{
              background: hasChanges ? "var(--app-success)" : "var(--app-surface-2)",
              color:      hasChanges ? "#000" : "var(--app-text-dimmer)",
              opacity:    saving ? 0.6 : 1,
              cursor:     saving || !hasChanges ? "not-allowed" : "pointer",
              letterSpacing: "0.03em",
            }}>
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving…" : hasChanges ? `Save ${group.label}` : "No Changes"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── SettingsModal ────────────────────────────────────────────────────────────

export function SettingsModal({ onClose, topPage }) {
  const [groups, setGroups]           = useState([]);
  const [credentials, setCredentials] = useState({});
  const [values, setValues]           = useState({});
  const [savingGroup, setSavingGroup] = useState(null);
  const [loading, setLoading]         = useState(true);
  const [openId, setOpenId]           = useState(null);

  const isSpot     = topPage === "spot";
  const visibleIds = isSpot ? SPOT_GROUP_IDS : FUNDING_GROUP_IDS;

  useEffect(() => {
    fetch("/api/settings/credentials")
      .then((r) => r.json())
      .then(({ groups: g, credentials: c }) => {
        setGroups(g ?? []);
        setCredentials(c ?? {});
        // Auto-open first unconfigured group
        const visible = (g ?? []).filter((gr) => visibleIds.includes(gr.id));
        const firstIncomplete = visible.find(
          (gr) => gr.keys.some((k) => !(c ?? {})[k]?.configured)
        );
        if (firstIncomplete) setOpenId(firstIncomplete.id);
      })
      .catch(() => toast.error("Failed to load settings"))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = useCallback((key, val) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  }, []);

  const handleSave = useCallback(async (keys) => {
    const firstKey = keys[0];
    setSavingGroup(firstKey);
    const payload = {};
    for (const k of keys) {
      const v = values[k];
      if (v === undefined) continue;
      if (v === "\x00clear") { payload[k] = ""; }
      else if (v !== "")    { payload[k] = v; }
    }
    if (Object.keys(payload).length === 0) { setSavingGroup(null); return; }

    try {
      const res = await fetch("/api/settings/credentials", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setValues((prev) => {
        const next = { ...prev };
        for (const k of keys) delete next[k];
        return next;
      });
      const refreshed = await fetch("/api/settings/credentials").then((r) => r.json());
      setCredentials(refreshed.credentials ?? {});
      toast.success(`${data.updated.length} credential${data.updated.length > 1 ? "s" : ""} saved`);
    } catch (err) {
      toast.error(err.message ?? "Failed to save credentials");
    } finally {
      setSavingGroup(null);
    }
  }, [values]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const visibleGroups = groups.filter((g) => visibleIds.includes(g.id));

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
        onClick={onClose}
      />

      {/* Centered modal */}
      <div className="fixed z-50 flex flex-col"
        style={{
          top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(520px, 96vw)",
          maxHeight: "88vh",
          background: "var(--app-bg)",
          border: "1px solid var(--app-border-1)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--app-border-1)", borderRadius: "16px 16px 0 0", background: "var(--app-header-bg)" }}>
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg"
              style={{ background: "var(--app-success-soft)", border: "1px solid var(--app-success-border)" }}>
              <Settings className="h-4 w-4" style={{ color: "var(--app-success)" }} />
            </div>
            <div className="flex flex-col leading-none gap-0.5">
              <span className="font-extrabold text-sm" style={{ color: "var(--app-text-bright)" }}>
                API Settings
              </span>
              <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                {isSpot ? "Spot Arb — Exchange Credentials" : "Funding Arb — Exchange Credentials"}
              </span>
            </div>
          </div>
          <button onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-full"
            style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)" }}>
            <X className="h-3.5 w-3.5" style={{ color: "var(--app-text-muted)" }} />
          </button>
        </div>

        {/* Context info strip */}
        <div className="px-4 py-2.5 flex items-start gap-2 flex-shrink-0"
          style={{
            background: isSpot ? "rgba(251,191,36,0.06)" : "rgba(96,165,250,0.06)",
            borderBottom: `1px solid ${isSpot ? "rgba(251,191,36,0.18)" : "rgba(96,165,250,0.18)"}`,
          }}>
          <Info className="h-3 w-3 flex-shrink-0 mt-0.5"
            style={{ color: isSpot ? "var(--app-warning)" : "#60a5fa" }} />
          <span className="text-[10px] leading-relaxed"
            style={{ color: isSpot ? "var(--app-warning)" : "#93c5fd" }}>
            {isSpot
              ? "Spot trading credentials — used for Wallet balances, deposit addresses, and trade execution."
              : "Pi42, Aster & Delta use public APIs — no keys needed. Only CoinSwitch requires API credentials for order placement."
            }
          </span>
        </div>

        {/* Scrollable cards */}
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3"
          style={{ WebkitOverflowScrolling: "touch" }}>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3">
                <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
                  style={{ borderColor: "var(--app-success)", borderTopColor: "transparent" }} />
                <span className="text-xs" style={{ color: "var(--app-text-muted)" }}>Loading credentials…</span>
              </div>
            </div>
          ) : (
            <>
              {/* Funding Arb — show public DEX exchanges at top */}
              {!isSpot && PUBLIC_EXCHANGES.map((exch) => (
                <PublicExchangeCard key={exch.id} exch={exch} />
              ))}

              {/* Configurable exchange groups */}
              {visibleGroups.map((group) => (
                <ExchangeGroupCard
                  key={group.id}
                  group={group}
                  credentials={credentials}
                  values={values}
                  onChange={handleChange}
                  onSave={handleSave}
                  saving={savingGroup === group.keys[0]}
                  isOpen={openId === group.id}
                  onToggle={() => setOpenId((prev) => prev === group.id ? null : group.id)}
                />
              ))}

              {visibleGroups.length === 0 && !loading && (
                <div className="flex flex-col items-center gap-2 py-12">
                  <AlertCircle className="h-8 w-8" style={{ color: "var(--app-text-dimmer)" }} />
                  <span className="text-sm" style={{ color: "var(--app-text-muted)" }}>No credentials to configure</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 flex-shrink-0"
          style={{ borderTop: "1px solid var(--app-border-0)", background: "var(--app-surface-1)", borderRadius: "0 0 16px 16px" }}>
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>
            Credentials are stored on the server and take effect immediately — no restart required.
          </span>
        </div>
      </div>
    </>
  );
}
