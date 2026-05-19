import { useState, useEffect, useCallback, useRef } from "react";
import {
  Settings2, KeyRound, Save, CheckCircle2, Eye, EyeOff,
  Check, AlertCircle, ChevronDown, ChevronUp, Info, X,
} from "lucide-react";
import { toast } from "sonner";
import { ExchangeIcon } from "./ExchangeIcon";
import { SPOT_DEFAULTS_KEY, loadSpotDefaults } from "../lib/spotDefaults";

// ── Credential sub-components ─────────────────────────────────────────────────

const SPOT_GROUP_IDS = ["binance", "bybit", "kucoin", "bitget"];

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
};

function CredentialInput({ envKey, status, value, onChange }) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const meta       = KEY_META[envKey] ?? { label: envKey, hint: "" };
  const isSecret   = envKey.toLowerCase().includes("secret") ||
    envKey.toLowerCase().includes("token") ||
    envKey.toLowerCase().includes("passphrase");
  const isConfigured = status?.configured;
  const isClear      = value === "\x00clear";
  const isDirty      = value !== "" && !isClear;

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
                color:      status.source === "file" ? "var(--app-success)"      : "var(--app-warning)",
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

function ExchangeGroupCard({ group, credentials, values, onChange, onSave, saving, isOpen, onToggle }) {
  const cardRef         = useRef(null);
  const configuredCount = group.keys.filter((k) => credentials[k]?.configured).length;
  const allConfigured   = configuredCount === group.keys.length;
  const hasChanges      = group.keys.some((k) => values[k] !== undefined && values[k] !== "");
  const borderCol = allConfigured
    ? "var(--app-success-border)"
    : configuredCount > 0 ? "var(--app-warning-border)" : "var(--app-border-1)";

  useEffect(() => {
    if (isOpen && cardRef.current) {
      setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
    }
  }, [isOpen]);

  return (
    <div ref={cardRef} className="rounded-xl overflow-hidden"
      style={{ border: `1px solid ${borderCol}`, background: "var(--app-surface-0)" }}>

      <button className="w-full flex items-center gap-3 px-4 py-3 text-left"
        onClick={onToggle}
        style={{ background: "var(--app-surface-1)", cursor: "pointer", minHeight: 52 }}>
        <ExchangeIcon name={group.id} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold text-sm leading-tight" style={{ color: "var(--app-text-bright)" }}>
              {group.label}
            </span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{
                background: allConfigured ? "var(--app-success-soft)" : configuredCount > 0 ? "var(--app-warning-soft)" : "var(--app-surface-2)",
                color:      allConfigured ? "var(--app-success)"      : configuredCount > 0 ? "var(--app-warning)"      : "var(--app-text-dimmer)",
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
            : <AlertCircle className="h-3.5 w-3.5" style={{ color: configuredCount > 0 ? "var(--app-warning)" : "var(--app-text-dimmer)" }} />
          }
          {isOpen
            ? <ChevronUp   className="h-4 w-4" style={{ color: "var(--app-text-muted)" }} />
            : <ChevronDown className="h-4 w-4" style={{ color: "var(--app-text-muted)" }} />
          }
        </div>
      </button>

      {isOpen && (
        <div className="px-4 pt-4 pb-4 flex flex-col gap-4"
          style={{ background: "var(--app-surface-0)", borderTop: `1px solid ${borderCol}` }}>
          {group.keys.map((k) => (
            <CredentialInput
              key={k} envKey={k}
              status={credentials[k]}
              value={values[k] ?? ""}
              onChange={onChange}
            />
          ))}
          <button
            disabled={saving || !hasChanges}
            onClick={() => onSave(group.keys)}
            className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-xs font-extrabold transition-all mt-1"
            style={{
              background: hasChanges ? "var(--app-success)" : "var(--app-surface-2)",
              color:      hasChanges ? "#000"               : "var(--app-text-dimmer)",
              opacity:    saving ? 0.6 : 1,
              cursor:     saving || !hasChanges ? "not-allowed" : "pointer",
            }}>
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving…" : hasChanges ? `Save ${group.label}` : "No Changes"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Set Defaults card ─────────────────────────────────────────────────────────

function DefInput({ label, value, onChange, suffix, min = 0, step = 1 }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-bold uppercase tracking-widest"
        style={{ color: "var(--app-text-muted)" }}>
        {label}
      </label>
      <div className="flex items-center h-10 rounded-lg"
        style={{ background: "var(--app-surface-0)", border: "1px solid var(--app-border-2)", overflow: "hidden" }}>
        <input
          type="number" min={min} step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="min-w-0 w-0 flex-1 h-full pl-3 pr-1 text-sm font-bold font-mono outline-none bg-transparent"
          style={{ color: "var(--app-text-bright)" }}
        />
        {suffix && (
          <span className="px-2.5 h-full flex items-center text-[11px] font-bold flex-shrink-0 whitespace-nowrap"
            style={{ background: "var(--app-surface-1)", borderLeft: "1px solid var(--app-border-1)", color: "var(--app-text-muted)" }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

const CHART_RANGES = ["4H", "8H", "12H", "24H"];

function RangeSelector({ value, onChange }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest"
        style={{ color: "var(--app-text-muted)" }}>
        Chart Default Range
      </span>
      <div className="flex gap-2">
        {CHART_RANGES.map((r) => {
          const active = value === r;
          return (
            <button
              key={r}
              onClick={() => onChange(r)}
              className="flex-1 py-2 rounded-lg text-[11px] font-bold transition-all"
              style={{
                background: active ? "var(--app-success)" : "var(--app-surface-2)",
                color:      active ? "#000"               : "var(--app-text-muted)",
                border:     active ? "1px solid var(--app-success)" : "1px solid var(--app-border-1)",
              }}
            >
              {r}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScannerDefaultsCard({ onSave }) {
  const [vals, setVals] = useState(loadSpotDefaults);
  const [saved, setSaved] = useState(false);
  const set = (key) => (v) => setVals((prev) => ({ ...prev, [key]: v }));

  const handleSave = () => {
    localStorage.setItem(SPOT_DEFAULTS_KEY, JSON.stringify(vals));
    onSave(vals);
    setSaved(true);
    toast.success("Default params saved — active now");
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>
      <div className="px-5 py-3.5 flex items-center gap-2"
        style={{ borderBottom: "1px solid var(--app-border-0)" }}>
        <Settings2 style={{ width: 14, height: 14, color: "var(--app-success)" }} />
        <span className="text-[11px] font-bold uppercase tracking-widest"
          style={{ color: "var(--app-text-muted)" }}>
          Set Defaults
        </span>
        <span className="text-[9px] ml-1" style={{ color: "var(--app-text-dimmer)" }}>
          — pre-fills Scanner on every open
        </span>
      </div>
      <div className="p-5 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <DefInput
            label="Trade Amount"
            value={vals.tradeAmount}
            onChange={set("tradeAmount")}
            suffix="USDT" min={1} step={10}
          />
          <DefInput
            label="Target Net Profit"
            value={vals.targetedNetProfit}
            onChange={set("targetedNetProfit")}
            suffix="%" min={0} step={0.1}
          />
        </div>
        <RangeSelector value={vals.chartDefaultRange} onChange={set("chartDefaultRange")} />
        <button
          onClick={handleSave}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-xs font-extrabold transition-all"
          style={{
            background: "var(--app-success)",
            color: "#000",
            cursor: "pointer",
            opacity: saved ? 0.85 : 1,
          }}>
          {saved
            ? <CheckCircle2 className="h-3.5 w-3.5" />
            : <Save className="h-3.5 w-3.5" />
          }
          {saved ? "Saved!" : "Save Defaults"}
        </button>
      </div>
    </div>
  );
}

// ── API Management section ────────────────────────────────────────────────────

function ApiManagementSection() {
  const [groups, setGroups]           = useState([]);
  const [credentials, setCredentials] = useState({});
  const [values, setValues]           = useState({});
  const [savingGroup, setSavingGroup] = useState(null);
  const [loading, setLoading]         = useState(true);
  const [openId, setOpenId]           = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/settings/credentials")
      .then((r) => r.json())
      .then(({ groups: g, credentials: c }) => {
        setGroups(g ?? []);
        setCredentials(c ?? {});
        const visible = (g ?? []).filter((gr) => SPOT_GROUP_IDS.includes(gr.id));
        const firstIncomplete = visible.find(
          (gr) => gr.keys.some((k) => !(c ?? {})[k]?.configured)
        );
        if (firstIncomplete) setOpenId(firstIncomplete.id);
      })
      .catch(() => toast.error("Failed to load credentials"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

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
      if (v === "\x00clear") payload[k] = "";
      else if (v !== "")    payload[k] = v;
    }
    if (Object.keys(payload).length === 0) { setSavingGroup(null); return; }
    try {
      const res = await fetch("/api/settings/credentials", {
        method: "POST",
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

  const visibleGroups = groups.filter((g) => SPOT_GROUP_IDS.includes(g.id));

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--app-surface-1)", border: "1px solid var(--app-border-0)" }}>

      <div className="px-5 py-3.5 flex items-center gap-2"
        style={{ borderBottom: "1px solid var(--app-border-0)" }}>
        <KeyRound style={{ width: 14, height: 14, color: "var(--app-warning)" }} />
        <span className="text-[11px] font-bold uppercase tracking-widest"
          style={{ color: "var(--app-text-muted)" }}>
          API Management
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start gap-2 px-1 py-1 rounded-lg"
          style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.15)" }}>
          <Info style={{ width: 12, height: 12, color: "var(--app-warning)", flexShrink: 0, marginTop: 1 }} />
          <span className="text-[10px]" style={{ color: "var(--app-warning)" }}>
            Spot trading credentials — used for Wallet balances, deposit addresses, and trade execution.
            Credentials are stored on the server and take effect immediately.
          </span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: "var(--app-success)", borderTopColor: "transparent" }} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
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
          </div>
        )}
      </div>
    </div>
  );
}

// ── SettingsTab ───────────────────────────────────────────────────────────────

export function SettingsTab({ onDefaultsChange }) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
      <ScannerDefaultsCard onSave={onDefaultsChange} />
      <ApiManagementSection />
    </div>
  );
}

// ── SetDefaultsModal ──────────────────────────────────────────────────────────

export function SetDefaultsModal({ onClose, onSave }) {
  const [vals, setVals] = useState(loadSpotDefaults);
  const [saved, setSaved] = useState(false);
  const set = (key) => (v) => setVals((prev) => ({ ...prev, [key]: v }));

  const handleSave = () => {
    localStorage.setItem(SPOT_DEFAULTS_KEY, JSON.stringify(vals));
    onSave(vals);
    setSaved(true);
    toast.success("Default params saved — active now");
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  };

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="fixed z-50 flex flex-col"
        style={{
          top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(460px, 96vw)",
          background: "var(--app-bg)",
          border: "1px solid var(--app-border-1)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{
            borderBottom: "1px solid var(--app-border-1)",
            borderRadius: "16px 16px 0 0",
            background: "var(--app-header-bg)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg"
              style={{ background: "var(--app-success-soft)", border: "1px solid var(--app-success-border)" }}
            >
              <Settings2 className="h-4 w-4" style={{ color: "var(--app-success)" }} />
            </div>
            <div className="flex flex-col leading-none gap-0.5">
              <span className="font-extrabold text-sm" style={{ color: "var(--app-text-bright)" }}>
                Set Defaults
              </span>
              <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--app-text-dimmer)" }}>
                Spot Arb — Scanner Pre-fill Values
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-full"
            style={{ background: "var(--app-surface-2)", border: "1px solid var(--app-border-1)" }}
          >
            <X className="h-3.5 w-3.5" style={{ color: "var(--app-text-muted)" }} />
          </button>
        </div>

        {/* Body — form fields directly, no inner card */}
        <div className="px-6 py-5 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <DefInput
              label="Trade Amount"
              value={vals.tradeAmount}
              onChange={set("tradeAmount")}
              suffix="USDT" min={1} step={10}
            />
            <DefInput
              label="Target Net Profit"
              value={vals.targetedNetProfit}
              onChange={set("targetedNetProfit")}
              suffix="%" min={0} step={0.1}
            />
          </div>
          <RangeSelector value={vals.chartDefaultRange} onChange={set("chartDefaultRange")} />

          <button
            onClick={handleSave}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-xs font-extrabold transition-all"
            style={{
              background: "var(--app-success)",
              color: "#000",
              cursor: "pointer",
              opacity: saved ? 0.85 : 1,
            }}
          >
            {saved
              ? <CheckCircle2 className="h-3.5 w-3.5" />
              : <Save className="h-3.5 w-3.5" />}
            {saved ? "Saved!" : "Save Defaults"}
          </button>
        </div>

        {/* Footer hint */}
        <div
          className="px-5 py-2.5 flex-shrink-0"
          style={{ borderTop: "1px solid var(--app-border-0)", background: "var(--app-surface-1)", borderRadius: "0 0 16px 16px" }}
        >
          <span className="text-[9px]" style={{ color: "var(--app-text-dimmer)" }}>
            Defaults are saved to your browser and applied every time you open the Scanner.
          </span>
        </div>
      </div>
    </>
  );
}
