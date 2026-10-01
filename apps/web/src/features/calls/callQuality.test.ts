import { analyzeStats, StatsAccumulator } from './callQuality';

const report = (stats: Record<string, unknown>[]) => ({
  forEach: (cb: (s: Record<string, unknown>) => void) => stats.forEach(cb),
});
const inbound = (packetsReceived: number, packetsLost: number) => ({
  type: 'inbound-rtp',
  packetsReceived,
  packetsLost,
});
const pair = (rtt: number, bps?: number) => ({
  type: 'candidate-pair',
  nominated: true,
  state: 'succeeded',
  currentRoundTripTime: rtt,
  availableOutgoingBitrate: bps,
});

describe('analyzeStats (CHAT-043)', () => {
  it('is good with low loss and a short round trip', () => {
    const s = analyzeStats(report([inbound(1000, 10), pair(0.05, 2_000_000)]), null);
    expect(s.packetLoss).toBeCloseTo(10 / 1010);
    expect(s.poor).toBe(false);
    expect(s.lowBandwidth).toBe(false);
  });

  it('flags a poor connection once packet loss exceeds 5%', () => {
    const s = analyzeStats(report([inbound(900, 100), pair(0.05)]), null);
    expect(s.poor).toBe(true);
  });

  it('measures loss per window, so an old bad patch stops counting', () => {
    const first = analyzeStats(report([inbound(900, 100)]), null);
    expect(first.poor).toBe(true);
    const later = analyzeStats(report([inbound(1900, 101)]), first.counters);
    expect(later.packetLoss).toBeCloseTo(1 / 1001);
    expect(later.poor).toBe(false);
  });

  it('sums loss across the audio and video streams', () => {
    const s = analyzeStats(report([inbound(500, 0), inbound(400, 100)]), null);
    expect(s.packetLoss).toBeCloseTo(100 / 1000);
  });

  it('flags a long round trip as poor', () => {
    expect(analyzeStats(report([pair(0.6)]), null).poor).toBe(true);
  });

  it('flags too little outgoing bandwidth for video', () => {
    expect(analyzeStats(report([pair(0.05, 100_000)]), null).lowBandwidth).toBe(true);
  });

  it('ignores candidate pairs that are not the selected one', () => {
    const s = analyzeStats(
      report([{ type: 'candidate-pair', nominated: false, currentRoundTripTime: 5 }]),
      null,
    );
    expect(s.rttSec).toBeNull();
    expect(s.poor).toBe(false);
  });
});

describe('StatsAccumulator', () => {
  it('summarises average RTT, worst loss and lowest bandwidth', () => {
    const acc = new StatsAccumulator();
    acc.add(analyzeStats(report([inbound(990, 10), pair(0.1, 800_000)]), null));
    acc.add(
      analyzeStats(report([inbound(1900, 110), pair(0.3, 300_000)]), {
        packetsReceived: 990,
        packetsLost: 10,
      }),
    );
    expect(acc.summary()).toEqual({ rttMsAvg: 200, packetLossPctMax: 9.9, outgoingKbpsMin: 300 });
  });

  it('reports nulls when nothing was measured', () => {
    expect(new StatsAccumulator().summary()).toEqual({
      rttMsAvg: null,
      packetLossPctMax: null,
      outgoingKbpsMin: null,
    });
  });
});
