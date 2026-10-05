import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { assigneeAvatarIdentity } from '../../browse.js';

type PriorityTone = 'low' | 'medium' | 'high' | 'urgent' | 'neutral';

function priorityTone(value: string): PriorityTone {
  const normalized = value.trim().toLocaleLowerCase();
  if (['urgent', 'critical', 'highest', 'blocker', 'p0'].includes(normalized)) {
    return 'urgent';
  }
  if (['high', 'major', 'p1'].includes(normalized)) return 'high';
  if (['medium', 'normal', 'moderate', 'p2'].includes(normalized)) {
    return 'medium';
  }
  if (['low', 'lowest', 'minor', 'trivial', 'p3', 'p4'].includes(normalized)) {
    return 'low';
  }
  return 'neutral';
}

export function visiblePriority(priority: string | null): string | null {
  const value = priority?.trim();
  return value && !/^(no priority|none)$/i.test(value) ? value : null;
}

export function visibleAssignee(assignee: string | null): string | null {
  const value = assignee?.trim();
  return value && !/^unassigned$/i.test(value) ? value : null;
}

function PriorityGlyph({ tone }: { tone: PriorityTone }) {
  if (tone === 'neutral') {
    return (
      <svg
        aria-hidden="true"
        className="size-4"
        data-priority-glyph="neutral"
        viewBox="0 0 16 16"
      >
        <circle cx="4" cy="8" r="1" fill="currentColor" opacity="0.72" />
        <circle cx="8" cy="8" r="1" fill="currentColor" opacity="0.72" />
        <circle cx="12" cy="8" r="1" fill="currentColor" opacity="0.72" />
      </svg>
    );
  }

  const activeBars =
    tone === 'low' ? 1 : tone === 'medium' ? 2 : tone === 'high' ? 3 : 4;
  const bars = [
    { x: 1.3, y: 10.5, height: 3 },
    { x: 4.65, y: 8, height: 5.5 },
    { x: 8, y: 5.5, height: 8 },
    { x: 11.35, y: 3, height: 10.5 }
  ];
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      data-priority-bars={activeBars}
      data-priority-glyph="bars"
      viewBox="0 0 16 16"
    >
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="2"
          height={bar.height}
          rx="1"
          fill="currentColor"
          opacity={index < activeBars ? 0.82 : 0.16}
        />
      ))}
    </svg>
  );
}

export function PriorityMark({ priority }: { priority: string }) {
  const tone = priorityTone(priority);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-hidden="true"
          className="tb-priority-mark shrink-0"
          data-priority-tone={tone}
        >
          <PriorityGlyph tone={tone} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Priority: {priority}</TooltipContent>
    </Tooltip>
  );
}

export function AssigneeMark({ assignee }: { assignee: string }) {
  const identity = assigneeAvatarIdentity(assignee);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Assigned to ${assignee}`}
          data-assignee-tone={identity.tone}
          className="tb-assignee-mark shrink-0"
        >
          <span aria-hidden="true">{identity.initials}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Assigned to {assignee}</TooltipContent>
    </Tooltip>
  );
}
