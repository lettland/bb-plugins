type Anchor = { id: string; node: HTMLDivElement; target: HTMLElement };

let anchors: readonly Anchor[] = [];
let nextAnchorId = 0;
const listeners = new Set<() => void>();

export function subscribeNewThreadAnchors(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNewThreadAnchors() {
  return anchors;
}

export function mountNewThreadAnchors(signal: AbortSignal) {
  const owned = new Map<Element, Anchor>();
  const publish = () => {
    anchors = [...owned.values()];
    for (const listener of listeners) listener();
  };
  const addMarker = (marker: Element) => {
    const target = marker.parentElement?.parentElement;
    if (!target || owned.has(marker) || [...owned.values()].some((entry) => entry.target === target)) return;
    const node = document.createElement("div");
    const id = `triage-new-thread-${++nextAnchorId}`;
    node.dataset.triageNewThreadAnchor = id;
    Object.assign(node.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "20" });
    target.appendChild(node);
    owned.set(marker, { id, node, target });
  };
  const scan = (element: Element) => {
    if (element.matches('[data-testid="root-compose-compact-home"]')) addMarker(element);
    element.querySelectorAll('[data-testid="root-compose-compact-home"]').forEach(addMarker);
  };
  const observer = new MutationObserver((records) => {
    let changed = false;
    for (const [marker, entry] of owned) {
      if (!marker.isConnected || !entry.target.isConnected || !entry.target.contains(marker) || !entry.node.isConnected) {
        entry.node.remove();
        owned.delete(marker);
        if (marker.isConnected) addMarker(marker);
        changed = true;
      }
    }
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof Element && ![...owned.values()].some((entry) => entry.node.contains(node))) {
          const size = owned.size;
          scan(node);
          changed ||= owned.size !== size;
        }
      });
    }
    if (changed) publish();
  });
  if (signal.aborted) return () => {};
  scan(document.documentElement);
  if (owned.size > 0) publish();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    signal.removeEventListener("abort", dispose);
    const hadAnchors = owned.size > 0;
    for (const entry of owned.values()) entry.node.remove();
    owned.clear();
    if (hadAnchors) publish();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
