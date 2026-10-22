#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * CHAT-084: background blur for the camera in calls. Registers a react-native-webrtc frame
 * processor; JS turns it on for a track with `track._setVideoEffects([name])`.
 */
@interface VBBlurRegistry : NSObject

/** Registers the processor under `name`. `stats` gets the average time per frame (ms), about
 *  once a second while blur is running. */
+ (void)registerWithName:(NSString *)name stats:(void (^)(double frameMs))stats;
+ (void)unregisterName:(NSString *)name;

@end

NS_ASSUME_NONNULL_END
