// Placeholder shell. The ops console (routing, auth, screens) is built in the
// web phase; this only proves the toolchain builds and serves.
export function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">StockFlow</h1>
        <p className="mt-2 text-sm text-muted-foreground">Ops console — coming soon.</p>
      </div>
    </main>
  );
}
