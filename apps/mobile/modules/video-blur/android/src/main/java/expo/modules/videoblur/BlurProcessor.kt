package expo.modules.videoblur

import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.Segmenter
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import livekit.org.webrtc.JavaI420Buffer
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.VideoFrame

/**
 * CHAT-084: blurs everything behind the person in the camera picture.
 *
 * Each frame is converted to I420 (CPU). A small copy (≈256 px wide, turned upright) goes to ML
 * Kit's selfie segmenter on a background thread; the newest person mask it produced is used for
 * the frames that arrive meanwhile, so segmentation never holds up the camera. The background is
 * a cheap blur (downsample, box blur, bilinear upsample) mixed with the original by the mask.
 *
 * Privacy rule: once blur is on, the raw picture is never sent. Until the first mask is ready
 * the whole frame is blurred, and if anything goes wrong the frame is black. (react-native-webrtc
 * sends the raw frame when a processor returns null, so this never returns null.)
 */
class BlurProcessor(private val stats: (Double) -> Unit) : VideoFrameProcessor {
  companion object {
    const val NAME = "videochat-blur"
    private const val SEG_WIDTH = 256
    private const val DOWNSAMPLE = 8
    private const val BLUR_RADIUS = 2
  }

  /** A person mask in the camera buffer's orientation, values 0 (background) .. 1 (person). */
  private class Mask(val data: FloatArray, val width: Int, val height: Int, val rotation: Int, val aspect: Float)

