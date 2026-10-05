export const ASSIGNEE_AVATAR_TONES = [
  'violet',
  'blue',
  'teal',
  'amber',
  'rose',
  'slate'
] as const;
export type AssigneeAvatarTone = (typeof ASSIGNEE_AVATAR_TONES)[number];

export interface AssigneeAvatarIdentity {
  initials: string;
  tone: AssigneeAvatarTone;
}

export function assigneeAvatarIdentity(name: string): AssigneeAvatarIdentity {
  const normalized = name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ');
  const initials =
    normalized
      .split(' ')
      .flatMap(token => {
        const character = Array.from(token).find(value =>
          /[\p{L}\p{N}]/u.test(value)
        );
        return character ? [character] : [];
      })
      .slice(0, 2)
      .map(character => Array.from(character.toUpperCase())[0] ?? '')
      .join('') || '?';
  let hash = 2166136261;
  for (const character of normalized.toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return {
    initials,
    tone:
      ASSIGNEE_AVATAR_TONES[
        (hash >>> 0) % ASSIGNEE_AVATAR_TONES.length
      ]!
  };
}
