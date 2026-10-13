import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';
import { tick } from '../ui/haptics';
import { useTheme } from '../ui/theme';
import { useReduceMotion } from '../ui/useReduceMotion';
import { isReplySwipe, reachedThreshold, swipeOffset } from './swipe';

/**
 * CHAT-057: drag a message to the right and let go to reply to it, with a haptic tick at the
 * point where letting go counts. With "reduce motion" on, the message stays put (the tick and the
 * reply still happen). The same reply is also an accessibility action on the bubble.
 */
export function SwipeToReply({
  enabled,
  onReply,
  children,
}: {
  enabled: boolean;
  onReply: () => void;
  children: ReactNode;
}) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const [x] = useState(() => new Animated.Value(0));
  const passed = useRef(false);
  // The responder is created once; it reads the latest props through this ref.
  const latest = useRef({ enabled, onReply, reduceMotion });
  useEffect(() => {
    latest.current = { enabled, onReply, reduceMotion };
  });

  const responder = useMemo(() => {
    const settle = () =>
      Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 0 }).start();
    // The refs inside are only read when a touch event arrives, never while rendering.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => latest.current.enabled && isReplySwipe(g.dx, g.dy),
      // Once we have taken over the gesture, the list must not scroll away from under it.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        passed.current = false;
      },
      onPanResponderMove: (_e, g) => {
        if (!latest.current.reduceMotion) x.setValue(swipeOffset(g.dx));
        const reached = reachedThreshold(g.dx);
        if (reached && !passed.current) tick();
        passed.current = reached;
      },
      onPanResponderRelease: (_e, g) => {
        settle();
        if (reachedThreshold(g.dx)) latest.current.onReply();
      },
      onPanResponderTerminate: settle,
    });
  }, [x]);

  if (!enabled) return <>{children}</>;
  const iconOpacity = x.interpolate({ inputRange: [0, 40, 64], outputRange: [0, 0.5, 1] });
  return (
    <View {...responder.panHandlers}>
      <Animated.View style={[styles.icon, { opacity: iconOpacity }]} pointerEvents="none">
        <Text style={{ color: t.accent, fontSize: 20 }}>↩</Text>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: x }] }}>{children}</Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { position: 'absolute', left: 16, top: 0, bottom: 0, justifyContent: 'center' },
});
