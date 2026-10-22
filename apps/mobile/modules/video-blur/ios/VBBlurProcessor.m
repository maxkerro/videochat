#import "VBBlurProcessor.h"

#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>
#import <Vision/Vision.h>
#import <LiveKitWebRTC/RTCCVPixelBuffer.h>
#import <LiveKitWebRTC/RTCVideoCapturer.h>
#import <LiveKitWebRTC/RTCVideoFrame.h>

#if __has_include(<livekit_react_native_webrtc/ProcessorProvider.h>)
#import <livekit_react_native_webrtc/ProcessorProvider.h>
#elif __has_include(<livekit-react-native-webrtc/ProcessorProvider.h>)
#import <livekit-react-native-webrtc/ProcessorProvider.h>
#else
#import "ProcessorProvider.h"
#endif

/**
 * Blurs everything behind the person. Vision's person segmentation runs on a background queue
 * on the newest frame while the previous mask is used for the frames in between, so the camera
 * is never held up. Privacy rule: once blur is on, the raw picture is never sent -- until the
 * first mask arrives the whole frame is blurred, and if a frame can't be processed it's black.
 */
@interface VBBlurProcessor : NSObject <VideoFrameProcessorDelegate>
- (instancetype)initWithStats:(void (^)(double))stats;
@end

@implementation VBBlurProcessor {
  void (^_stats)(double);
  CIContext *_context;
  dispatch_queue_t _segQueue;
  BOOL _busy;  // guarded by @synchronized(self)
  CIImage *_mask;  // in buffer orientation, scaled to _maskSize; guarded by @synchronized(self)
  CGSize _maskSize;
  NSInteger _maskRotation;
  CVPixelBufferPoolRef _pool;
  size_t _poolWidth;
  size_t _poolHeight;
  CFTimeInterval _windowStart;
  NSInteger _windowFrames;
  double _windowMs;
}

