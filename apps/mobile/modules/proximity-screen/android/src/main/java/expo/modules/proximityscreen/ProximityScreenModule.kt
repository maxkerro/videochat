package expo.modules.proximityscreen

import android.content.Context
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * CHAT-083: turns the screen off while the phone is held against the ear during an audio call
 * on the earpiece, so a cheek can't press mute or hang up. Android's self-managed Telecom calls
 * don't do this themselves (react-native-incall-manager used to, before CHAT-061).
 *
 * A PROXIMITY_SCREEN_OFF_WAKE_LOCK does it all in the system: screen off while the sensor is
 * covered, on again when it's uncovered. The JS side decides when to hold it.
 */
class ProximityScreenModule : Module() {
  private var wakeLock: PowerManager.WakeLock? = null

  private val powerManager: PowerManager?
    get() = appContext.reactContext?.getSystemService(Context.POWER_SERVICE) as? PowerManager

  override fun definition() = ModuleDefinition {
    Name("ProximityScreen")

    Function("isSupported") {
      powerManager?.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) == true
    }

    Function("setEnabled") { enabled: Boolean ->
      if (enabled) acquire() else release()
    }

    OnDestroy { release() }
  }

  @Synchronized
  private fun acquire() {
    if (wakeLock?.isHeld == true) return
    val pm = powerManager ?: return
    if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
    val lock = wakeLock
      ?: pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "videochat:proximity").also {
        it.setReferenceCounted(false)
        wakeLock = it
      }
    lock.acquire()
  }

  @Synchronized
  private fun release() {
    val lock = wakeLock ?: return
    // Wait for "no proximity" before turning the screen back on, so it doesn't flash on while
    // the phone is still at the ear when the call ends.
    if (lock.isHeld) lock.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
  }
}
