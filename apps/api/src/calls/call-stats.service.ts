import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CallStats } from '@videochat/shared';
import { Redis } from 'ioredis';
import { Counter, Histogram } from 'prom-client';
import { getCall } from '../db/calls.js';
import type { Database } from '../db/client.js';
import { DB, REDIS } from '../infra/tokens.js';
import { MetricsService } from '../metrics/metrics.service.js';

/** Long enough to cover any client retry; after that, a late duplicate is just noise. */
const REPORT_DEDUPE_TTL_SEC = 7 * 24 * 3600;

/**
 * CHAT-043 AC: "Call statistics are sent to analytics at the end of each call." Each participant's
 * client reports its own view of the call's quality; this records it as a structured log line
 * (searchable per call) and as Prometheus metrics (for the Grafana dashboard: how often calls
 * suffer, and how badly).
 */
@Injectable()
export class CallStatsService {
  private readonly logger = new Logger('CallStats');
  private readonly duration: Histogram<'had_video'>;
  private readonly packetLoss: Histogram;
  private readonly rtt: Histogram;
  private readonly reconnects: Counter;
  private readonly reports: Counter<'end_cause'>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    metrics: MetricsService,
  ) {
    const registers = [metrics.registry];
    this.duration = new Histogram({
      name: 'call_duration_seconds',
      help: 'Connected duration of calls, as reported by clients',
      labelNames: ['had_video'] as const,
      buckets: [10, 30, 60, 300, 900, 1800, 3600, 7200],
      registers,
    });
    this.packetLoss = new Histogram({
      name: 'call_packet_loss_max_percent',
      help: 'Worst packet loss per call, as reported by clients',
      buckets: [0.5, 1, 2, 5, 10, 20, 50],
      registers,
    });
    this.rtt = new Histogram({
      name: 'call_rtt_avg_ms',
      help: 'Average round-trip time per call, as reported by clients',
      buckets: [25, 50, 100, 200, 400, 800, 1600],
      registers,
    });
    this.reconnects = new Counter({
      name: 'call_reconnects_total',
      help: 'Connection drops that recovered during calls',
      registers,
    });
    this.reports = new Counter({
      name: 'call_stats_reports_total',
      help: 'End-of-call stats reports received, by how the call ended',
      labelNames: ['end_cause'] as const,
      registers,
    });
  }

  async record(userId: string, callId: string, stats: CallStats): Promise<void> {
    const call = await getCall(this.db, callId);
    // Same 404-not-403 rule as conversations: don't confirm a call id exists to an outsider.
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) {
      throw new NotFoundException('Call not found');
    }
    // One report per (call, participant): a repeat (client retry, or someone replaying the
    // request) is accepted but not counted twice. Shared across API nodes via Redis.
    const first = await this.redis.set(
      `callstats:${callId}:${userId}`,
      '1',
      'EX',
      REPORT_DEDUPE_TTL_SEC,
      'NX',
    );
    if (first !== 'OK') return;
    this.logger.log({
      event: 'call.stats',
      callId,
      userId,
      role: call.callerId === userId ? 'caller' : 'callee',
      media: call.media,
      ...stats,
    });
    this.reports.inc({ end_cause: stats.endCause });
    if (stats.durationSec > 0) {
      this.duration.observe({ had_video: String(stats.hadVideo) }, stats.durationSec);
    }
    if (stats.packetLossPctMax !== null) this.packetLoss.observe(stats.packetLossPctMax);
    if (stats.rttMsAvg !== null) this.rtt.observe(stats.rttMsAvg);
    if (stats.reconnects > 0) this.reconnects.inc(stats.reconnects);
  }
}
