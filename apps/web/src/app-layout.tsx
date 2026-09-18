import type { SessionView } from '@stockflow/contracts';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { useEffect } from 'react';
import { ThemeToggle } from './components/theme-toggle';
import { Badge, Button } from './components/ui/primitives';
import { canManageUsers, isOps, useSession } from './features/auth/session';
import { logout } from './lib/api-client';

type NavTo = '/orders' | '/catalog/products' | '/catalog/warehouses' | '/inventory' | '/price-lists' | '/organizations' | '/users';

/** Which screens the current session may see, gated by the same roles the API enforces. */
export function navItemsFor(session: SessionView): { to: NavTo; label: string }[] {
  const items: { to: NavTo; label: string }[] = [
    { to: '/orders', label: 'Orders' },
    { to: '/catalog/products', label: 'Products' },
    { to: '/catalog/warehouses', label: 'Warehouses' },
  ];
  if (isOps(session)) {
    items.push({ to: '/inventory', label: 'Inventory' }, { to: '/price-lists', label: 'Price lists' }, { to: '/organizations', label: 'Organisations' });
  }
  if (canManageUsers(session)) items.push({ to: '/users', label: 'Users' });
  return items;
}

export function AppLayout() {
  const session = useSession();
  const navigate = useNavigate();

  // Signed out here or in another tab (or the refresh failed): back to the login page.
  useEffect(() => {
    if (!session) void navigate({ to: '/login', search: { redirect: location.pathname } });
  }, [session, navigate]);
  if (!session) return null;
  const nav = navItemsFor(session);

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <Link to="/orders" className="font-semibold tracking-tight">
            StockFlow
          </Link>
          <nav className="flex flex-wrap gap-1">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                activeProps={{ className: 'bg-muted text-foreground font-medium' }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <div className="hidden min-w-0 text-right text-xs sm:block">
              <div className="truncate font-medium">{session.user.email}</div>
              <div className="text-muted-foreground">
                {session.acting_as.org_code} · <Badge className="px-1.5 py-0">{session.acting_as.role}</Badge>
              </div>
            </div>
            <ThemeToggle />
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void logout()}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
