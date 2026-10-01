import type { CallMedia } from '@videochat/shared';
import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '../../components/ui';
import type { CallPeer } from './CallEngine';
import { useCalls } from './CallProvider';
import {
  acquireMedia,
  describeMediaError,
  listDevices,
  loadDevicePreferences,
  saveDevicePreferences,
  type DevicePreferences,
} from './mediaDevices';
import { StreamVideo } from './StreamVideo';
import styles from './Calls.module.css';

/**
 * CHAT-042 AC: "Pre-join check for camera and microphone with device selection." Opens the
 * devices before the call is placed, so a permission problem is explained here -- with how to
 * fix it -- rather than surfacing as a silent call.
 */
export function PreJoinDialog({
  open,
  onOpenChange,
  media,
  peer,
  conversationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  media: CallMedia;
  peer: CallPeer;
  conversationId: string;
}) {
  const calls = useCalls();
  const [prefs, setPrefs] = useState<DevicePreferences>(loadDevicePreferences);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<{ title: string; fix: string } | null>(null);
  const [devices, setDevices] = useState<{
    audioInputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
  }>({ audioInputs: [], videoInputs: [] });
  const [attempt, setAttempt] = useState(0);
  /** Set once the stream is handed to the call, so closing the dialog doesn't stop it. */
  const handedOver = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    handedOver.current = false;
    acquireMedia(media, prefs)
      .then(async (s) => {
        acquired = s;
        if (cancelled) return;
        setStream(s);
        // Device labels are only available once permission has been granted.
        const list = await listDevices();
        if (!cancelled) setDevices(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStream(null);
          setError(describeMediaError(err, media));
        }
      });
    return () => {
      cancelled = true;
      if (acquired && !handedOver.current) for (const t of acquired.getTracks()) t.stop();
      setStream(null);
    };
  }, [open, media, prefs, attempt]);

  const start = () => {
    if (!stream) return;
    saveDevicePreferences(prefs);
    handedOver.current = true;
    calls.startCall({ conversationId, peer, media, stream });
    onOpenChange(false);
  };

  const busy = calls.call !== null && calls.call.phase !== 'ended';
  const kind = media === 'video' ? 'video' : 'audio';

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Start ${kind} call with ${peer.displayName}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={start} disabled={!stream || busy}>
            Call
          </Button>
        </>
      }
    >
      {media === 'video' && (
        <div className={styles.preview}>
          {stream ? (
            <StreamVideo
              stream={stream}
              className={styles.previewVideo}
              label="Your camera preview"
            />
          ) : (
            <span>{error ? 'Camera unavailable' : 'Starting camera…'}</span>
          )}
        </div>
      )}
      {media === 'audio' && (
        <p>
          {stream
            ? 'Microphone ready.'
            : error
              ? 'Microphone unavailable.'
              : 'Checking your microphone…'}
        </p>
      )}
      {error && (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>{error.title}</p>
          <p>{error.fix}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {devices.audioInputs.length > 1 && (
        <label className={styles.field}>
          Microphone
          <select
            className={styles.select}
            value={prefs.audioInputId ?? ''}
            onChange={(e) => {
              setError(null);
              setPrefs((p) => ({ ...p, audioInputId: e.target.value || undefined }));
            }}
          >
            <option value="">Default</option>
            {devices.audioInputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {media === 'video' && devices.videoInputs.length > 1 && (
        <label className={styles.field}>
          Camera
          <select
            className={styles.select}
            value={prefs.videoInputId ?? ''}
            onChange={(e) => {
              setError(null);
              setPrefs((p) => ({ ...p, videoInputId: e.target.value || undefined }));
            }}
          >
            <option value="">Default</option>
            {devices.videoInputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {busy && <p className={styles.error}>Hang up your current call first.</p>}
    </Modal>
  );
}