  private val segmenter: Segmenter =
    Segmentation.getClient(
      SelfieSegmenterOptions.Builder()
        .setDetectorMode(SelfieSegmenterOptions.STREAM_MODE)
        .build(),
    )
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)
  private val closed = AtomicBoolean(false)
  @Volatile private var mask: Mask? = null

  private var windowStart = 0L
  private var windowFrames = 0
  private var windowMs = 0.0

  override fun process(frame: VideoFrame, textureHelper: SurfaceTextureHelper?): VideoFrame {
    val started = SystemClock.elapsedRealtimeNanos()
    val out =
      try {
        blur(frame)
      } catch (t: Throwable) {
        black(frame)
      }
    report((SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0)
    return out
  }

  fun close() {
    if (!closed.compareAndSet(false, true)) return
    mask = null
    executor.execute { segmenter.close() }
    executor.shutdown()
  }

  private fun report(frameMs: Double) {
    val now = SystemClock.elapsedRealtime()
    if (windowStart == 0L) windowStart = now
    windowFrames++
    windowMs += frameMs
    if (now - windowStart >= 1000) {
      val avg = windowMs / windowFrames
      windowStart = now
      windowFrames = 0
      windowMs = 0.0
      try {
        stats(avg)
      } catch (_: Throwable) {
        // Stats are advisory.
      }
    }
  }

  private fun blur(frame: VideoFrame): VideoFrame {
    val i420 = frame.buffer.toI420() ?: return black(frame)
    try {
      val w = i420.width
      val h = i420.height
      if (w < 16 || h < 16) return black(frame)
      requestMask(i420, frame.rotation)
      val current = mask?.takeIf { it.rotation == frame.rotation && kotlin.math.abs(it.aspect - w.toFloat() / h) < 0.01f }
      val out = JavaI420Buffer.allocate(w, h)
      compositePlane(i420.dataY, i420.strideY, out.dataY, out.strideY, w, h, DOWNSAMPLE, current)
      val cw = (w + 1) / 2
      val ch = (h + 1) / 2
      compositePlane(i420.dataU, i420.strideU, out.dataU, out.strideU, cw, ch, DOWNSAMPLE / 2, current)
      compositePlane(i420.dataV, i420.strideV, out.dataV, out.strideV, cw, ch, DOWNSAMPLE / 2, current)
      return VideoFrame(out, frame.rotation, frame.timestampNs)
    } finally {
      i420.release()
    }
  }

  /** out = a·orig + (1−a)·blurred, where a is the person mask (0 everywhere when there's none). */
  private fun compositePlane(
    src: ByteBuffer,
    srcStride: Int,
    dst: ByteBuffer,
    dstStride: Int,
    pw: Int,
    ph: Int,
    factor: Int,
    m: Mask?,
  ) {
    val sw = maxOf(1, pw / factor)
    val sh = maxOf(1, ph / factor)
    val small = FloatArray(sw * sh)
    // Downsample: box average of each factor×factor block.
    for (sy in 0 until sh) {
      val y0 = sy * factor
      val y1 = minOf(ph, y0 + factor)
      for (sx in 0 until sw) {
        val x0 = sx * factor
        val x1 = minOf(pw, x0 + factor)
        var sum = 0
        for (y in y0 until y1) {
          val row = y * srcStride
          for (x in x0 until x1) sum += src.get(row + x).toInt() and 0xff
        }
        small[sy * sw + sx] = sum.toFloat() / ((y1 - y0) * (x1 - x0))
      }
    }
    boxBlur(small, sw, sh, BLUR_RADIUS)
    boxBlur(small, sw, sh, BLUR_RADIUS)

    val scaleX = sw.toFloat() / pw
    val scaleY = sh.toFloat() / ph
    val maskScaleX = if (m != null) m.width.toFloat() / pw else 0f
    val maskScaleY = if (m != null) m.height.toFloat() / ph else 0f
    for (y in 0 until ph) {
      val srcRow = y * srcStride
      val dstRow = y * dstStride
      val fy = (y + 0.5f) * scaleY - 0.5f
      val my = (y + 0.5f) * maskScaleY - 0.5f
      for (x in 0 until pw) {
        val a = if (m != null) sample(m.data, m.width, m.height, (x + 0.5f) * maskScaleX - 0.5f, my) else 0f
        val orig = (src.get(srcRow + x).toInt() and 0xff).toFloat()
        val value =
          if (a >= 0.98f) {
            orig
          } else {
            val b = sample(small, sw, sh, (x + 0.5f) * scaleX - 0.5f, fy)
            a * orig + (1f - a) * b
          }
        dst.put(dstRow + x, value.toInt().coerceIn(0, 255).toByte())
      }
    }
  }

  private fun requestMask(i420: VideoFrame.I420Buffer, rotation: Int) {
    if (closed.get() || !busy.compareAndSet(false, true)) return
    try {
      val w = i420.width
      val h = i420.height
      val sw = minOf(SEG_WIDTH, w)
      val sh = maxOf(1, h * sw / w)
      val pixels = IntArray(sw * sh)
      val dataY = i420.dataY
      val dataU = i420.dataU
      val dataV = i420.dataV
      for (y in 0 until sh) {
        val iy = y * h / sh
        for (x in 0 until sw) {
          val ix = x * w / sw
          val yy = (dataY.get(iy * i420.strideY + ix).toInt() and 0xff) - 16
          val u = (dataU.get((iy / 2) * i420.strideU + ix / 2).toInt() and 0xff) - 128
          val v = (dataV.get((iy / 2) * i420.strideV + ix / 2).toInt() and 0xff) - 128
          // BT.601 limited range.
          val c = 1.164f * yy
          val r = (c + 1.596f * v).toInt().coerceIn(0, 255)
          val g = (c - 0.392f * u - 0.813f * v).toInt().coerceIn(0, 255)
          val b = (c + 2.017f * u).toInt().coerceIn(0, 255)
          pixels[y * sw + x] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }
      }
      val small = Bitmap.createBitmap(pixels, sw, sh, Bitmap.Config.ARGB_8888)
      val upright =
        if (rotation % 360 == 0) {
          small
        } else {
          Bitmap.createBitmap(small, 0, 0, sw, sh, Matrix().apply { postRotate(rotation.toFloat()) }, false)
        }
      val aspect = w.toFloat() / h
      segmenter
        .process(InputImage.fromBitmap(upright, 0))
        .addOnSuccessListener(executor) { result ->
          if (closed.get()) return@addOnSuccessListener
          val buf = result.buffer
          buf.rewind()
          val floats = buf.order(ByteOrder.nativeOrder()).asFloatBuffer()
          val uw = result.width
          val uh = result.height
          val upMask = FloatArray(uw * uh)
          floats.get(upMask, 0, minOf(upMask.size, floats.remaining()))
          mask = Mask(toBufferOrientation(upMask, uw, uh, sw, sh, rotation), sw, sh, rotation, aspect)
        }
        .addOnCompleteListener(executor) {
          if (small !== upright) upright.recycle()
          small.recycle()
          busy.set(false)
        }
    } catch (t: Throwable) {
      busy.set(false)
    }
  }

  /**
   * The mask comes back upright (the picture after turning it clockwise by `rotation`); map it
   * back to the camera buffer's own orientation, `bw`×`bh`.
   */
  private fun toBufferOrientation(
    up: FloatArray,
    uw: Int,
    uh: Int,
    bw: Int,
    bh: Int,
    rotation: Int,
  ): FloatArray {
    val out = FloatArray(bw * bh)
    val r = ((rotation % 360) + 360) % 360
    // Upright size in buffer pixels, then scale into the mask's own size.
    val rw = if (r == 90 || r == 270) bh else bw
    val rh = if (r == 90 || r == 270) bw else bh
    val sx = uw.toFloat() / rw
    val sy = uh.toFloat() / rh
    for (y in 0 until bh) {
      for (x in 0 until bw) {
        val ux: Int
        val uy: Int
        when (r) {
          90 -> { ux = bh - 1 - y; uy = x }
          180 -> { ux = bw - 1 - x; uy = bh - 1 - y }
          270 -> { ux = y; uy = bw - 1 - x }
          else -> { ux = x; uy = y }
        }
        val mx = minOf(uw - 1, (ux * sx).toInt())
        val my = minOf(uh - 1, (uy * sy).toInt())
        out[y * bw + x] = up[my * uw + mx]
      }
    }
    return out
  }

  private fun black(frame: VideoFrame): VideoFrame {
    val w = maxOf(2, frame.buffer.width)
    val h = maxOf(2, frame.buffer.height)
    val out = JavaI420Buffer.allocate(w, h)
    fill(out.dataY, 16)
    fill(out.dataU, 128)
    fill(out.dataV, 128)
    return VideoFrame(out, frame.rotation, frame.timestampNs)
  }

  private fun fill(buf: ByteBuffer, value: Int) {
    val b = value.toByte()
    for (i in 0 until buf.capacity()) buf.put(i, b)
  }
}

