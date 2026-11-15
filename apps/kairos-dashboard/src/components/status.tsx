import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const tone: Record<string, string> = {
  completed: "bg-good-soft text-good border-transparent",
  matched: "bg-good-soft text-good border-transparent",
  failed: "bg-danger-soft text-destructive border-transparent",
  cancelled: "bg-muted text-muted-foreground border-transparent",
  running: "bg-accent text-accent-foreground border-transparent",
  queued: "bg-warning-soft text-warning border-transparent",
  retrying: "bg-warning-soft text-warning border-transparent",
  timed_out: "bg-warning-soft text-warning border-transparent",
  sleeping: "bg-secondary text-foreground border-border",
  waiting: "bg-secondary text-foreground border-border",
  open: "bg-secondary text-foreground border-border",
};

export function Status({ value, className }: { value: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("capitalize", tone[value] ?? "", className)}>
      {value.replace("_", " ")}
    </Badge>
  );
}
