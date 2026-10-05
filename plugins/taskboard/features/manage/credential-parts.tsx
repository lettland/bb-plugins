import { type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function CredentialStatus({
  configured,
  hasDraft,
  remove
}: {
  configured: boolean;
  hasDraft: boolean;
  remove: boolean;
}) {
  const label = remove
    ? 'Removal queued'
    : hasDraft
      ? configured
        ? 'Replacement ready'
        : 'Credential ready'
      : configured
        ? 'Configured'
        : 'Not configured';
  return (
    <span
      className={cn(
        'tb-status-pill inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        configured && !remove
          ? 'border-success/30 bg-success/10 text-success'
          : 'text-muted-foreground'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          configured && !remove ? 'bg-success' : 'bg-muted-foreground/60'
        )}
      />
      {label}
    </span>
  );
}

/** Every credential field goes through here so secrets never autofill, spellcheck, or persist. */
export function SecretInput(props: ComponentProps<typeof Input>) {
  return (
    <Input
      {...props}
      type="password"
      autoComplete="new-password"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
    />
  );
}

export function SecretField({
  label,
  labelClassName,
  inputProps
}: {
  label: string;
  labelClassName: string;
  inputProps: ComponentProps<typeof Input>;
}) {
  return (
    <label className={labelClassName}>
      {label}{' '}
      <span className="font-normal text-muted-foreground">(write-only)</span>
      <SecretInput {...inputProps} />
    </label>
  );
}

export function RemoveCredentialButton({
  provider,
  removed,
  disabled,
  className,
  showIcon,
  onToggle
}: {
  provider: 'Linear' | 'Jira';
  removed: boolean;
  disabled: boolean;
  className: string;
  showIcon: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={className}
      disabled={disabled}
      onClick={onToggle}
    >
      {showIcon ? (
        <Icon
          name={removed ? 'RotateCcw' : 'Trash2'}
          className="size-3.5"
        />
      ) : null}
      {removed
        ? `Keep ${provider} credential`
        : `Remove ${provider} credential`}
    </Button>
  );
}
