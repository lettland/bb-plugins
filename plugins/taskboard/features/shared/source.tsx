import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { type WorkSource } from '../../contract.js';

export function sourceName(source: WorkSource): string {
  if (source === 'github') return 'GitHub';
  if (source === 'jira') return 'Jira';
  return 'Linear';
}

export function SourceGlyph({ source }: { source: WorkSource }) {
  if (source === 'github') {
    return <Icon name="Github" className="size-3.5" aria-hidden="true" />;
  }

  if (source === 'linear') {
    return (
      <svg aria-hidden="true" className="size-3.5" viewBox="0 0 16 16">
        <circle
          cx="8"
          cy="8"
          r="5.65"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
        />
        <path
          d="m3.6 10.7 1.7 1.7M2.85 8l5.15 5.15M3.65 5.25l7.1 7.1"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.35"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="size-3.5" viewBox="0 0 16 16">
      <path
        d="M8 1.4 14.6 8 8 14.6 1.4 8 8 1.4Z"
        fill="currentColor"
        opacity="0.2"
      />
      <path
        d="M8 3.9 12.1 8 8 12.1 3.9 8 8 3.9Z"
        fill="currentColor"
        opacity="0.52"
      />
      <path d="M8 6.15 9.85 8 8 9.85 6.15 8 8 6.15Z" fill="currentColor" />
    </svg>
  );
}

export function SourceMark({
  source,
  className
}: {
  source: WorkSource;
  className?: string;
}) {
  const name = sourceName(source);
  return (
    <span
      data-source={source}
      className={cn(
        'tb-source-mark inline-flex shrink-0 items-center gap-1.5 text-xs',
        className
      )}
      title={name}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-3.5 shrink-0 items-center justify-center"
        data-source-glyph={source}
      >
        <SourceGlyph source={source} />
      </span>
      <span className="tb-source-mark-name">{name}</span>
    </span>
  );
}
