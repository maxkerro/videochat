import {
  LAST_SEEN_VISIBILITY,
  passwordSchema,
  THEME_PREFERENCES,
  type LastSeenVisibility,
  type UpdateSettingsInput,
} from '@videochat/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Input, Modal, useToast } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { useTheme } from '../../theme/ThemeProvider';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { isPushSupported, syncPushSubscription } from '../notifications/push';
import { fetchMe } from '../profile/profileApi';
import { changePassword, deleteAccount, downloadExport, updateSettings } from './settingsApi';
import styles from './Settings.module.css';

const VISIBILITY_LABELS: Record<LastSeenVisibility, string> = {
  everyone: 'Everyone',
  contacts: 'Only people I have a direct chat with',
  nobody: 'Nobody',
};
const THEME_LABELS = { system: 'Match my device', light: 'Light', dark: 'Dark' } as const;

/** Bumped by every save, across all sections: only the newest save's response is applied, so two
 *  quick toggles resolving out of order can't put the older state back. */
let latestSave = 0;

/** Saves a settings change at once (AC "changes save immediately"), optimistically. */
function useSaveSettings() {
  const auth = useAuth();
  const { toast } = useToast();
  return async (input: UpdateSettingsInput) => {
    const save = ++latestSave;
    const previous = auth.user;
    if (previous) {
      auth.setUser({
        ...previous,
        settings: {
          ...previous.settings,
          ...input,
          notifications: { ...previous.settings.notifications, ...input.notifications },
        },
      });
    }
    try {
      const saved = await withAuthRetry(auth, (t) => updateSettings(t, input));
      // A newer save is in flight: its response (which includes this change) wins.
      if (save === latestSave) auth.setUser(saved);
    } catch {
      toast({ title: 'Couldn’t save that setting', tone: 'danger' });
      // Back to what the server actually has -- not a snapshot from before this change, which
      // could undo a different setting saved in the meantime. Re-read after the newest save.
      try {
        const current = await withAuthRetry(auth, (t) => fetchMe(t));
        if (save === latestSave) auth.setUser(current);
      } catch {
        if (previous && save === latestSave) auth.setUser(previous);
      }
    }
  };
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={styles.toggle}>
      <span className={styles.toggleText}>
        <span>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function PrivacySection() {
  const { user } = useAuth();
  const save = useSaveSettings();
  if (!user) return null;
  const s = user.settings;
  return (
    <section className={styles.section} aria-labelledby="privacy-heading">
      <h2 id="privacy-heading">Privacy</h2>
      <Toggle
        label="Read receipts"
        hint="When off, people don’t see when you’ve read their messages, and you don’t see theirs."
        checked={s.readReceipts}
        onChange={(readReceipts) => void save({ readReceipts })}
      />
      <fieldset className={styles.fieldset}>
        <legend>Who can see when I’m online and last seen</legend>
        {LAST_SEEN_VISIBILITY.map((v) => (
          <label key={v} className={styles.radio}>
            <input
              type="radio"
              name="last-seen"
              value={v}
              checked={s.lastSeenVisibility === v}
              onChange={() => void save({ lastSeenVisibility: v })}
            />
            {VISIBILITY_LABELS[v]}
          </label>
        ))}
        <p className={styles.hint}>
          It works both ways: you only see it for people you show yours to.
        </p>
      </fieldset>
    </section>
  );
}

export function NotificationsSection() {
  const auth = useAuth();
  const save = useSaveSettings();
  const [permission, setPermission] = useState(() =>
    isPushSupported() ? Notification.permission : 'unsupported',
  );
  if (!auth.user) return null;
  const n = auth.user.settings.notifications;

  async function enableBrowserNotifications() {
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === 'granted' && auth.accessToken) await syncPushSubscription(auth.accessToken);
  }

  return (
    <section className={styles.section} aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Notifications</h2>
      <Toggle
        label="Notifications"
        checked={n.enabled}
        onChange={(enabled) => void save({ notifications: { enabled } })}
      />
      <Toggle
        label="Sound"
        checked={n.sound}
        disabled={!n.enabled}
        onChange={(sound) => void save({ notifications: { sound } })}
      />
      <Toggle
        label="Show message text"
        hint="When off, notifications just say “New message”."
        checked={n.previews}
        disabled={!n.enabled}
        onChange={(previews) => void save({ notifications: { previews } })}
      />
      <p className={styles.hint}>
        {permission === 'unsupported'
          ? 'This browser doesn’t support notifications.'
          : permission === 'granted'
            ? 'Browser notifications are allowed on this device.'
            : permission === 'denied'
              ? 'Notifications are blocked for this site in your browser settings.'
              : 'Browser notifications aren’t enabled on this device yet.'}
      </p>
      {permission === 'default' && (
        <Button variant="secondary" size="sm" onClick={() => void enableBrowserNotifications()}>
          Enable browser notifications
        </Button>
      )}
    </section>
  );
}

