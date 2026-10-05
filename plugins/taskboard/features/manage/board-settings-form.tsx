import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Textarea } from '@/components/ui/textarea';
import { type ProjectBoardSettings } from '../../board-settings.js';
import { useBoardSettingsForm } from './use-board-settings-form.js';
import { BOARD_FILTER_OPTIONS, toggled } from '../shared/filters.js';
import { SettingsSaveStatus } from './project-config-form.js';

type BoardSettingsForm = ReturnType<typeof useBoardSettingsForm>;

function DefaultLayoutField({ form }: { form: BoardSettingsForm }) {
  const { settings, setSettings, setSaved, saving } = form;
  return (
    <fieldset disabled={saving} className="space-y-2">
      <legend className="text-xs font-medium">Default layout</legend>
      <div className="grid gap-2 @sm:grid-cols-2">
        {(['list', 'kanban'] as const).map(view => (
          <label
            key={view}
            data-selected={settings.defaultView === view ? 'true' : 'false'}
            className="tb-source-option flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3"
          >
            <input
              type="radio"
              name="default-board-layout"
              value={view}
              checked={settings.defaultView === view}
              className="sr-only"
              onChange={() => {
                setSettings(current => ({ ...current, defaultView: view }));
                setSaved(false);
              }}
            />
            <Icon
              name={view === 'list' ? 'ListView' : 'Columns2'}
              className="size-4 text-muted-foreground"
            />
            <span className="text-sm font-medium">
              {view === 'list' ? 'List' : 'Kanban'}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function VisibleFiltersField({ form }: { form: BoardSettingsForm }) {
  const { settings, setSettings, setSaved, saving } = form;
  return (
    <fieldset disabled={saving} className="space-y-2">
      <legend className="text-xs font-medium">Visible filters</legend>
      <div className="grid gap-2 @lg:grid-cols-2">
        {BOARD_FILTER_OPTIONS.map(option => (
          <label
            key={option.field}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3"
          >
            <input
              type="checkbox"
              checked={settings.enabledFilters.includes(option.field)}
              className="mt-0.5 size-4 accent-primary"
              onChange={event => {
                setSettings(current => ({
                  ...current,
                  enabledFilters: toggled(
                    current.enabledFilters,
                    option.field,
                    event.target.checked
                  )
                }));
                setSaved(false);
              }}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Icon
                  name={option.icon}
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>{option.label}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ProjectBoardSettingsForm(props: {
  initialSettings: ProjectBoardSettings;
  onSave: (settings: ProjectBoardSettings) => Promise<ProjectBoardSettings>;
  onSavingChange: (saving: boolean) => void;
}) {
  const form = useBoardSettingsForm(props);
  const { statusOrderText, setStatusOrderText, setSaved } = form;
  const { saving, saved, error, dirty } = form;

  return (
    <form
      className="tb-settings-card space-y-5 rounded-lg border p-4 @lg:p-5"
      onSubmit={event => {
        event.preventDefault();
        void form.save();
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Board preferences</h3>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Choose the filters shown for this project, its default layout, and
          the workflow order shared by List and Kanban.
        </p>
      </div>

      <DefaultLayoutField form={form} />
      <VisibleFiltersField form={form} />

      <label className="block space-y-1.5 text-xs font-medium">
        Workflow status order
        <Textarea
          aria-label="Workflow status order"
          value={statusOrderText}
          disabled={saving}
          className="tb-field min-h-40 font-mono text-xs"
          onChange={event => {
            setStatusOrderText(event.target.value);
            setSaved(false);
          }}
        />
        <span className="block font-normal leading-relaxed text-muted-foreground">
          Enter one exact status name per line. Provider-specific statuses not
          listed here stay near their broad workflow group.
        </span>
      </label>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
        <SettingsSaveStatus
          error={error}
          saved={saved}
          dirty={dirty}
          savedLabel="Board preferences saved"
          dirtyLabel="Unsaved board changes"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={form.resetDefaults}
        >
          Reset defaults
        </Button>
        <Button type="submit" size="sm" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save board preferences'}
        </Button>
      </div>
    </form>
  );
}
