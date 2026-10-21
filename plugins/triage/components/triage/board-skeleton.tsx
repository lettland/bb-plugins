import { Skeleton, SkeletonLine } from "@/components/ui/skeleton";

/** Card counts chosen so the placeholder reads as a board, not a grid. */
const COLUMN_SHAPE = [2, 3, 1, 2];

function CardSkeleton({ delay }: { delay: number }) {
  return (
    <div className="triage-card triage-card-skeleton">
      <div className="triage-card-head">
        <Skeleton className="size-[22px] rounded-[7px]" delay={delay} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <SkeletonLine width="92%" delay={delay} />
          <SkeletonLine width="58%" delay={delay + 40} />
        </div>
      </div>
      <div className="triage-card-meta">
        <SkeletonLine width="74%" className="h-2.5" delay={delay + 80} />
        <SkeletonLine width="56%" className="h-2.5" delay={delay + 120} />
      </div>
      <div className="triage-card-footer">
        <SkeletonLine width="44%" className="h-2.5" delay={delay + 160} />
        <SkeletonLine width="22px" className="h-2.5" delay={delay + 160} />
      </div>
    </div>
  );
}

/**
 * Mirrors the real board's geometry exactly, so the transition to loaded data
 * is a change of content rather than a change of layout.
 */
function BoardSkeleton() {
  return (
    <div className="triage-board" role="status" aria-label="Loading Triage">
      {COLUMN_SHAPE.map((cards, column) => (
        <section className="triage-column" key={column}>
          <header className="triage-column-header">
            <Skeleton shape="circle" className="size-2" delay={column * 60} />
            <SkeletonLine width="72px" className="h-3" delay={column * 60} />
            <SkeletonLine width="16px" className="ml-auto h-3" delay={column * 60 + 40} />
          </header>
          <div className="triage-column-scroll">
            {Array.from({ length: cards }, (_, index) => (
              <CardSkeleton key={index} delay={column * 60 + index * 90} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Toolbar placeholder, so the second row does not pop in after the board. */
function ToolbarSkeleton() {
  return (
    <div className="triage-toolbar" aria-hidden="true">
      <div className="triage-toolbar-group">
        <Skeleton className="h-8 w-[168px]" />
        <Skeleton className="h-8 w-[150px]" delay={60} />
      </div>
      <div className="triage-toolbar-group justify-end">
        <Skeleton className="h-8 w-[248px]" delay={120} />
        <Skeleton className="h-8 w-[104px]" delay={160} />
      </div>
    </div>
  );
}

export { BoardSkeleton, ToolbarSkeleton };
