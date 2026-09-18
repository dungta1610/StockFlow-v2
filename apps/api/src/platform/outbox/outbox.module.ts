import { Module } from '@nestjs/common';
import { OutboxRelay } from './outbox.relay';

/** The outbox mechanism: claim, dispatch, retry, dead-letter. Knows nothing about
 *  which event types exist or what a handler does — see docs/code-standards.md. */
@Module({
  providers: [OutboxRelay],
  exports: [OutboxRelay],
})
export class OutboxModule {}
