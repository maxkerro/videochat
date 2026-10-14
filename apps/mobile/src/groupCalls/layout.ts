/**
 * CHAT-070: how the tiles of a group call fill the phone screen. One person fills it, two stack,
 * then two columns; past 8 the tiles stop shrinking and the grid scrolls.
 */
export function gridColumns(count: number): number {
  return count <= 2 ? 1 : 2;
}

export const MIN_TILE_HEIGHT = 140;

export function tileSize(
  count: number,
  width: number,
  height: number,
): { width: number; height: number } {
  const n = Math.max(1, count);
  const columns = gridColumns(n);
  const rows = Math.ceil(n / columns);
  return {
    width: Math.floor(width / columns),
    height: Math.max(MIN_TILE_HEIGHT, Math.floor(height / rows)),
  };
}

/** Initials for a tile without video. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}
