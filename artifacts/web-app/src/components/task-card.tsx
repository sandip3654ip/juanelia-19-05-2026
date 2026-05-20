import { format } from "date-fns";
import { Check, Clock, Trash2 } from "lucide-react";
import { useUpdateTask, useDeleteTask, getListTasksQueryKey, getGetTaskSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Task } from "@workspace/api-client-react/src/generated/api.schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EditTaskDialog } from "@/components/edit-task-dialog";

interface TaskCardProps {
  task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
  const queryClient = useQueryClient();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const handleToggle = () => {
    updateTask.mutate(
      { id: task.id, data: { completed: !task.completed } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTaskSummaryQueryKey() });
        },
      }
    );
  };

  const handleDelete = () => {
    deleteTask.mutate(
      { id: task.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTaskSummaryQueryKey() });
        },
      }
    );
  };

  const priorityColors = {
    low: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300",
    medium: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300",
    high: "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300",
  };

  return (
    <Card className={`transition-all duration-200 border ${task.completed ? "opacity-60 bg-muted/50" : "bg-card hover:shadow-md"}`}>
      <CardContent className="p-4 flex items-start gap-4">
        <button
          onClick={handleToggle}
          className={`mt-1 flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors
            ${task.completed 
              ? "bg-primary border-primary text-primary-foreground" 
              : "border-muted-foreground hover:border-primary text-transparent"}`}
          data-testid={`btn-toggle-task-${task.id}`}
        >
          <Check className="w-3 h-3" />
        </button>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className={`font-semibold text-base truncate ${task.completed ? "line-through text-muted-foreground" : "text-foreground"}`} data-testid={`text-task-title-${task.id}`}>
              {task.title}
            </h3>
            <Badge variant="outline" className={`capitalize text-xs font-medium ${priorityColors[task.priority]}`} data-testid={`badge-priority-${task.id}`}>
              {task.priority}
            </Badge>
          </div>
          
          {task.description && (
            <p className={`text-sm mb-3 line-clamp-2 ${task.completed ? "text-muted-foreground/70" : "text-muted-foreground"}`} data-testid={`text-task-desc-${task.id}`}>
              {task.description}
            </p>
          )}
          
          <div className="flex items-center justify-between mt-auto">
            <div className="flex items-center text-xs text-muted-foreground gap-1">
              <Clock className="w-3 h-3" />
              <span data-testid={`text-task-date-${task.id}`}>{format(new Date(task.createdAt), "MMM d, yyyy")}</span>
            </div>
            
            <div className="flex items-center gap-1">
              <EditTaskDialog taskId={task.id} />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={handleDelete}
                data-testid={`btn-delete-task-${task.id}`}
                disabled={deleteTask.isPending}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