export function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  const { user } = useAuth();
  const save = useSaveSettings();
  return (
    <section className={styles.section} aria-labelledby="appearance-heading">
      <h2 id="appearance-heading">Appearance</h2>
      <fieldset className={styles.fieldset}>
        <legend>Theme</legend>
        {THEME_PREFERENCES.map((t) => (
          <label key={t} className={styles.radio}>
            <input
              type="radio"
              name="theme"
              value={t}
              checked={preference === t}
              onChange={() => {
                setPreference(t);
                if (user) void save({ theme: t });
              }}
            />
            {THEME_LABELS[t]}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

export function AccountSection() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) {
      setPwError(parsed.error.issues[0]?.message ?? 'Choose a longer password');
      return;
    }
    setPwError(null);
    setSavingPw(true);
    try {
      await withAuthRetry(auth, (t) =>
        changePassword(t, { currentPassword: current, newPassword: next }),
      );
      setCurrent('');
      setNext('');
      // Tokens from before the change are no longer accepted; get this tab a fresh one.
      await auth.refresh();
      toast({ title: 'Password changed. Your other devices were signed out.' });
    } catch (error) {
      setPwError(error instanceof ApiError ? error.message : 'Couldn’t change your password');
    } finally {
      setSavingPw(false);
    }
  }

  async function exportData() {
    setExporting(true);
    try {
      await withAuthRetry(auth, (t) => downloadExport(t));
    } catch {
      toast({ title: 'Couldn’t export your data', tone: 'danger' });
    } finally {
      setExporting(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await withAuthRetry(auth, (t) => deleteAccount(t, deletePassword));
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : 'Couldn’t delete your account');
      setDeleting(false);
      return;
    }
    // Deleted. Signing out is local cleanup from here: nothing in it can report the deletion
    // as failed.
    setDeleteOpen(false);
    await auth.logout().catch(() => undefined);
    void navigate('/login');
  }

  return (
    <section className={styles.section} aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2>
      <form className={styles.form} onSubmit={submitPassword} noValidate>
        <h3>Change password</h3>
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={pwError ?? undefined}
        />
        <Button type="submit" variant="secondary" loading={savingPw} disabled={!current || !next}>
          Change password
        </Button>
      </form>

      <div className={styles.row}>
        <div>
          <h3>Your data</h3>
          <p className={styles.hint}>
            A JSON file with your profile and every message you’ve sent.
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={exporting} onClick={() => void exportData()}>
          Download my data
        </Button>
      </div>

      <div className={styles.row}>
        <div>
          <h3>Delete account</h3>
          <p className={styles.hint}>
            Removes your profile, messages and files for everyone. This can’t be undone.
          </p>
        </div>
        <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
          Delete account
        </Button>
      </div>

      <Modal
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) {
            setDeletePassword('');
            setDeleteError(null);
          }
        }}
        title="Delete your account?"
        description="Your profile, messages and files are removed for everyone. Enter your password to confirm."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              disabled={!deletePassword}
              onClick={() => void confirmDelete()}
            >
              Delete my account
            </Button>
          </>
        }
      >
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          value={deletePassword}
          onChange={(e) => setDeletePassword(e.target.value)}
          error={deleteError ?? undefined}
        />
      </Modal>
    </section>
  );
}
