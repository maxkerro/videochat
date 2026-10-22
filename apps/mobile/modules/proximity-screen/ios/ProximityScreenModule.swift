import ExpoModulesCore
import UIKit

/// CHAT-083: screen off against the ear during an audio call on the earpiece. CallKit usually
/// does this for the active call by itself; turning proximity monitoring on as well is harmless
/// and covers the moments CallKit doesn't (e.g. while a call is still connecting).
public class ProximityScreenModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ProximityScreen")

    Function("isSupported") { () -> Bool in
      return true
    }

    AsyncFunction("setEnabled") { (enabled: Bool) in
      UIDevice.current.isProximityMonitoringEnabled = enabled
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async { UIDevice.current.isProximityMonitoringEnabled = false }
    }
  }
}
