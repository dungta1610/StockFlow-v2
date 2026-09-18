import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ApiError } from './lib/api-client';
import { subscribe } from './lib/auth-store';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx will not fix itself; retrying it only delays the error state.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Cached data belongs to whoever fetched it. When the identity behind the tab changes
// (logout, a failed refresh, or another user or org signing in from another tab), drop
// it so the next person never sees the previous one's orders, users or stock.
let identity: string | null = null;
subscribe((session) => {
  const next = session ? `${session.user.id}:${session.acting_as.org_id}` : null;
  if (next !== identity) queryClient.clear();
  identity = next;
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
