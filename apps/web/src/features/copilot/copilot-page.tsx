import { Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorState, ErrorText, LoadingRows } from '@/components/page-state';
import { Button, Card, Input } from '@/components/ui/primitives';
import { isOpsAdmin, useRequiredSession } from '../auth/session';
import { useCopilotSession, useCreateCopilotSession, useProposals } from './copilot-api';
import { ProposalCard } from './proposal-card';
import { ToolCallBadge } from './tool-call-badge';
import { useChatStream, type ChatTurn } from './use-chat-stream';

const SUGGESTIONS = [
  'How much SKU-1 is left in HN-01?',
  'Which orders are holding stock that expires in the next 30 minutes?',
  'Why is order ORD-000001 not moving?',
];

/**
 * The ops copilot.
 *
 * Two columns rather than one, because the conversation and the proposals it
 * raises have different lifetimes: an answer is read once, a proposal waits for a
 * person who may not be the one who asked. Burying the queue inside the transcript
 * would hide pending work behind scrollback.
 */
export function CopilotPage() {
  const session = useRequiredSession();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const create = useCreateCopilotSession();
  const stored = useCopilotSession(sessionId);
  const proposals = useProposals(true);
  const chat = useChatStream(sessionId);
  const [draft, setDraft] = useState('');
  const endOfTranscript = useRef<HTMLDivElement>(null);

  // One conversation per visit: opening the screen starts a fresh session rather
  // than resuming one whose context the operator no longer remembers.
  useEffect(() => {
    if (sessionId === null && !create.isPending && !create.isError) {
      create.mutate(undefined, { onSuccess: (s) => setSessionId(s.id) });
    }
  }, [sessionId, create]);

  useEffect(() => {
    endOfTranscript.current?.scrollIntoView({ block: 'end' });
  }, [chat.turns]);

  const ask = async (text: string) => {
    const input = text.trim();
    if (!input || chat.streaming) return;
    setDraft('');
    await chat.send(input);
    // A turn can have filed a proposal; the queue beside it should say so.
    await proposals.refetch();
  };

  if (create.isError) return <ErrorState error={create.error} onRetry={() => create.reset()} />;
  if (sessionId === null) return <LoadingRows rows={3} />;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Copilot</h1>
        <p className="text-sm text-muted-foreground">
          Asks the same services the console does — it cannot see more than you can, and it cannot change stock.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="flex min-h-[28rem] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {chat.turns.length === 0 && (
              <EmptyState title="Ask about stock, orders or prices">
                <div className="flex flex-col items-start gap-2">
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} variant="outline" size="sm" onClick={() => void ask(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              </EmptyState>
            )}
            {chat.turns.map((turn, i) => (
              <Turn key={i} turn={turn} streaming={chat.streaming && i === chat.turns.length - 1} />
            ))}
            {stored.isError && <ErrorText error={stored.error} />}
            <div ref={endOfTranscript} />
          </div>

          <form
            className="flex items-center gap-2 border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <Input
              aria-label="Message"
              placeholder="Ask about stock, orders or prices…"
              value={draft}
              disabled={chat.streaming}
              onChange={(e) => setDraft(e.target.value)}
            />
            {chat.streaming ? (
              <Button type="button" variant="outline" onClick={chat.stop} aria-label="Stop">
                <Square className="size-4" aria-hidden /> Stop
              </Button>
            ) : (
              <Button type="submit" disabled={draft.trim().length === 0} aria-label="Send">
                <Send className="size-4" aria-hidden /> Send
              </Button>
            )}
          </form>
        </Card>

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Stock adjustment proposals</h2>
          {proposals.isPending && <LoadingRows rows={2} />}
          {proposals.isError && <ErrorState error={proposals.error} onRetry={() => void proposals.refetch()} />}
          {proposals.data?.length === 0 && (
            <EmptyState title="Nothing waiting">
              Proposals the copilot raises show up here for review.
            </EmptyState>
          )}
          {proposals.data?.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} canApprove={isOpsAdmin(session)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Turn({ turn, streaming }: { turn: ChatTurn; streaming: boolean }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{turn.content}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {turn.toolCalls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {turn.toolCalls.map((call) => (
            <ToolCallBadge key={call.callId} call={call} />
          ))}
        </div>
      )}
      {turn.content && <p className="text-sm whitespace-pre-wrap">{turn.content}</p>}
      {streaming && turn.content === '' && turn.toolCalls.length === 0 && (
        <p className="text-sm text-muted-foreground">Thinking…</p>
      )}
      {turn.error && <ErrorText error={new Error(turn.error)} />}
    </div>
  );
}
