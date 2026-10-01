import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Avatar, Menu, useToast, type MenuItem } from '../../components/ui';
import type { CallSnapshot } from './CallEngine';
import { useCalls } from './CallProvider';
import {
  describeMediaError,
  listDevices,
  loadDevicePreferences,
  saveDevicePreferences,
} from './mediaDevices';
import { StreamVideo } from './StreamVideo';
import { useCallTimer } from './useCallTimer';
import styles from './Calls.module.css';

export function callStatusText(call: CallSnapshot, timer: string | null): string {
  switch (call.phase) {
    case 'outgoing':
      return call.calleeRinging ? 'Ringing…' : 'Calling…';
    case 'incoming':
      return 'Incoming call…';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'active':
      return timer ?? '0:00';
    case 'ended':
      return 'Call ended';
  }
}

/** Self view the person can drag anywhere inside the call stage (CHAT-042 AC). */
function DraggableSelfView({ call }: { call: CallSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 16, bottom: 16 });
  const drag = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, ...pos };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    const el = ref.current;
    const stage = el?.parentElement;
    if (!start || !el || !stage) return;
    const maxRight = Math.max(0, stage.clientWidth - el.offsetWidth);
    const maxBottom = Math.max(0, stage.clientHeight - el.offsetHeight);
    setPos({
      right: Math.min(maxRight, Math.max(0, start.right - (e.clientX - start.x))),
      bottom: Math.min(maxBottom, Math.max(0, start.bottom - (e.clientY - start.y))),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={ref}
      className={styles.selfView}
      style={{ right: pos.right, bottom: pos.bottom }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid="call-self-view"
    >
      {call.videoEnabled && call.localStream ? (
        <StreamVideo stream={call.localStream} className={styles.selfVideo} label="Your camera" />
      ) : (
        <div className={styles.selfOff}>Camera off</div>
      )}
    </div>
  );
}

/** CHAT-042: the full-screen call. Remote video large, self view small and draggable, and the
 *  controls: mute (M), camera (V), devices, minimise, hang up, plus the call timer. */
export function CallView({ call }: { call: CallSnapshot }) {
  const calls = useCalls();
  const { toast } = useToast();
  const timer = useCallTimer(call.startedAt);
  const [devices, setDevices] = useState<MenuItem[]>([]);
  const hangUpRef = useRef<HTMLButtonElement>(null);

  // Keyboard users land on the controls rather than wherever focus was in the chat.
  useEffect(() => {
    hangUpRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listDevices().then(({ audioInputs, videoInputs }) => {
      if (cancelled) return;
      const pick = (kind: 'audioinput' | 'videoinput', deviceId: string) => async () => {
        try {
          await calls.switchDevice(kind, deviceId);
          const prefs = loadDevicePreferences();
          saveDevicePreferences(
            kind === 'audioinput'
              ? { ...prefs, audioInputId: deviceId }
              : { ...prefs, videoInputId: deviceId },
          );
        } catch (err) {
          const { title } = describeMediaError(err, kind === 'videoinput' ? 'video' : 'audio');
          toast({ title, tone: 'danger' });
        }
      };
      setDevices([
        ...audioInputs.map((d, i) => ({
          label: `Mic: ${d.label || `Microphone ${i + 1}`}`,
          onSelect: () => void pick('audioinput', d.deviceId)(),
        })),
        ...videoInputs.map((d, i) => ({
          label: `Camera: ${d.label || `Camera ${i + 1}`}`,
          onSelect: () => void pick('videoinput', d.deviceId)(),
        })),
      ]);
    });
    return () => {
      cancelled = true;
    };
  }, [calls, toast]);

  const showRemoteVideo =
    call.remoteVideoEnabled &&
    (call.remoteStream?.getVideoTracks().length ?? 0) > 0 &&
    call.phase !== 'outgoing';
  const status = callStatusText(call, timer);

  const toggleVideo = async () => {
    try {
      await calls.toggleVideo();
    } catch (err) {
      const { title, fix } = describeMediaError(err, 'video');
      toast({ title, description: fix, tone: 'danger' });
    }
  };

  return (
    <section className={styles.screen} aria-label={`Call with ${call.peer.displayName}`}>
      <div className={styles.stage}>
        {showRemoteVideo ? (
          <StreamVideo
            stream={call.remoteStream}
            className={styles.remoteVideo}
            label={`${call.peer.displayName}'s video`}
          />
        ) : (
          <div className={styles.placeholder}>
            <Avatar name={call.peer.displayName} src={call.peer.avatarUrl} size="lg" />
            <span className={styles.peerName}>{call.peer.displayName}</span>
          </div>
        )}
        <div className={styles.topBar}>
          <span className={styles.status} role="status" aria-live="polite">
            {status}
          </span>
          <span className={styles.badges}>
            {call.quality === 'poor' && call.phase === 'active' && (
              <span className={`${styles.badge} ${styles.badgeWarn}`}>Poor connection</span>
            )}
            {!call.remoteAudioEnabled && (
              <span className={styles.badge}>{call.peer.displayName} is muted</span>
            )}
            {!call.remoteVideoEnabled && call.media === 'video' && call.phase === 'active' && (
              <span className={styles.badge}>{call.peer.displayName}’s camera is off</span>
            )}
          </span>
        </div>
        {call.phase === 'reconnecting' && (
          <div className={styles.reconnecting} role="alert">
            <span className={styles.spinner} aria-hidden="true" />
            <span>Reconnecting…</span>
            <span className={styles.status}>
              The call ends if the connection doesn’t come back within 15 seconds.
            </span>
          </div>
        )}
        {call.lowBandwidth && call.videoEnabled && call.phase === 'active' && (
          <div className={styles.suggestion}>
            <span>Your connection is too slow for video.</span>
            <button
              type="button"
              className={styles.suggestionButton}
              onClick={() => void toggleVideo()}
            >
              Switch to audio only
            </button>
          </div>
        )}
        <DraggableSelfView call={call} />
      </div>
      <div className={styles.controls} role="toolbar" aria-label="Call controls">
        <button
          type="button"
          className={styles.control}
          aria-pressed={!call.audioEnabled}
          aria-label={call.audioEnabled ? 'Mute microphone (M)' : 'Unmute microphone (M)'}
          onClick={() => calls.toggleAudio()}
        >
          <span>{call.audioEnabled ? 'Mute' : 'Unmute'}</span>
          <span className={styles.kbd} aria-hidden="true">
            M
          </span>
        </button>
        <button
          type="button"
          className={styles.control}
          aria-pressed={!call.videoEnabled}
          aria-label={call.videoEnabled ? 'Turn camera off (V)' : 'Turn camera on (V)'}
          onClick={() => void toggleVideo()}
        >
          <span>{call.videoEnabled ? 'Camera off' : 'Camera on'}</span>
          <span className={styles.kbd} aria-hidden="true">
            V
          </span>
        </button>
        {devices.length > 0 && (
          <Menu
            trigger={
              <button
                type="button"
                className={styles.control}
                aria-label="Switch microphone or camera"
              >
                Devices
              </button>
            }
            items={devices}
          />
        )}
        <button
          type="button"
          className={styles.control}
          aria-label="Minimise call"
          onClick={() => calls.setExpanded(false)}
        >
          Minimise
        </button>
        <button
          ref={hangUpRef}
          type="button"
          className={`${styles.control} ${styles.hangUp}`}
          aria-label={call.phase === 'outgoing' ? 'Cancel call' : 'Hang up'}
          onClick={() => calls.hangUp()}
        >
          {call.phase === 'outgoing' ? 'Cancel' : 'Hang up'}
        </button>
      </div>
    </section>
  );
}
