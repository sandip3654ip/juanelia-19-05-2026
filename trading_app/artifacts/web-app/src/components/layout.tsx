import { Link, useLocation } from "wouter";
import { CheckSquare, LayoutDashboard, ListTodo, Server } from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck();

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-background font-sans">
      <aside className="w-full md:w-64 border-r border-border bg-card flex-shrink-0 flex flex-col">
        <div className="p-6 border-b border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-sm">
            <CheckSquare className="w-5 h-5" />
          </div>
          <span className="font-bold text-lg tracking-tight text-foreground">Focus</span>
        </div>
        
        <nav className="p-4 flex-1 space-y-1">
          <Link href="/" className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location === "/" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} data-testid="link-nav-home">
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </Link>
          <Link href="/tasks" className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location === "/tasks" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} data-testid="link-nav-tasks">
            <ListTodo className="w-4 h-4" />
            All Tasks
          </Link>
        </nav>

        <div className="p-4 mt-auto border-t border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className={`w-2 h-2 rounded-full ${health?.status === "ok" ? "bg-green-500" : "bg-muted"}`} />
            <Server className="w-3 h-3" />
            <span>{health?.status === "ok" ? "System Operational" : "Connecting..."}</span>
          </div>
        </div>
      </aside>
      
      <main className="flex-1 p-6 md:p-10 lg:p-12 overflow-y-auto">
        <div className="max-w-4xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
