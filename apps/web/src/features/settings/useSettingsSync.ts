import { meSchema, type WsEnvelope } from '@videochat/shared';
import { useEffect } from 'react';
import { useTheme } from '../../theme/ThemeProvider';
import { useAuth } from '../auth/AuthContext';
import { useRealtimeEvent } from '../chat/RealtimeProvider';

/**
 * CHAT-037 AC "changes ... apply on all devices": settings saved on another device arrive as
 * `me.updated`; the theme setting drives this device's theme.
 */
export function useSettingsSync(): void {
  const { user, setUser } = useAuth();
  const { preference, setPreference } = useTheme();

  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'me.updated') return;
    const parsed = meSchema.safeParse(envelope.payload);
    if (parsed.success) setUser(parsed.data);
  });

  const serverTheme = user?.settings.theme;
  useEffect(() => {
    if (serverTheme && serverTheme !== preference) setPreference(serverTheme);
    // Only when the saved setting changes (sign-in, another device) -- not on local toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverTheme]);
}
