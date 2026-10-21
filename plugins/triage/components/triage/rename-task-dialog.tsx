import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { useTriage } from "@/lib/triage-store";
import type { Task } from "@/lib/triage-types";

export function RenameTaskDialog({ task, open, onOpenChange }: { task: Task; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { rpc, refresh } = useTriage();
  const [title, setTitle] = useState(task.title);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (open) setTitle(task.title); }, [open, task.title]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit title</DialogTitle></DialogHeader>
        <form className="grid gap-4" onSubmit={async (event) => {
          event.preventDefault();
          if (pending || !title.trim()) return;
          setPending(true);
          try {
            await rpc.call("renameTask", { number: task.number, title: title.trim() });
            await refresh();
            onOpenChange(false);
            toast.success("Title updated");
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          } finally { setPending(false); }
        }}>
          <Field>
            <FieldLabel htmlFor={`triage-title-${task.number}`}>Title</FieldLabel>
            <Input id={`triage-title-${task.number}`} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required autoFocus disabled={pending} />
          </Field>
          <Button type="submit" disabled={pending || !title.trim()}>{pending ? "Saving…" : "Save"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
