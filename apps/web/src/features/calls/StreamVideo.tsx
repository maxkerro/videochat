import { useEffect, useRef } from 'react';

/** A <video> bound to a MediaStream. Always muted: remote audio plays from CallProvider's own
 *  <audio> element, so it keeps playing when this unmounts (minimised call, another route). */
export function StreamVideo({
  stream,
  className,
  label,
}: {
  stream: MediaStream | null;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted aria-label={label} />;
}
