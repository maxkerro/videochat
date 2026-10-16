/**
 * Work to do while signing out, before the session is gone (each hook still has the access
 * token). Kept as a tiny registry so features can hook in without the auth code importing them.
 * A hook that fails or takes more than a few seconds never blocks signing out.
 */
export interface SignOutSession {
  userId: string;
  accessToken: string;
}

type Hook = (session: SignOutSession) => Promise<void>;

const hooks = new Set<Hook>();
const HOOK_TIMEOUT_MS = 3_000;

export function onSignOut(hook: Hook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

export async function runSignOutHooks(session: SignOutSession): Promise<void> {
  await Promise.all(
    [...hooks].map((hook) =>
      Promise.race([
        hook(session).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, HOOK_TIMEOUT_MS)),
      ]),
    ),
  );
}
