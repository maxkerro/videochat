import { thumbBox } from './AttachmentView';

describe('thumbBox', () => {
  it('fits an image inside the thumbnail box without upscaling', () => {
    expect(thumbBox(4000, 3000)).toEqual({ width: 280, height: 210 });
    expect(thumbBox(1000, 4000)).toEqual({ width: 80, height: 320 });
    expect(thumbBox(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it('uses a default box when dimensions are unknown', () => {
    expect(thumbBox(null, null)).toEqual({ width: 280, height: 210 });
  });
});
