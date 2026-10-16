# Background blur model (CHAT-075)

`selfie_segmenter.tflite` is MediaPipe's selfie segmentation model (general, 256×256), from the
`@mediapipe/selfie_segmentation` npm package (Apache License 2.0, © Google LLC), with TFLite
metadata added (input normalisation mean 0 / std 255, one "person" label) so MediaPipe Tasks'
`ImageSegmenter` can load it -- the same model Google publishes as `selfie_segmenter.tflite`.

Recreate it with `tflite-support` 0.4.4 (Python 3.11):

```python
from tflite_support.metadata_writers import image_segmenter, writer_utils
model = writer_utils.load_file('selfie_segmentation.tflite')
open('labels.txt', 'w').write('person\n')
writer = image_segmenter.MetadataWriter.create_for_inference(model, [0.0], [255.0], ['labels.txt'])
writer_utils.save_file(writer.populate(), 'selfie_segmenter.tflite')
```
