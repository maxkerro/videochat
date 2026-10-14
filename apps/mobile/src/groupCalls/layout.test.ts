import { describe, expect, it } from 'vitest';
import { gridColumns, initialsOf, MIN_TILE_HEIGHT, tileSize } from './layout';

describe('group call layout (CHAT-070)', () => {
  it('fills the screen with one person, stacks two, then uses two columns', () => {
    expect(gridColumns(1)).toBe(1);
    expect(gridColumns(2)).toBe(1);
    expect(gridColumns(3)).toBe(2);
    expect(tileSize(1, 400, 800)).toEqual({ width: 400, height: 800 });
    expect(tileSize(2, 400, 800)).toEqual({ width: 400, height: 400 });
    expect(tileSize(4, 400, 800)).toEqual({ width: 200, height: 400 });
  });

  it('stops shrinking at 20 people (the grid scrolls instead)', () => {
    expect(tileSize(20, 400, 800).height).toBe(MIN_TILE_HEIGHT);
    expect(tileSize(0, 400, 800)).toEqual({ width: 400, height: 800 });
  });

  it('makes initials', () => {
    expect(initialsOf('Anna Berg')).toBe('AB');
    expect(initialsOf('ben')).toBe('B');
    expect(initialsOf('  ')).toBe('?');
    expect(initialsOf('Clara van der Berg')).toBe('CB');
  });
});