/** Separable box blur, in place. */
private fun boxBlur(data: FloatArray, w: Int, h: Int, radius: Int) {
  val tmp = FloatArray(maxOf(w, h))
  for (y in 0 until h) {
    val row = y * w
    for (x in 0 until w) {
      var sum = 0f
      var n = 0
      for (k in -radius..radius) {
        val xx = x + k
        if (xx in 0 until w) {
          sum += data[row + xx]
          n++
        }
      }
      tmp[x] = sum / n
    }
    System.arraycopy(tmp, 0, data, row, w)
  }
  for (x in 0 until w) {
    for (y in 0 until h) {
      var sum = 0f
      var n = 0
      for (k in -radius..radius) {
        val yy = y + k
        if (yy in 0 until h) {
          sum += data[yy * w + x]
          n++
        }
      }
      tmp[y] = sum / n
    }
    for (y in 0 until h) data[y * w + x] = tmp[y]
  }
}

/** Bilinear sample with edge clamping. */
private fun sample(data: FloatArray, w: Int, h: Int, fx: Float, fy: Float): Float {
  val x = fx.coerceIn(0f, (w - 1).toFloat())
  val y = fy.coerceIn(0f, (h - 1).toFloat())
  val x0 = x.toInt()
  val y0 = y.toInt()
  val x1 = minOf(w - 1, x0 + 1)
  val y1 = minOf(h - 1, y0 + 1)
  val tx = x - x0
  val ty = y - y0
  val top = data[y0 * w + x0] * (1 - tx) + data[y0 * w + x1] * tx
  val bottom = data[y1 * w + x0] * (1 - tx) + data[y1 * w + x1] * tx
  return top * (1 - ty) + bottom * ty
}
