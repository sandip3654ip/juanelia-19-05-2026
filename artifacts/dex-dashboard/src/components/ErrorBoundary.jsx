import { Component } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Lightweight inline card-level error boundary.
 * Catches render errors in a single card and shows a small error tile
 * instead of crashing the whole grid.
 */
export class CardErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[CardError]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          borderRadius: 12,
          padding: "20px 16px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          background: "var(--app-danger-soft)",
          border: "1px solid var(--app-danger)",
          color: "var(--app-danger)",
          fontSize: 12,
          minHeight: 120,
        }}
      >
        <AlertTriangle style={{ width: 18, height: 18, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, textAlign: "center" }}>Card render error</span>
        <span style={{ fontSize: 10, color: "var(--app-text-muted)", textAlign: "center", wordBreak: "break-word" }}>
          {this.state.error?.message ?? "Unknown error"}
        </span>
        <button
          onClick={() => this.setState({ hasError: false, error: null })}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 12px",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            background: "transparent",
            border: "1px solid var(--app-danger)",
            color: "var(--app-danger)",
          }}
        >
          <RefreshCw style={{ width: 10, height: 10 }} />
          Retry
        </button>
      </div>
    );
  }
}

/**
 * Catches any render-time JS errors in child components and shows a
 * clear error panel instead of a blank screen.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Log to console — visible in browser devtools and Replit logs
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const msg = this.state.error?.message ?? "Unknown error";

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
          background: "var(--app-bg, #0a0f0a)",
          color: "var(--app-text-primary, #e2e8f0)",
        }}
      >
        <AlertTriangle style={{ width: 40, height: 40, color: "#F87171" }} />
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
          Something went wrong
        </h2>
        <p
          style={{
            maxWidth: 480,
            textAlign: "center",
            fontSize: 13,
            color: "var(--app-text-muted, #94a3b8)",
            margin: 0,
          }}
        >
          {msg}
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 20px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            background: "transparent",
            border: "1px solid var(--app-success, #22c55e)",
            color: "var(--app-success, #22c55e)",
          }}
        >
          <RefreshCw style={{ width: 14, height: 14 }} />
          Reload page
        </button>
      </div>
    );
  }
}
