import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { IMAGE_QUALITY, MAX_IMAGE_EDGE, fitWithin, jpegName, shouldCompress } from './imageFit';
import type { PickedFile, PreparedFile } from '../uploads/flow';

async function readBlob(uri: string): Promise<Blob> {
  return (await fetch(uri)).blob();
}

/** Longest side at most 2048 px, re-encoded as JPEG (also turns an iPhone's HEIC into something
 *  every device can show). Returns the new file's uri. */
async function shrink(file: PickedFile): Promise<string> {
  const fit = fitWithin(file.width, file.height);
  const first = ImageManipulator.manipulate(file.uri);
  if (fit) first.resize({ width: fit.width, height: fit.height });
  const rendered = await first.renderAsync();
  // The picker did not tell us the size, and it turned out to be big: shrink the decoded image.
  const again = fit ? null : fitWithin(rendered.width, rendered.height, MAX_IMAGE_EDGE);
  const final = again
    ? await ImageManipulator.manipulate(rendered).resize(again).renderAsync()
    : rendered;
  return (await final.saveAsync({ format: SaveFormat.JPEG, compress: IMAGE_QUALITY })).uri;
}

/**
 * CHAT-056: reads the picked file into memory, shrinking photos first so a 12 MP shot uploads as
 * well under 1 MB. If shrinking fails for some reason the original is sent as it is.
 */
export async function prepareFile(file: PickedFile): Promise<PreparedFile> {
  if (shouldCompress(file.contentType)) {
    try {
      const blob = await readBlob(await shrink(file));
      return {
        blob,
        name: jpegName(file.name),
        contentType: 'image/jpeg',
        sizeBytes: blob.size,
      };
    } catch {
      // fall through to the original
    }
  }
  const blob = await readBlob(file.uri);
  return { blob, name: file.name, contentType: file.contentType, sizeBytes: blob.size };
}
