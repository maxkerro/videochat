package expo.modules.videoblur

import com.oney.WebRTCModule.videoEffects.ProcessorProvider
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessorFactoryInterface
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * CHAT-084: background blur for the phone's camera in calls. Registers a frame processor with
 * react-native-webrtc under [BlurProcessor.NAME]; JS turns it on for a camera track with
 * `track._setVideoEffects([name])` and off with `[]`. Once a second it reports how long a frame
 * took (`onStats`), so the app can turn blur off on a phone that can't keep up.
 */
class VideoBlurModule : Module() {
  private var processor: BlurProcessor? = null

  override fun definition() = ModuleDefinition {
    Name("VideoBlur")
    Events("onStats")

    OnCreate {
      // One processor for the app (one camera at a time): building one per toggle would leak
      // its segmenter and thread, because react-native-webrtc never tells a processor it's done.
      val shared = BlurProcessor { frameMs -> sendEvent("onStats", mapOf("frameMs" to frameMs)) }
      processor = shared
      ProcessorProvider.addProcessor(
        BlurProcessor.NAME,
        VideoFrameProcessorFactoryInterface { shared },
      )
    }

    Function("isSupported") { true }

    Function("processorName") { BlurProcessor.NAME }

    OnDestroy {
      try {
        ProcessorProvider.removeProcessor(BlurProcessor.NAME)
      } catch (_: RuntimeException) {
        // Not registered: nothing to remove.
      }
      processor?.close()
      processor = null
    }
  }
}
