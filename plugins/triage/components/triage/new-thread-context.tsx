import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { getNewThreadAnchors, subscribeNewThreadAnchors } from "@/lib/new-thread-context";
import { TriageThreadsSection } from "./thread-context-section";

function NewThreadPane({ target }: { target: HTMLElement }) {
  const [wide, setWide] = useState(false);
  const [open, setOpen] = useState(false);
  const scope = usePortalScopeProps();
  const focusPane = () => {
    const pane = target.closest<HTMLElement>('[data-split-pane-id][data-focused="false"]');
    pane?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  };
  useLayoutEffect(() => {
    const measure = () => setWide(target.clientWidth >= 1384);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [target]);
  useLayoutEffect(() => {
    if (wide) setOpen(false);
  }, [wide]);
  const content = (
    <section aria-label="Triage" className="triage-new-thread-content">
      <h3 className="triage-new-thread-heading">Triage</h3>
      <div className="triage-new-thread-list"><TriageThreadsSection /></div>
      <div className="triage-new-thread-empty">Nothing to show yet</div>
    </section>
  );
  if (wide) return <div {...scope} className="triage-new-thread-card" onPointerDownCapture={focusPane} onFocusCapture={focusPane}>{content}</div>;
  return (
    <div {...scope} className="triage-new-thread-control" onPointerDownCapture={focusPane} onFocusCapture={focusPane}>
      <Popover open={open} onOpenChange={setOpen} persistentDrawer>
        <PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="Triage"><Icon name="ListTodo" /></Button></PopoverTrigger>
        <PopoverContent align="end" mobileTitle="Triage" onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button[data-thread-context-card-row]")) setOpen(false);
        }}>{content}</PopoverContent>
      </Popover>
    </div>
  );
}

export function NewThreadContextOverlay() {
  const anchors = useSyncExternalStore(subscribeNewThreadAnchors, getNewThreadAnchors, getNewThreadAnchors);
  return anchors.map(({ id, node, target }) => createPortal(<NewThreadPane target={target} />, node, id));
}
