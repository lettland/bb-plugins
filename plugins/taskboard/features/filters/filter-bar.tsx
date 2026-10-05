import { Fragment, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type WorkStateCategory } from '../../contract.js';
import {
  type FilterOption,
  isFilterOptionSelected,
  toggleFilterOptionSelection
} from '../../browse.js';
import {
  countActiveFacets,
  hasActiveFilters,
  matchingFacetValueCount,
  type OptionFacet,
  optionFacets,
  selectedFacetNames,
  SOURCE_FILTER_OPTIONS,
  sourceOptionLabel,
  type TrackerFilterBarProps
} from './filter-bar-model.js';
import {
  FilterChip,
  FilterPresetMenu,
  FilterSectionLabel,
  TrackerSearchInput,
  TrackerViewToggle
} from './filter-parts.js';
import {
  BOARD_FILTER_FIELDS,
  FILTER_PRESENTATION,
  type SourceFilter,
  STATE_CATEGORY_LABELS,
  STATE_CATEGORY_ORDER,
  toggled
} from '../shared/filters.js';
import { WorkStateGlyph } from '../shared/work-state-glyph.js';
import { ALL_SOURCES } from '../shared/constants.js';
import { sourceName } from '../shared/source.js';

const keepOpen = (event: Event) => event.preventDefault();

function FilterBarPresets({
  props,
  constrained
}: {
  props: TrackerFilterBarProps;
  constrained: boolean;
}) {
  if (props.presets === null) return null;
  return (
    <FilterPresetMenu
      presets={props.presets}
      error={props.presetsError}
      refreshError={props.presetsRefreshError}
      loading={props.presetsLoading}
      actionsReady={props.presetActionsReady}
      constrained={constrained}
      onApply={props.onApplyPreset}
      onRetry={props.onRetryPresets}
      onSaveCurrent={props.onSaveCurrentPreset}
    />
  );
}

