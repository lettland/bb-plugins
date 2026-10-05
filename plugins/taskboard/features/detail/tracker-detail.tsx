import { Markdown, useBbNavigate } from '@get-bb/plugin-sdk/app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import {
  formatWorkItemHandoffPrompt,
  type WorkItem,
  type WorkItemDetail
} from '../../contract.js';
import { SourceMark, sourceName } from '../shared/source.js';
import { formatUpdatedAt } from '../shared/format.js';
import { type TrackerRoute } from '../shared/route.js';
import { useWorkItemDetail } from './use-work-item-detail.js';
import { WorkItemStatusMenu } from '../list/work-item-row.js';

function DetailMetadata({
  item,
  className
}: {
  item: WorkItemDetail;
  className?: string;
}) {
  const fields = [
    ['Source', sourceName(item.source)],
    ['Status', item.status],
    ['Priority', item.priority ?? 'None'],
    ['Assignee', item.assignee ?? 'Unassigned'],
    ['External project', item.project ?? 'None'],
    ['Updated', formatUpdatedAt(item.updatedAt)]
  ] as const;
  return (
    <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-3', className)}>
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailLoading() {
  return (
    <div className="space-y-4 p-4 md:p-5">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-52 w-full" />
    </div>
  );
}

function DetailLoadError({
  error,
  onRetry
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="AlertCircle" className="size-6 text-destructive" />
      <p className="text-sm font-medium">Could not load this work item</p>
      <p role="alert" className="max-w-md text-sm text-muted-foreground">
        {error}
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function TrackerDetailActions({
  item,
  onAddToComposer
}: {
  item: WorkItemDetail;
  onAddToComposer?: (item: WorkItem) => void;
}) {
  const navigate = useBbNavigate();
  const prompt = formatWorkItemHandoffPrompt(item);
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      <Button variant="outline" size="sm" asChild>
        <a href={item.url} target="_blank" rel="noreferrer">
          <Icon name="ExternalLink" className="size-3.5" />
          Open
        </a>
      </Button>
      {onAddToComposer ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAddToComposer(item)}
        >
          <Icon name="MessageCirclePlus" className="size-3.5" />
          Add to chat
        </Button>
      ) : null}
      <Button
        size="sm"
        onClick={() =>
          navigate.toCompose({
            initialPrompt: prompt,
            focusPrompt: true
          })
        }
      >
        <Icon name="AiContentGenerator01" className="size-3.5" />
        Send to agent
      </Button>
    </div>
  );
}

function DetailComments({ comments }: { comments: WorkItemDetail['comments'] }) {
  return (
    <section className="tb-comment-rail mt-8 border-t pt-5">
      <h2 className="mb-1 text-sm font-semibold">
        Comments <span className="text-muted-foreground">{comments.length}</span>
      </h2>
      <div className="ml-2">
        {comments.map((comment, index) => (
          <article
            key={`${comment.author}:${comment.createdAt}:${index}`}
            className="tb-comment-entry relative py-4 pl-6"
          >
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {comment.author}
              </span>
              <time>{formatUpdatedAt(comment.createdAt)}</time>
            </div>
            <Markdown content={comment.body} />
          </article>
        ))}
      </div>
    </section>
  );
}

export function TrackerDetail({
  route,
  refreshGeneration,
  onAddToComposer
}: {
  route: Extract<TrackerRoute, { kind: 'item' }>;
  refreshGeneration: number;
  onAddToComposer?: (item: WorkItem) => void;
}) {
  const { item, setItem, error, load, moveItemStatus } = useWorkItemDetail(
    route,
    refreshGeneration
  );

  if (item === undefined) return <DetailLoading />;

  if (item === null) {
    return (
      <DetailLoadError
        error={error}
        onRetry={() => {
          setItem(undefined);
          void load();
        }}
      />
    );
  }

  return (
    <div className="@container flex min-h-full flex-col">
      <div className="tb-detail-frame flex flex-1 items-stretch">
        <article className="mx-auto w-full min-w-0 max-w-[52rem] flex-1 px-5 pb-16 pt-7 @3xl:px-10 @3xl:pt-10">
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium tabular-nums">{item.key}</span>
            <WorkItemStatusMenu
              item={item}
              variant="detail"
              onMove={moveItemStatus}
            />
            <SourceMark source={item.source} />
          </div>
          <div className="flex flex-col gap-4 @lg:flex-row @lg:items-start">
            <h1 className="min-w-0 flex-1 text-2xl font-semibold leading-tight">
              {item.title}
            </h1>
            <TrackerDetailActions
              item={item}
              onAddToComposer={onAddToComposer}
            />
          </div>

          <DetailMetadata
            item={item}
            className="tb-detail-meta mt-5 border-y py-4 @[45rem]:hidden"
          />

          {item.labels.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {item.labels.map(label => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}

          <section className="mt-7">
            <h2 className="mb-3 text-sm font-semibold">Description</h2>
            {item.description.trim() ? (
              <Markdown content={item.description} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No description provided.
              </p>
            )}
          </section>

          {item.comments.length > 0 ? (
            <DetailComments comments={item.comments} />
          ) : null}
        </article>

        <aside className="hidden w-56 shrink-0 border-l border-border-hairline py-10 pl-4 pr-6 @[45rem]:block">
          <DetailMetadata item={item} className="grid-cols-1" />
        </aside>
      </div>
    </div>
  );
}
