import { useGetTaskSummary, useListTasks } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { TaskCard } from "@/components/task-card";
import { CreateTaskDialog } from "@/components/create-task-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, ListTodo, AlertTriangle, TrendingUp } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

function StatCard({ title, value, icon: Icon, description, isLoading }: { title: string, value: number, icon: any, description: string, isLoading: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16 mb-1" />
        ) : (
          <div className="text-3xl font-bold" data-testid={`stat-${title.toLowerCase().replace(/\s+/g, '-')}`}>{value}</div>
        )}
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const { data: summary, isLoading: isLoadingSummary } = useGetTaskSummary();
  const { data: tasks, isLoading: isLoadingTasks } = useListTasks();

  const recentTasks = tasks?.slice(0, 5) || [];

  return (
    <Layout>
      <div className="space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
            <p className="text-muted-foreground mt-1 text-sm md:text-base">Track your progress and focus on what matters.</p>
          </div>
          <CreateTaskDialog />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard 
            title="Total Tasks" 
            value={summary?.total || 0} 
            icon={ListTodo} 
            description="Across all priorities"
            isLoading={isLoadingSummary}
          />
          <StatCard 
            title="Completed" 
            value={summary?.completed || 0} 
            icon={CheckCircle2} 
            description="Tasks done"
            isLoading={isLoadingSummary}
          />
          <StatCard 
            title="Pending" 
            value={summary?.pending || 0} 
            icon={TrendingUp} 
            description="Waiting for action"
            isLoading={isLoadingSummary}
          />
          <StatCard 
            title="High Priority" 
            value={summary?.highPriority || 0} 
            icon={AlertTriangle} 
            description="Needs attention soon"
            isLoading={isLoadingSummary}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold tracking-tight">Recent Tasks</h2>
            <Link href="/tasks" className="text-sm font-medium text-primary hover:underline" data-testid="link-view-all">
              View all tasks
            </Link>
          </div>
          
          <div className="space-y-3">
            {isLoadingTasks ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-xl" />
              ))
            ) : recentTasks.length === 0 ? (
              <div className="text-center py-12 border rounded-xl border-dashed bg-card/50">
                <div className="w-12 h-12 rounded-full bg-muted mx-auto flex items-center justify-center mb-3">
                  <CheckCircle2 className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium text-foreground">You're all caught up!</h3>
                <p className="text-muted-foreground text-sm mt-1 max-w-sm mx-auto">
                  Take a break, or add a new task to keep the momentum going.
                </p>
                <div className="mt-4">
                  <CreateTaskDialog />
                </div>
              </div>
            ) : (
              recentTasks.map(task => (
                <TaskCard key={task.id} task={task} />
              ))
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
