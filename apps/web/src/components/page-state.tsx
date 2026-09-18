import { AlertCircle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api-client';
import { Button, Skeleton } from './ui/primitives';

// Every screen shows the same three non-happy states, so none of them is forgotten.

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-4" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center" role="alert">
      <AlertCircle className="size-6 text-destructive" />
      <ErrorText error={error} />
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <Inbox className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

/** The API's message plus its stable code, which is what a tester needs to see. */
export function ErrorText({ error }: { error: unknown }) {
  if (error instanceof ApiError) {
    return (
      <p className="text-sm text-destructive">
        {error.message} <code className="text-xs opacity-75">({error.code})</code>
      </p>
    );
  }
  return <p className="text-sm text-destructive">{error instanceof Error ? error.message : 'Something went wrong.'}</p>;
}
