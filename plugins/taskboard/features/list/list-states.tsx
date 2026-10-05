import { type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export function EmptyState({
  filtered,
  onClear
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="tb-empty-state flex h-full flex-col items-center justify-center gap-3 rounded-lg p-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon name={filtered ? 'Search' : 'ListTodo'} className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {filtered ? 'No work matches these filters' : 'No work items yet'}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {filtered
            ? 'Try a different state, assignee, or search query.'
            : 'Use Manage to choose this project’s external tracker, then refresh.'}
        </p>
      </div>
      {filtered ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingRows() {
  return (
    <div className="px-3.5 pt-3">
      <Skeleton className="mb-3 h-4 w-28" />
      {Array.from({ length: 7 }, (_, index) => (
        <div
          key={index}
          className="flex h-[34px] items-center gap-2 border-b border-border-hairline"
        >
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

export function ListMeasure({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-taskboard-list-measure
      className={cn('mx-auto w-full max-w-[56rem]', className)}
    >
      {children}
    </div>
  );
}
