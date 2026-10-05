import { type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icon, type IconName } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { type CreateIssueOption } from '../../contract.js';

function createOptionLabel(
  options: readonly CreateIssueOption[],
  value: string | null,
  unselectedLabel: string
): string {
  const selected = value
    ? options.find(option => option.id === value)
    : undefined;
  return selected === undefined ? unselectedLabel : selected.label;
}

function IssuePropertyMenu({
  icon,
  ariaLabel,
  text,
  muted,
  mobileTitle,
  disabled,
  children
}: {
  icon: IconName;
  ariaLabel: string;
  text: string;
  muted: boolean;
  mobileTitle: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-lg bg-background px-2.5 text-xs font-medium shadow-none"
          disabled={disabled}
          aria-label={ariaLabel}
        >
          <Icon name={icon} className="size-3.5 text-muted-foreground" />
          <span className={cn(muted && 'text-muted-foreground')}>{text}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-56 overflow-y-auto"
        mobileTitle={mobileTitle}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function IssuePropertySelect({
  icon,
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  icon: IconName;
  label: string;
  value: string | null;
  options: readonly CreateIssueOption[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <IssuePropertyMenu
      icon={icon}
      ariaLabel={`${label}: ${createOptionLabel(options, value, `No ${label.toLowerCase()}`)}`}
      text={createOptionLabel(options, value, label)}
      muted={!value}
      mobileTitle={label}
      disabled={disabled}
    >
      <DropdownMenuItem onSelect={() => onChange(null)}>
        <span className="text-muted-foreground">
          No {label.toLowerCase()}
        </span>
        {value === null ? (
          <Icon name="Check" className="ml-auto size-3.5" />
        ) : null}
      </DropdownMenuItem>
      {options.map(option => (
        <DropdownMenuItem
          key={option.id}
          onSelect={() => onChange(option.id)}
        >
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {value === option.id ? (
            <Icon name="Check" className="ml-auto size-3.5" />
          ) : null}
        </DropdownMenuItem>
      ))}
    </IssuePropertyMenu>
  );
}

export function IssueLabelsSelect({
  options,
  values,
  onChange,
  disabled = false
}: {
  options: readonly CreateIssueOption[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <IssuePropertyMenu
      icon="Layers"
      ariaLabel={`${values.length} labels selected`}
      text={
        values.length === 0
          ? 'Labels'
          : `${values.length} label${values.length === 1 ? '' : 's'}`
      }
      muted={values.length === 0}
      mobileTitle="Labels"
      disabled={disabled}
    >
      {options.map(option => (
        <DropdownMenuCheckboxItem
          key={option.id}
          checked={values.includes(option.id)}
          onSelect={event => event.preventDefault()}
          onCheckedChange={checked => {
            onChange(
              checked
                ? [...new Set([...values, option.id])]
                : values.filter(value => value !== option.id)
            );
          }}
        >
          {option.label}
        </DropdownMenuCheckboxItem>
      ))}
    </IssuePropertyMenu>
  );
}
