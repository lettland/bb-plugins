import { cn } from '@/lib/utils';
import { type WorkStateCategory } from '../../contract.js';

export function WorkStateGlyph({
  category,
  className = 'size-4'
}: {
  category: WorkStateCategory;
  className?: string;
}) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.5
  };
  return (
    <svg
      aria-hidden="true"
      data-state-category={category}
      data-taskboard-state-glyph={category}
      className={cn('tb-state-glyph shrink-0', className)}
      viewBox="0 0 16 16"
    >
      {category === 'backlog' ? (
        <circle {...common} cx="8" cy="8" r="5.25" strokeDasharray="1.6 2.1" />
      ) : category === 'todo' ? (
        <circle {...common} cx="8" cy="8" r="5.25" />
      ) : category === 'in_progress' ? (
        <>
          <circle {...common} cx="8" cy="8" r="5.25" opacity="0.35" />
          <path {...common} d="M8 2.75a5.25 5.25 0 0 1 0 10.5" strokeWidth="2" />
        </>
      ) : category === 'done' ? (
        <>
          <circle {...common} cx="8" cy="8" r="5.25" />
          <path {...common} d="m5.35 8.05 1.7 1.75 3.65-3.7" />
        </>
      ) : (
        <>
          <circle {...common} cx="8" cy="8" r="5.25" />
          <path {...common} d="m5.1 10.9 5.8-5.8" />
        </>
      )}
    </svg>
  );
}
