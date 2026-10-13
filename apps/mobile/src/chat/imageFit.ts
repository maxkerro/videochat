/** CHAT-056: photos are shrunk before upload so a 12 MP camera shot goes up as well under 1 MB. */
export const MAX_IMAGE_EDGE = 2048;
export const IMAGE_QUALITY = 0.8;

/**
 * The size to scale a `width` x `height` image to so its longer side is at most `maxEdge`, keeping
 * the aspect ratio; null when it already fits (or the size is unknown) and needs no resize.
 */
export function fitWithin(
  width: number | null | undefined,
  height: number | null | undefined,
  maxEdge: number = MAX_IMAGE_EDGE,
): { width: number; height: number } | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return null;
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Photos get re-encoded as JPEG; animated or vector images are sent untouched. */
export function shouldCompress(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.startsWith('image/') && type !== 'image/gif' && !type.includes('svg');
}

/** `IMG_0001.HEIC` -> `IMG_0001.jpg`: the name has to follow the bytes we actually send. */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'photo'}.jpg`;
}
