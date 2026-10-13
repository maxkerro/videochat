import { describe, expect, it } from 'vitest';
import { fitWithin, jpegName, shouldCompress } from './imageFit';

describe('fitWithin', () => {
  it('scales a 12 MP landscape photo to 2048 on the long side', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2048, height: 1536 });
  });
  it('scales a portrait photo by its height', () => {
    expect(fitWithin(3000, 4000)).toEqual({ width: 1536, height: 2048 });
  });
  it('leaves an image that already fits alone', () => {
    expect(fitWithin(2048, 1000)).toBeNull();
    expect(fitWithin(800, 600)).toBeNull();
  });
  it('does nothing when the size is unknown', () => {
    expect(fitWithin(null, 3000)).toBeNull();
    expect(fitWithin(undefined, undefined)).toBeNull();
    expect(fitWithin(0, 0)).toBeNull();
  });
  it('never produces a zero side for extreme panoramas', () => {
    expect(fitWithin(40000, 10)).toEqual({ width: 2048, height: 1 });
  });
});

describe('shouldCompress', () => {
  it('compresses photos but not gifs, svgs or other files', () => {
    expect(shouldCompress('image/jpeg')).toBe(true);
    expect(shouldCompress('image/HEIC')).toBe(true);
    expect(shouldCompress('image/png')).toBe(true);
    expect(shouldCompress('image/gif')).toBe(false);
    expect(shouldCompress('image/svg+xml')).toBe(false);
    expect(shouldCompress('application/pdf')).toBe(false);
  });
});

describe('jpegName', () => {
  it('swaps the extension', () => {
    expect(jpegName('IMG_0001.HEIC')).toBe('IMG_0001.jpg');
    expect(jpegName('a.b.png')).toBe('a.b.jpg');
    expect(jpegName('noext')).toBe('noext.jpg');
    expect(jpegName('.png')).toBe('photo.jpg');
  });
});
