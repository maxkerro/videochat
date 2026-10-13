/**
 * CHAT-043: turns RTCPeerConnection.getStats() reports into the two things the UI reacts to --
 * "is the connection poor?" and "is there too little bandwidth for video?" -- plus the running
 * totals for the end-of-call summary.
 *
 * Packet loss is measured per sampling window (the change since the previous report), not
 * cumulatively, so a bad patch early in a long call doesn't keep showing "poor" forever.
 */

/** AC: "Poor-connection indicator appears when packet loss exceeds 5%". */
export const POOR_PACKET_LOSS = 0.05;
/** Beyond this round-trip time conversation starts to feel laggy. */
export const POOR_RTT_SEC = 0.4;
/** Below this available outgoing bitrate, video will be a slideshow; suggest audio only. */
export const LOW_BITRATE_BPS = 150_000;

export interface StatsCounters {
  packetsLost: number;
  packetsReceived: number;
}

export interface QualitySample {
  /** Loss in this window as a ratio (0-1), or null if nothing was received in it. */
  packetLoss: number | null;
  rttSec: number | null;
  availableOutgoingBps: number | null;
  poor: boolean;
  lowBandwidth: boolean;
  counters: StatsCounters;
}

type StatLike = Record<string, unknown> & { type?: string };

export function analyzeStats(
  report: { forEach: (cb: (stat: StatLike) => void) => void },
  previous: StatsCounters | null,
): QualitySample {
  let packetsLost = 0;
  let packetsReceived = 0;
  let rttSec: number | null = null;
  let availableOutgoingBps: number | null = null;

  report.forEach((stat) => {
    if (stat.type === 'inbound-rtp') {
      packetsLost += numberOr(stat.packetsLost, 0);
      packetsReceived += numberOr(stat.packetsReceived, 0);
    } else if (
      stat.type === 'candidate-pair' &&
      (stat.nominated === true || stat.selected === true)
    ) {
      if (stat.state !== undefined && stat.state !== 'succeeded') return;
      const rtt = numberOr(stat.currentRoundTripTime, NaN);
      if (!Number.isNaN(rtt)) rttSec = rtt;
      const bps = numberOr(stat.availableOutgoingBitrate, NaN);
      if (!Number.isNaN(bps)) availableOutgoingBps = bps;
    }
  });

  const dLost = Math.max(0, packetsLost - (previous?.packetsLost ?? 0));
  const dReceived = Math.max(0, packetsReceived - (previous?.packetsReceived ?? 0));
  const packetLoss = dLost + dReceived > 0 ? dLost / (dLost + dReceived) : null;

  return {
    packetLoss,
    rttSec,
    availableOutgoingBps,
    poor:
      (packetLoss !== null && packetLoss > POOR_PACKET_LOSS) ||
      (rttSec !== null && rttSec > POOR_RTT_SEC),
    lowBandwidth: availableOutgoingBps !== null && availableOutgoingBps < LOW_BITRATE_BPS,
    counters: { packetsLost, packetsReceived },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Running aggregate for the end-of-call summary. */
export class StatsAccumulator {
  private rttTotal = 0;
  private rttCount = 0;
  private lossMax: number | null = null;
  private kbpsMin: number | null = null;

  add(sample: QualitySample): void {
    if (sample.rttSec !== null) {
      this.rttTotal += sample.rttSec * 1000;
      this.rttCount += 1;
    }
    if (sample.packetLoss !== null) {
      const pct = sample.packetLoss * 100;
      this.lossMax = this.lossMax === null ? pct : Math.max(this.lossMax, pct);
    }
    if (sample.availableOutgoingBps !== null) {
      const kbps = sample.availableOutgoingBps / 1000;
      this.kbpsMin = this.kbpsMin === null ? kbps : Math.min(this.kbpsMin, kbps);
    }
  }

  summary(): {
    rttMsAvg: number | null;
    packetLossPctMax: number | null;
    outgoingKbpsMin: number | null;
  } {
    return {
      rttMsAvg: this.rttCount > 0 ? Math.round(this.rttTotal / this.rttCount) : null,
      packetLossPctMax: this.lossMax === null ? null : Math.round(this.lossMax * 10) / 10,
      outgoingKbpsMin: this.kbpsMin === null ? null : Math.round(this.kbpsMin),
    };
  }
}