function SourceFacetItems({
  source,
  options,
  keepMenuOpen,
  onSourceChange
}: {
  source: SourceFilter;
  options: readonly SourceFilter[];
  keepMenuOpen: boolean;
  onSourceChange: (source: SourceFilter) => void;
}) {
  return (
    <>
      {options.map(option => (
        <DropdownMenuCheckboxItem
          key={option}
          checked={source === option}
          onSelect={keepMenuOpen ? keepOpen : undefined}
          onCheckedChange={checked => {
            if (checked === true) onSourceChange(option);
          }}
        >
          {sourceOptionLabel(option)}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

function StateFacetItems({
  categories,
  selected,
  grouped,
  onChange
}: {
  categories: readonly WorkStateCategory[];
  selected: readonly WorkStateCategory[];
  grouped: boolean;
  onChange: (categories: WorkStateCategory[]) => void;
}) {
  return (
    <>
      {categories.map(category => {
        const glyph = <WorkStateGlyph category={category} />;
        return (
          <DropdownMenuCheckboxItem
            key={category}
            checked={selected.includes(category)}
            onSelect={keepOpen}
            onCheckedChange={checked =>
              onChange(toggled(selected, category, checked === true))
            }
          >
            {grouped ? (
              <span className="flex items-center gap-2">
                {glyph}
                {STATE_CATEGORY_LABELS[category]}
              </span>
            ) : (
              <>
                {glyph}
                {STATE_CATEGORY_LABELS[category]}
              </>
            )}
          </DropdownMenuCheckboxItem>
        );
      })}
    </>
  );
}

function OptionFacetItems({
  facet,
  options
}: {
  facet: OptionFacet;
  options: readonly FilterOption[];
}) {
  return (
    <>
      {options.map(option => (
        <DropdownMenuCheckboxItem
          key={option.value}
          checked={isFilterOptionSelected(facet.selected, option.value)}
          onSelect={keepOpen}
          onCheckedChange={() =>
            facet.onChange(
              toggleFilterOptionSelection(facet.selected, option.value)
            )
          }
        >
          {option.label}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

function FullFilterChips({ props }: { props: TrackerFilterBarProps }) {
  const facets = optionFacets(props);
  return (
    <>
      {props.showSourceFilter ? (
        <FilterChip
          icon={FILTER_PRESENTATION.source.icon}
          label={FILTER_PRESENTATION.source.label}
          selectedNames={
            props.source === ALL_SOURCES ? [] : [sourceName(props.source)]
          }
        >
          <SourceFacetItems
            source={props.source}
            options={SOURCE_FILTER_OPTIONS}
            keepMenuOpen={false}
            onSourceChange={props.onSourceChange}
          />
        </FilterChip>
      ) : null}
      {BOARD_FILTER_FIELDS.map(field => {
        if (!props.enabledFilters.includes(field)) return null;
        if (field === 'state') {
          return (
            <FilterChip
              key={field}
              icon={FILTER_PRESENTATION[field].icon}
              label={FILTER_PRESENTATION[field].label}
              selectedNames={props.stateCategories.map(
                category => STATE_CATEGORY_LABELS[category]
              )}
            >
              <StateFacetItems
                categories={STATE_CATEGORY_ORDER}
                selected={props.stateCategories}
                grouped
                onChange={props.onStateCategoriesChange}
              />
            </FilterChip>
          );
        }
        const facet = facets[field];
        return (
          <FilterChip
            key={field}
            icon={FILTER_PRESENTATION[field].icon}
            label={FILTER_PRESENTATION[field].label}
            selectedNames={selectedFacetNames(facet.selected, facet.options)}
          >
            <OptionFacetItems facet={facet} options={facet.options} />
          </FilterChip>
        );
      })}
    </>
  );
}

function FullFilterBar({ props }: { props: TrackerFilterBarProps }) {
  const { view, showViewToggle } = props;
  return (
    <div
      role="search"
      aria-label="Filter work items"
      data-taskboard-filter-mode="full"
      className="tb-filter-bar shrink-0 border-b"
    >
      <div
        className={cn(
          'mx-auto flex w-full flex-wrap items-center gap-1.5 px-2 py-1.5',
          (view === 'list' || !showViewToggle) && 'max-w-[56rem]'
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-px">
          <FilterBarPresets props={props} constrained={false} />
          <FullFilterChips props={props} />
          <TrackerSearchInput
            query={props.query}
            onQueryChange={props.onQueryChange}
            className="@md:max-w-72"
          />
          {hasActiveFilters(props) ? (
            <button
              type="button"
              onClick={props.onClear}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:h-10"
            >
              <Icon name="X" className="size-3" />
              Clear filters
            </button>
          ) : null}
        </div>
        {showViewToggle ? (
          <TrackerViewToggle view={view} onViewChange={props.onViewChange} />
        ) : null}
      </div>
    </div>
  );
}

function ConstrainedFacetSections({
  props,
  matchesFacet
}: {
  props: TrackerFilterBarProps;
  matchesFacet: (label: string) => boolean;
}) {
  const facets = optionFacets(props);
  return (
    <>
      {props.showSourceFilter ? (
        <>
          <FilterSectionLabel filter="source" />
          <SourceFacetItems
            source={props.source}
            options={SOURCE_FILTER_OPTIONS.filter(option =>
              matchesFacet(sourceOptionLabel(option))
            )}
            keepMenuOpen
            onSourceChange={props.onSourceChange}
          />
          <DropdownMenuSeparator />
        </>
      ) : null}
      {BOARD_FILTER_FIELDS.map(field => {
        if (!props.enabledFilters.includes(field)) return null;
        const section =
          field === 'state' ? (
            <StateFacetItems
              categories={STATE_CATEGORY_ORDER.filter(category =>
                matchesFacet(STATE_CATEGORY_LABELS[category])
              )}
              selected={props.stateCategories}
              grouped={false}
              onChange={props.onStateCategoriesChange}
            />
          ) : (
            <OptionFacetItems
              facet={facets[field]}
              options={facets[field].options.filter(option =>
                matchesFacet(option.label)
              )}
            />
          );
        return (
          <Fragment key={field}>
            <FilterSectionLabel filter={field} />
            {section}
            {field !== 'labels' ? <DropdownMenuSeparator /> : null}
          </Fragment>
        );
      })}
    </>
  );
}

function ConstrainedFacetMenu({
  props,
  facetQuery,
  setFacetQuery
}: {
  props: TrackerFilterBarProps;
  facetQuery: string;
  setFacetQuery: (query: string) => void;
}) {
  const facetSearchRef = useRef<HTMLInputElement>(null);
  const normalizedFacetQuery = facetQuery.trim().toLocaleLowerCase();
  const matchesFacet = (label: string) =>
    normalizedFacetQuery === '' ||
    label.toLocaleLowerCase().includes(normalizedFacetQuery);
  const hasMatchingFacetValues =
    normalizedFacetQuery === '' ||
    matchingFacetValueCount(props, matchesFacet) > 0;
  const activeFacetCount = countActiveFacets(props);
  const activeCategories = `${activeFacetCount} active filter ${activeFacetCount === 1 ? 'category' : 'categories'}`;

  return (
    <DropdownMenu
      onOpenChange={open => {
        if (!open) setFacetQuery('');
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="tb-filter-chip h-7 min-w-0 shrink-0 gap-1.5 px-2 text-xs max-md:pointer-coarse:h-10"
          data-active={activeFacetCount > 0 ? 'true' : 'false'}
          aria-label={`Filters, ${activeCategories}`}
        >
          <Icon name="SlidersHorizontal" className="size-3.5" />
          <span className="truncate">
            Filters{activeFacetCount > 0 ? ` · ${activeFacetCount}` : ''}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="flex max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 flex-col overflow-hidden p-0"
        onOpenAutoFocus={event => {
          event.preventDefault();
          window.requestAnimationFrame(() => facetSearchRef.current?.focus());
        }}
      >
        <div className="z-10 shrink-0 space-y-2 border-b border-border bg-popover p-2">
          <p className="text-xs font-medium">
            {activeFacetCount > 0 ? activeCategories : 'Filter this project'}
          </p>
          <Input
            ref={facetSearchRef}
            value={facetQuery}
            onChange={event => setFacetQuery(event.target.value)}
            onKeyDown={event => {
              if (
                event.key !== 'Escape' &&
                event.key !== 'ArrowDown' &&
                event.key !== 'ArrowUp'
              ) {
                event.stopPropagation();
              }
            }}
            aria-label="Search filter values"
            placeholder="Find assignees, labels, statuses…"
            className="h-8 text-xs"
          />
        </div>

        <div
          data-taskboard-filter-values
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1"
        >
          {!hasMatchingFacetValues ? (
            <p
              role="status"
              className="px-3 py-5 text-center text-xs text-muted-foreground"
            >
              No matching values
            </p>
          ) : (
            <ConstrainedFacetSections props={props} matchesFacet={matchesFacet} />
          )}
        </div>

        <DropdownMenuItem
          disabled={!hasActiveFilters(props)}
          onSelect={props.onClear}
          className="shrink-0 border-t border-border bg-popover font-medium"
        >
          <Icon name="X" className="size-3.5" />
          Clear filters
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConstrainedFilterBar({
  props,
  facetQuery,
  setFacetQuery
}: {
  props: TrackerFilterBarProps;
  facetQuery: string;
  setFacetQuery: (query: string) => void;
}) {
  return (
    <div
      role="search"
      aria-label="Filter work items"
      data-taskboard-filter-mode="constrained"
      className="tb-filter-bar grid shrink-0 gap-1.5 border-b px-2 py-1.5"
    >
      <TrackerSearchInput
        query={props.query}
        onQueryChange={props.onQueryChange}
      />
      <div className="flex items-center justify-between gap-2">
        {props.showViewToggle ? (
          <TrackerViewToggle
            view={props.view}
            onViewChange={props.onViewChange}
            constrained
          />
        ) : (
          <span />
        )}
        <FilterBarPresets props={props} constrained />
        <ConstrainedFacetMenu
          props={props}
          facetQuery={facetQuery}
          setFacetQuery={setFacetQuery}
        />
      </div>
    </div>
  );
}

export function TrackerFilterBar(props: TrackerFilterBarProps) {
  // Held here, not in the constrained menu, so the text survives a width change.
  const [facetQuery, setFacetQuery] = useState('');
  return props.surfaceMode === 'constrained' ? (
    <ConstrainedFilterBar
      props={props}
      facetQuery={facetQuery}
      setFacetQuery={setFacetQuery}
    />
  ) : (
    <FullFilterBar props={props} />
  );
}
