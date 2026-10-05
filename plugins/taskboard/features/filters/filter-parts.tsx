import { type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icon, type IconName } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type FilterPreset } from '../../contract.js';
import { type TrackerView } from '../../board-settings.js';
import { MAX_BROWSE_QUERY_LENGTH } from '../../browse-preferences.js';
import {
  FILTER_PRESENTATION,
  type FilterPresentationKey
} from '../shared/filters.js';

export function FilterChip({
  icon,
  label,
  selectedNames,
  children
}: {
  icon: IconName;
  label: string;
  selectedNames: readonly string[];
  children: ReactNode;
}) {
  const active = selectedNames.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-active={active ? 'true' : 'false'}
          className={cn(
            'tb-filter-chip flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors max-md:pointer-coarse:h-10',
            active ? 'text-foreground' : 'hover:text-foreground'
          )}
        >
          <Icon name={icon} className="size-3 shrink-0" aria-hidden="true" />
          {label}
          {active ? (
            <span className="max-w-40 truncate font-medium @max-md:max-w-24">
              {selectedNames.join(', ')}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FilterSectionLabel({ filter }: { filter: FilterPresentationKey }) {
  const presentation = FILTER_PRESENTATION[filter];
  return (
    <DropdownMenuLabel className="flex items-center gap-1.5">
      <Icon
        name={presentation.icon}
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span>{presentation.label}</span>
    </DropdownMenuLabel>
  );
}

export function TrackerSearchInput({
  query,
  onQueryChange,
  className
}: {
  query: string;
  onQueryChange: (query: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'tb-search-shell relative min-w-40 flex-1 rounded-md',
        className
      )}
    >
      <Icon
        name="Search"
        className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        name="work-item-search"
        value={query}
        maxLength={MAX_BROWSE_QUERY_LENGTH}
        onChange={event => onQueryChange(event.target.value)}
        aria-label="Search work items"
        placeholder="Search key or title"
        className="tb-search-input h-7 w-full pl-7 text-xs max-md:pointer-coarse:h-10"
      />
    </div>
  );
}

export function TrackerViewToggle({
  view,
  onViewChange,
  constrained = false,
  className
}: {
  view: TrackerView;
  onViewChange: (view: TrackerView) => void;
  constrained?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Work view"
      className={cn(
        'tb-view-toggle flex rounded-md p-0.5',
        constrained ? 'min-w-0 flex-1' : 'shrink-0',
        className
      )}
    >
      {(['list', 'kanban'] as const).map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          data-active={view === option ? 'true' : 'false'}
          onClick={() => onViewChange(option)}
          className={cn(
            'tb-view-toggle-option flex h-6 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:h-9',
            constrained && 'min-w-0 flex-1 justify-center gap-0 overflow-hidden px-2',
            view === option
              ? 'text-foreground shadow-2xs'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {!constrained ? (
            <Icon
              name={option === 'list' ? 'ListView' : 'Columns2'}
              className="size-3.5"
            />
          ) : null}
          <span className={cn(constrained && 'truncate')}>
            {option === 'list' ? 'List' : 'Kanban'}
          </span>
        </button>
      ))}
    </div>
  );
}

export function FilterPresetMenu({
  presets,
  error,
  refreshError,
  loading,
  actionsReady,
  constrained = false,
  onApply,
  onRetry,
  onSaveCurrent
}: {
  presets: readonly FilterPreset[];
  error: string | null;
  refreshError: string | null;
  loading: boolean;
  actionsReady: boolean;
  constrained?: boolean;
  onApply: (preset: FilterPreset) => void;
  onRetry: () => void;
  onSaveCurrent: () => void;
}) {
  const hasLoadIssue = error !== null || refreshError !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {constrained ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="tb-filter-chip h-7 shrink-0 gap-1.5 px-2 text-xs max-md:pointer-coarse:h-10"
            data-active={hasLoadIssue ? 'true' : 'false'}
            aria-label={
              hasLoadIssue ? 'Filter presets need attention' : 'Filter presets'
            }
          >
            <Icon
              name={hasLoadIssue ? 'AlertCircle' : 'Star'}
              className="size-3.5"
              aria-hidden="true"
            />
            <span className="sr-only">Presets</span>
          </Button>
        ) : (
          <button
            type="button"
            data-active={hasLoadIssue ? 'true' : 'false'}
            aria-label={hasLoadIssue ? 'Presets need attention' : undefined}
            className="tb-filter-chip flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors hover:text-foreground max-md:pointer-coarse:h-10"
          >
            <Icon
              name={hasLoadIssue ? 'AlertCircle' : 'Star'}
              className="size-3 shrink-0"
              aria-hidden="true"
            />
            Presets
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={constrained ? 'end' : 'start'}
        mobileTitle="Filter presets"
        className="flex max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {!actionsReady ? (
            <DropdownMenuItem disabled>
              Waiting for the project tracker…
            </DropdownMenuItem>
          ) : null}
          {loading ? (
            <DropdownMenuItem disabled>Loading presets…</DropdownMenuItem>
          ) : error ? (
            <>
              <div
                role="alert"
                className="px-2 py-1.5 text-xs leading-relaxed text-destructive"
              >
                Could not load presets: {error}
              </div>
              <DropdownMenuItem onSelect={onRetry}>
                <Icon name="ArrowReloadHorizontal" className="size-3.5" />
                Try again
              </DropdownMenuItem>
            </>
          ) : presets.length === 0 ? (
            <DropdownMenuItem disabled>No saved presets</DropdownMenuItem>
          ) : (
            presets.map(preset => (
              <DropdownMenuItem
                key={preset.id}
                disabled={!actionsReady}
                onSelect={() => onApply(preset)}
              >
                <Icon name="Star" className="size-3.5" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
              </DropdownMenuItem>
            ))
          )}
          {refreshError && !error ? (
            <div
              role="alert"
              className="mt-1 border-t border-border px-2 py-2 text-xs leading-relaxed text-muted-foreground"
            >
              Could not refresh presets. Keeping the last loaded list.
              <button
                type="button"
                className="ml-1 font-medium text-foreground underline-offset-2 hover:underline"
                onClick={onRetry}
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
        <div className="shrink-0 border-t border-border bg-popover p-1">
          <DropdownMenuItem
            disabled={!actionsReady}
            onSelect={onSaveCurrent}
          >
            <Icon name="Plus" className="size-3.5" aria-hidden="true" />
            Save current view as…
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
