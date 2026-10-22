import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MODERATION,
  type AuditEntry,
  type ModerationAction,
  type ModerationUser,
  type ReportDetail,
  type ReportStatus,
  type ReportSummary,
} from '@videochat/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, useToast } from '../../components/ui';
import { cx } from '../../lib/cx';
import { ApiError } from '../../lib/api';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import {
  fetchAudit,
  fetchReport,
  fetchReports,
  liftRestriction,
  resolveReport,
} from './moderationApi';
import { REASON_LABELS } from './ReportDialog';
import styles from './Moderation.module.css';

type Tab = ReportStatus | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'audit', label: 'Audit log' },
];

/** Refetch the open queue this often, so a new report shows up within a minute (CHAT-077 AC). */
const QUEUE_REFRESH_MS = 30_000;

const ACTION_LABELS: Record<ModerationAction, string> = {
  dismiss: 'Dismiss (no action)',
  warn: 'Warn (email)',
  suspend: 'Suspend',
  ban: 'Ban',
};

const AUDIT_LABELS: Record<AuditEntry['action'], string> = {
  view_report: 'Opened report',
  dismiss: 'Dismissed',
  warn: 'Warned',
  suspend: 'Suspended',
  ban: 'Banned',
  lift: 'Lifted restriction',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function restriction(u: ModerationUser | null): string | null {
  if (!u) return null;
  if (u.deleted) return 'Deleted account';
  if (u.bannedAt) return 'Banned';
  if (u.suspendedUntil && Date.parse(u.suspendedUntil) > Date.now()) {
    return `Suspended until ${when(u.suspendedUntil)}`;
  }
  return null;
}

function Person({ user }: { user: ModerationUser | null }) {
  if (!user) return <span className={styles.muted}>Unknown</span>;
  const status = restriction(user);
  return (
    <span>
      {user.displayName} <span className={styles.muted}>@{user.username}</span>
      {status && <span className={styles.badge}>{status}</span>}
    </span>
  );
}

/**
 * CHAT-077: the moderation console. Moderators only (the API enforces it; this page just isn't
 * linked for anyone else). A report's content loads only when it's opened, and opening it is
 * written to the audit log.
 */
export function ModerationPage() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('open');
  const [selected, setSelected] = useState<string | null>(null);

  if (auth.status === 'authenticated' && !auth.user?.moderator) {
    return (
      <main className={styles.page}>
        <p>This page is for moderators.</p>
        <Link to="/">Back to chats</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.back}>
          ← Chats
        </Link>
        <h1>Moderation</h1>
      </header>
      <div role="tablist" aria-label="Moderation views" className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cx(styles.tab, tab === t.id && styles.tabActive)}
            onClick={() => {
              setTab(t.id);
              setSelected(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'audit' ? (
        <AuditLog />
      ) : (
        <div className={styles.columns}>
          <ReportList status={tab} selected={selected} onSelect={setSelected} />
          {selected ? (
            <ReportView key={selected} id={selected} onDone={() => setSelected(null)} />
          ) : (
            <p className={cx(styles.detail, styles.muted)}>Pick a report to review it.</p>
          )}
        </div>
      )}
    </main>
  );
}

function ReportList({
  status,
  selected,
  onSelect,
}: {
  status: ReportStatus;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['moderation', 'reports', status],
    queryFn: () => withAuthRetry(auth, (t) => fetchReports(t, status)),
    refetchInterval: status === 'open' ? QUEUE_REFRESH_MS : false,
  });
  if (query.isPending) return <p className={styles.list}>Loading…</p>;
  if (query.isError) return <p className={styles.list}>Couldn’t load reports.</p>;
  const reports = query.data.reports;
  if (reports.length === 0) {
    return <p className={cx(styles.list, styles.muted)}>No {status} reports.</p>;
  }
  return (
    <ul className={styles.list} aria-label={`${status} reports`}>
      {reports.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={cx(styles.item, r.id === selected && styles.itemActive)}
            onClick={() => onSelect(r.id)}
          >
            <strong>{REASON_LABELS[r.reason]}</strong>
            <span>
              {r.kind === 'user' ? 'Person' : 'Message'} ·{' '}
              {r.reportedUser?.displayName ?? 'Unknown'}
              {r.openReportsAboutUser > 1 && (
                <span className={styles.badge}>{r.openReportsAboutUser} open</span>
              )}
            </span>
            <span className={styles.muted}>{when(r.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReportView({ id, onDone }: { id: string; onDone: () => void }) {
  const auth = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['moderation', 'report', id],
    queryFn: () => withAuthRetry(auth, (t) => fetchReport(t, id)),
    // Each opening is audited: don't refetch behind the moderator's back.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  // Lists and the audit log only: refetching this report would open it again (another audited
  // view) behind the moderator's back.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['moderation', 'reports'] });
    void queryClient.invalidateQueries({ queryKey: ['moderation', 'audit'] });
  };

  const lift = useMutation({
    mutationFn: (userId: string) => withAuthRetry(auth, (t) => liftRestriction(t, userId)),
    onSuccess: () => {
      toast({ title: 'Restriction lifted.' });
      queryClient.setQueryData<ReportDetail>(['moderation', 'report', id], (old) =>
        old?.reportedUser
          ? { ...old, reportedUser: { ...old.reportedUser, suspendedUntil: null, bannedAt: null } }
          : old,
      );
      refresh();
    },
    onError: () => toast({ title: 'Couldn’t lift it.', tone: 'danger' }),
  });

  if (query.isPending) return <section className={styles.detail}>Loading…</section>;
  if (query.isError) return <section className={styles.detail}>Couldn’t load this report.</section>;
  const r = query.data;
  const restricted = restriction(r.reportedUser);

  return (
    <section className={styles.detail} aria-label="Report">
      <h2>
        {REASON_LABELS[r.reason]} · {r.kind === 'user' ? 'a person' : 'a message'}
      </h2>
      <dl className={styles.facts}>
        <dt>Reported</dt>
        <dd>
          <Person user={r.reportedUser} />
          {r.reportedUser && restricted && !r.reportedUser.deleted && (
            <Button
              size="sm"
              variant="secondary"
              loading={lift.isPending}
              onClick={() => lift.mutate(r.reportedUser!.id)}
            >
              Lift
            </Button>
          )}
        </dd>
        <dt>By</dt>
        <dd>
          <Person user={r.reporter} />
        </dd>
        <dt>When</dt>
        <dd>{when(r.createdAt)}</dd>
        <dt>Open reports about them</dt>
        <dd>{r.openReportsAboutUser}</dd>
      </dl>
      {r.details && <blockquote className={styles.details}>{r.details}</blockquote>}

      {r.snapshot && (
        <div className={styles.snapshot}>
          <h3>
            Reported text{' '}
            {r.snapshot.fromReporter && (
              <span className={styles.badge}>
                Sent by the reporter (encrypted message, unverified)
              </span>
            )}
          </h3>
          <p>{r.snapshot.text ?? <em className={styles.muted}>No text (attachment only)</em>}</p>
        </div>
      )}

      {r.context.length > 0 && (
        <div>
          <h3>In the chat (at most {MODERATION.contextMessages} messages around it)</h3>
          <ol className={styles.context}>
            {r.context.map((m) => (
              <li key={m.id} className={cx(m.reported && styles.reported)}>
                <span className={styles.muted}>
                  {m.senderName ?? 'System'} · {when(m.createdAt)}
                </span>
                <span>
                  {m.deleted ? (
                    <em className={styles.muted}>Deleted</em>
                  ) : m.encrypted ? (
                    <em className={styles.muted}>🔒 Encrypted</em>
                  ) : (
                    (m.text ?? (m.attachmentName ? `📎 ${m.attachmentName}` : m.type))
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {r.resolution ? (
        <p className={styles.resolution}>
          {ACTION_LABELS[r.resolution.action]} by {r.resolution.by?.displayName ?? 'unknown'} on{' '}
          {when(r.resolution.at)}
          {r.resolution.note && <> — “{r.resolution.note}”</>}
        </p>
      ) : (
        <ActionForm
          report={r}
          onResolved={() => {
            queryClient.removeQueries({ queryKey: ['moderation', 'report', id] });
            refresh();
            onDone();
          }}
        />
      )}
    </section>
  );
}

function ActionForm({ report, onResolved }: { report: ReportDetail; onResolved: () => void }) {
  const auth = useAuth();
  const { toast } = useToast();
  const [action, setAction] = useState<ModerationAction | null>(null);
  // Kept as typed (so the field can be cleared and retyped); checked before applying.
  const [daysText, setDaysText] = useState('7');
  const days = Number(daysText);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= MODERATION.maxSuspendDays;
  const [note, setNote] = useState('');
  const isSelf = report.reportedUser?.id === auth.user?.id;
  const mutation = useMutation({
    mutationFn: () =>
      withAuthRetry(auth, (t) =>
        resolveReport(t, report.id, {
          action: action!,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(action === 'suspend' ? { days } : {}),
        }),
      ),
    onSuccess: (summary: ReportSummary) => {
      toast({ title: `Done: ${ACTION_LABELS[summary.resolution!.action].toLowerCase()}.` });
      onResolved();
    },
    onError: (error) =>
      toast({
        title: error instanceof ApiError ? error.message : 'Couldn’t apply that.',
        tone: 'danger',
      }),
  });
  const actions: ModerationAction[] =
    report.reportedUser && !isSelf ? ['dismiss', 'warn', 'suspend', 'ban'] : ['dismiss'];

  return (
    <form
      className={styles.actions}
      onSubmit={(e) => {
        e.preventDefault();
        if (action) mutation.mutate();
      }}
    >
      <fieldset className={styles.reasons}>
        <legend>Action</legend>
        {actions.map((a) => (
          <label key={a} className={styles.radio}>
            <input
              type="radio"
              name="moderation-action"
              checked={action === a}
              onChange={() => setAction(a)}
            />
            {ACTION_LABELS[a]}
            {a === 'suspend' && action === 'suspend' && (
              <>
                {' for '}
                <input
                  type="number"
                  aria-label="Days"
                  min={1}
                  max={MODERATION.maxSuspendDays}
                  value={daysText}
                  className={styles.days}
                  onChange={(e) => setDaysText(e.target.value)}
                />{' '}
                days
              </>
            )}
          </label>
        ))}
      </fieldset>
      <label className={styles.field}>
        <span>Note for the audit log (not shown to the person)</span>
        <textarea
          rows={2}
          maxLength={MODERATION.noteMax}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <Button
        type="submit"
        variant={action === 'ban' || action === 'suspend' ? 'danger' : 'primary'}
        disabled={!action || (action === 'suspend' && !daysValid)}
        loading={mutation.isPending}
      >
        Apply
      </Button>
    </form>
  );
}

function AuditLog() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['moderation', 'audit'],
    queryFn: () => withAuthRetry(auth, (t) => fetchAudit(t)),
  });
  if (query.isPending) return <p>Loading…</p>;
  if (query.isError) return <p>Couldn’t load the audit log.</p>;
  if (query.data.entries.length === 0) return <p className={styles.muted}>Nothing yet.</p>;
  return (
    <table className={styles.audit}>
      <thead>
        <tr>
          <th>When</th>
          <th>Moderator</th>
          <th>Action</th>
          <th>Person</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {query.data.entries.map((e) => (
          <tr key={e.id}>
            <td>{when(e.createdAt)}</td>
            <td>{e.moderator?.displayName ?? '—'}</td>
            <td>
              {AUDIT_LABELS[e.action]}
              {typeof e.details?.days === 'number' && ` (${e.details.days} days)`}
            </td>
            <td>{e.targetUser ? `${e.targetUser.displayName} @${e.targetUser.username}` : '—'}</td>
            <td>{e.note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
