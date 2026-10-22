import ExpoModulesCore

/// CHAT-084: background blur for the camera in calls. The frame processor itself is
/// Objective-C (VBBlurProcessor.m) so it can conform to react-native-webrtc's protocol directly.
public class VideoBlurModule: Module {
  static let processorName = "videochat-blur"

  public func definition() -> ModuleDefinition {
    Name("VideoBlur")
    Events("onStats")

    OnCreate {
      VBBlurRegistry.register(withName: VideoBlurModule.processorName) { [weak self] frameMs in
        self?.sendEvent("onStats", ["frameMs": frameMs])
      }
    }

    Function("isSupported") { () -> Bool in
      if #available(iOS 15.0, *) { return true }
      return false
    }

    Function("processorName") { VideoBlurModule.processorName }

    OnDestroy {
      VBBlurRegistry.unregisterName(VideoBlurModule.processorName)
    }
  }
}
