import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { type QuoteRequest, quoteRequestSchema } from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor } from '../../identity/http/auth.decorators';
import { QuotePricesUseCase } from '../application/use-cases/quote-prices.use-case';
import { presentQuote } from './presenters';

@Controller('pricing')
export class QuoteController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly quoteUseCase: QuotePricesUseCase,
  ) {}

  /** Read-only, so it runs outside a transaction. */
  @Post('quote')
  @HttpCode(200)
  async quote(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(quoteRequestSchema)) body: QuoteRequest,
  ) {
    const quote = await this.quoteUseCase.execute(
      this.uow.db,
      actor,
      {
        customerOrgId: body.customer_org_id,
        lines: body.items.map((i) => ({ productId: i.product_id, qty: i.qty })),
      },
      new Date(),
    );
    return { data: presentQuote(quote) };
  }
}
