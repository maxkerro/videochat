import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ToastProvider } from './components/ui';
import { AuthProvider } from './features/auth/AuthContext';
import { RealtimeProvider } from './features/chat/RealtimeProvider';
import { CallProvider } from './features/calls/CallProvider';
import { ThemeProvider } from './theme/ThemeProvider';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <RealtimeProvider>
              <CallProvider>{children}</CallProvider>
            </RealtimeProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
