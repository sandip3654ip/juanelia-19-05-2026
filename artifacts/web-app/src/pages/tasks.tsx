import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { TaskCard } from "@/components/task-card";
import { CreateTaskDialog } from "@/components/create-task-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, FilterX } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function Tasks() {
  const { data: tasks, isLoading } = useListTasks();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "completed">("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | "low" | "medium" | "high">("all");

  const filteredTasks = tasks?.filter(task => {
    const matchesSearch = task.title.toLowerCase().includes(search.toLowerCase()) || 
                          (task.description?.toLowerCase() || "").includes(search.toLowerCase());
    
    const matchesStatus = statusFilter === "all" || 
                          (statusFilter === "completed" && task.completed) || 
                          (statusFilter === "pending" && !task.completed);
                          
    const matchesPriority = priorityFilter === "all" || task.priority === priorityFilter;

    return matchesSearch && matchesStatus && matchesPriority;
  }) || [];

  const hasActiveFilters = search !== "" || statusFilter !== "all" || priorityFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setPriorityFilter("all");
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">All Tasks</h1>
            <p className="text-muted-foreground mt-1 text-sm md:text-base">Manage and organize your workload.</p>
          </div>
          <CreateTaskDialog />
        </div>

        <div className="bg-card border rounded-xl p-4 flex flex-col md:flex-row gap-4 items-end md:items-center">
          <div className="relative w-full md:w-auto flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search tasks..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-full bg-background"
              data-testid="input-search-tasks"
            />
          </div>
          
          <div className="flex flex-wrap sm:flex-nowrap gap-3 w-full md:w-auto">
            <Select value={statusFilter} onValueChange={(val: any) => setStatusFilter(val)}>
              <SelectTrigger className="w-full sm:w-[140px] bg-background" data-testid="select-filter-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>

            <Select value={priorityFilter} onValueChange={(val: any) => setPriorityFilter(val)}>
              <SelectTrigger className="w-full sm:w-[140px] bg-background" data-testid="select-filter-priority">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Priorities</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>

            {hasActiveFilters && (
              <Button variant="ghost" size="icon" onClick={clearFilters} className="shrink-0" data-testid="btn-clear-filters">
                <FilterX className="w-4 h-4" />
                <span className="sr-only">Clear filters</span>
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-3">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))
          ) : filteredTasks.length === 0 ? (
            <div className="text-center py-16 border rounded-xl border-dashed bg-card/50">
              <h3 className="text-lg font-medium text-foreground">No tasks found</h3>
              <p className="text-muted-foreground text-sm mt-1">
                {hasActiveFilters ? "Try adjusting your filters or search query." : "Create your first task to get started."}
              </p>
              {hasActiveFilters ? (
                <Button variant="outline" className="mt-4" onClick={clearFilters}>
                  Clear Filters
                </Button>
              ) : (
                <div className="mt-4">
                  <CreateTaskDialog />
                </div>
              )}
            </div>
          ) : (
            filteredTasks.map(task => (
              <TaskCard key={task.id} task={task} />
            ))
          )}
        </div>
      </div>
    </Layout>
  );
}
