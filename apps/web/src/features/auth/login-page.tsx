import { useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ErrorText } from '@/components/page-state';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button, Card, CardContent, Input, Label, Select } from '@/components/ui/primitives';
import { ApiError, login } from '@/lib/api-client';

/** Seeded accounts (`pnpm seed`), so testers do not have to look them up. */
const DEMO_ACCOUNTS = [
  { email: 'ops.admin@stockflow.local', label: 'Ops admin' },
  { email: 'ops@stockflow.local', label: 'Ops staff' },
  { email: 'admin@buyer-a.local', label: 'Buyer A admin' },
  { email: 'buyer@buyer-a.local', label: 'Buyer A' },
  { email: 'admin@buyer-b.local', label: 'Buyer B admin' },
  { email: 'distributor@stockflow.local', label: 'Distributor (2 orgs)' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: '/login' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Filled when the API says the account belongs to several organisations.
  const [orgCodes, setOrgCodes] = useState<string[]>([]);
  const [orgCode, setOrgCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password, ...(orgCode && { org_code: orgCode }) });
      await navigate({ to: redirect ?? '/orders' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ORG_SELECTION_REQUIRED') {
        const codes = (err.details as { org_codes?: string[] } | undefined)?.org_codes ?? [];
        setOrgCodes(codes);
        setOrgCode(codes[0] ?? '');
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  function pick(demoEmail: string) {
    setEmail(demoEmail);
    setOrgCodes([]);
    setOrgCode('');
    setError(null);
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">StockFlow</h1>
          <p className="text-sm text-muted-foreground">Sign in to the console</p>
        </div>
        <Card>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setOrgCodes([]);
                    setOrgCode('');
                  }}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {orgCodes.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="org">Organisation</Label>
                  <Select id="org" value={orgCode} onChange={(e) => setOrgCode(e.target.value)}>
                    {orgCodes.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">This account belongs to several organisations.</p>
                </div>
              )}
              {error !== null && <ErrorText error={error} />}
              <Button type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Demo accounts from <code>pnpm seed</code> (default password <code>ChangeMe-123!</code>):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {DEMO_ACCOUNTS.map((a) => (
                <Button key={a.email} variant="outline" size="sm" onClick={() => pick(a.email)}>
                  {a.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