- (instancetype)initWithStats:(void (^)(double))stats {
  if ((self = [super init])) {
    _stats = [stats copy];
    _context = [CIContext contextWithOptions:@{kCIContextCacheIntermediates : @NO}];
    _segQueue = dispatch_queue_create("videochat.blur.segmentation", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)dealloc {
  if (_pool) CVPixelBufferPoolRelease(_pool);
}

- (LKRTCVideoFrame *)capturer:(LKRTCVideoCapturer *)capturer
         didCaptureVideoFrame:(LKRTCVideoFrame *)frame {
  CFTimeInterval started = CACurrentMediaTime();
  LKRTCVideoFrame *out = nil;
  @try {
    out = [self blur:frame];
  } @catch (NSException *e) {
    out = nil;
  }
  if (!out) out = [self black:frame];
  [self report:(CACurrentMediaTime() - started) * 1000.0];
  return out;
}

- (void)report:(double)frameMs {
  CFTimeInterval now = CACurrentMediaTime();
  if (_windowStart == 0) _windowStart = now;
  _windowFrames++;
  _windowMs += frameMs;
  if (now - _windowStart >= 1.0) {
    double avg = _windowMs / _windowFrames;
    _windowStart = now;
    _windowFrames = 0;
    _windowMs = 0;
    if (_stats) _stats(avg);
  }
}

static CGImagePropertyOrientation uprightOrientation(NSInteger rotation) {
  switch (rotation) {
    case 90: return kCGImagePropertyOrientationRight;
    case 180: return kCGImagePropertyOrientationDown;
    case 270: return kCGImagePropertyOrientationLeft;
    default: return kCGImagePropertyOrientationUp;
  }
}

static CGImagePropertyOrientation inverseOrientation(CGImagePropertyOrientation o) {
  switch (o) {
    case kCGImagePropertyOrientationRight: return kCGImagePropertyOrientationLeft;
    case kCGImagePropertyOrientationLeft: return kCGImagePropertyOrientationRight;
    default: return o;
  }
}

/** Moves an image's extent to start at the origin. */
static CIImage *atOrigin(CIImage *image) {
  CGRect e = image.extent;
  return [image imageByApplyingTransform:CGAffineTransformMakeTranslation(-e.origin.x, -e.origin.y)];
}

- (nullable LKRTCVideoFrame *)blur:(LKRTCVideoFrame *)frame {
  if (![frame.buffer isKindOfClass:[LKRTCCVPixelBuffer class]]) return nil;
  CVPixelBufferRef source = ((LKRTCCVPixelBuffer *)frame.buffer).pixelBuffer;
  size_t w = CVPixelBufferGetWidth(source);
  size_t h = CVPixelBufferGetHeight(source);
  if (w < 16 || h < 16) return nil;
  NSInteger rotation = (NSInteger)frame.rotation;

  CIImage *input = [CIImage imageWithCVPixelBuffer:source];
  [self requestMaskFor:input rotation:rotation];

  CIImage *mask = nil;
  @synchronized(self) {
    if (_mask && _maskRotation == rotation && _maskSize.width == w && _maskSize.height == h) {
      mask = _mask;
    }
  }

  CGFloat sigma = MAX(8.0, (CGFloat)MIN(w, h) / 36.0);
  CIImage *blurred = [[[input imageByClampingToExtent] imageByApplyingGaussianBlurWithSigma:sigma]
      imageByCroppingToRect:input.extent];
  CIImage *composed = blurred;
  if (mask) {
    composed = [input imageByApplyingFilter:@"CIBlendWithMask"
                        withInputParameters:@{
                          kCIInputBackgroundImageKey : blurred,
                          kCIInputMaskImageKey : mask,
                        }];
  }

  CVPixelBufferRef target = [self outputBufferWidth:w height:h];
  if (!target) return nil;
  [_context render:composed toCVPixelBuffer:target];
  LKRTCCVPixelBuffer *buffer = [[LKRTCCVPixelBuffer alloc] initWithPixelBuffer:target];
  CVPixelBufferRelease(target);
  return [[LKRTCVideoFrame alloc] initWithBuffer:buffer
                                        rotation:frame.rotation
                                     timeStampNs:frame.timeStampNs];
}

- (void)requestMaskFor:(CIImage *)input rotation:(NSInteger)rotation {
  @synchronized(self) {
    if (_busy) return;
    _busy = YES;
  }
  CGSize size = input.extent.size;
  dispatch_async(_segQueue, ^{
    @autoreleasepool {
      CIImage *found = nil;
      @try {
        CGImagePropertyOrientation up = uprightOrientation(rotation);
        CIImage *upright = atOrigin([input imageByApplyingCGOrientation:up]);
        VNGeneratePersonSegmentationRequest *request = [[VNGeneratePersonSegmentationRequest alloc] init];
        request.qualityLevel = VNGeneratePersonSegmentationRequestQualityLevelBalanced;
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8;
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCIImage:upright options:@{}];
        NSError *error = nil;
        if ([handler performRequests:@[ request ] error:&error]) {
          VNPixelBufferObservation *result = request.results.firstObject;
          if (result) {
            // Back to the camera buffer's own orientation, then stretched over the whole frame.
            CIImage *m = atOrigin([[CIImage imageWithCVPixelBuffer:result.pixelBuffer]
                imageByApplyingCGOrientation:inverseOrientation(up)]);
            CGFloat sx = size.width / m.extent.size.width;
            CGFloat sy = size.height / m.extent.size.height;
            found = [m imageByApplyingTransform:CGAffineTransformMakeScale(sx, sy)];
          }
        }
      } @catch (NSException *e) {
        found = nil;
      }
      @synchronized(self) {
        if (found) {
          self->_mask = found;
          self->_maskSize = size;
          self->_maskRotation = rotation;
        }
        self->_busy = NO;
      }
    }
  });
}

- (nullable CVPixelBufferRef)outputBufferWidth:(size_t)w height:(size_t)h CF_RETURNS_RETAINED {
  if (!_pool || _poolWidth != w || _poolHeight != h) {
    if (_pool) CVPixelBufferPoolRelease(_pool);
    _pool = NULL;
    NSDictionary *attrs = @{
      (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
      (id)kCVPixelBufferWidthKey : @(w),
      (id)kCVPixelBufferHeightKey : @(h),
      (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
    };
    if (CVPixelBufferPoolCreate(NULL, NULL, (__bridge CFDictionaryRef)attrs, &_pool) != kCVReturnSuccess) {
      _pool = NULL;
      return NULL;
    }
    _poolWidth = w;
    _poolHeight = h;
  }
  CVPixelBufferRef buffer = NULL;
  if (CVPixelBufferPoolCreatePixelBuffer(NULL, _pool, &buffer) != kCVReturnSuccess) return NULL;
  return buffer;
}

- (LKRTCVideoFrame *)black:(LKRTCVideoFrame *)frame {
  size_t w = MAX(2, frame.width);
  size_t h = MAX(2, frame.height);
  CVPixelBufferRef target = NULL;
  NSDictionary *attrs = @{(id)kCVPixelBufferIOSurfacePropertiesKey : @{}};
  CVPixelBufferCreate(NULL, w, h, kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attrs, &target);
  if (target) {
    CVPixelBufferLockBaseAddress(target, 0);
    uint8_t *base = CVPixelBufferGetBaseAddress(target);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(target);
    for (size_t y = 0; y < h; y++) {
      uint8_t *row = base + y * bytesPerRow;
      for (size_t x = 0; x < w; x++) {
        row[x * 4 + 0] = 0;
        row[x * 4 + 1] = 0;
        row[x * 4 + 2] = 0;
        row[x * 4 + 3] = 255;
      }
    }
    CVPixelBufferUnlockBaseAddress(target, 0);
  }
  LKRTCCVPixelBuffer *buffer = [[LKRTCCVPixelBuffer alloc] initWithPixelBuffer:target];
  if (target) CVPixelBufferRelease(target);
  return [[LKRTCVideoFrame alloc] initWithBuffer:buffer
                                        rotation:frame.rotation
                                     timeStampNs:frame.timeStampNs];
}

@end

@implementation VBBlurRegistry

+ (void)registerWithName:(NSString *)name stats:(void (^)(double))stats {
  // One processor for the app (one camera at a time).
  [ProcessorProvider addProcessor:[[VBBlurProcessor alloc] initWithStats:stats] forName:name];
}

+ (void)unregisterName:(NSString *)name {
  [ProcessorProvider removeProcessor:name];
}

@end
