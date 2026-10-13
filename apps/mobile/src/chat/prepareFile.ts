import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  IMAGE_QUALITY,
  MAX_IMAGE_EDGE,
  fitWithin,
  outputFormat,
  renamedWithExtension,
  shouldCompress,
} from './imageFit';
import type { PickedFile, PreparedFile } from '../uploads/flow';

async function readBlob(uri: string): Promise<Blob> {
  return (await fetch(uri)).blob();
}

/** Longest side at most 2048 px, re-encoded as JPEG (also turns an iPhone's HEIC into something
 *  every device can show), or as PNG when the original is a PNG so transparency survives.
 *  Returns the new file's uri. */
async function shrink(file: PickedFile, format: 'png' | 'jpeg'): Promise<string> {
  const fit = fitWithin(file.width, file.height);
  const first = ImageManipulator.manipulate(file.uri);
  if (fit) first.resize({ width: fit.width, height: fit.height });
  const rendered = await first.renderAsync();
  // The picker did not tell us the size, and it turned out to be big: shrink the decoded image.
  const again = fit ? null : fitWithin(rendered.width, rendered.height, MAX_IMAGE_EDGE);
  const final = again
    ? await ImageManipulator.manipulate(rendered).resize(again).renderAsync()
    : rendered;
  const saved = await final.saveAsync(
    format === 'png'
      ? { format: SaveFormat.PNG }
      : { format: SaveFormat.JPEG, compress: IMAGE_QUALITY },
  );
  return saved.uri;
}

/**
 * CHAT-056: reads the picked file into memory, shrinking photos first so a 12 MP shot uploads as
 * well under 1 MB. JPEG for photos, PNG for PNGs (keeps transparency). If shrinking fails for
 * some reason the original is sent as it is.
 */
export async function prepareFile(file: PickedFile): Promise<PreparedFile> {
  if (shouldCompress(file.contentType)) {
    try {
      const out = outputFormat(file.contentType);
      const blob = await readBlob(await shrink(file, out.format));
      return {
        blob,
        name: renamedWithExtension(file.name, out.ext),
        contentType: out.mime,
        sizeBytes: blob.size,
      };
    } catch {
      // Fall through to the original. It may be large (the upload then fails with a clear "up to
      // 25 MB" message if it is too big); the server strips location and other metadata from every
      // image it accepts either way, so nothing private goes out with it.
    }
  }
  const blob = await readBlob(file.uri);
  return { blob, name: file.name, contentType: file.contentType, sizeBytes: blob.size };
}
