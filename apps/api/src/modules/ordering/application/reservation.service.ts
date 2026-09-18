import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import type { OrgScope } from '../../identity/domain/org-scope';
import { type ExpiringReservation, ReservationRepository } from './ports/reservation.repository';

/** At most this many rows: enough for a person or the copilot to act on. */
const EXPIRING_LIMIT = 100;

/** Stock held by orders, read by the ops console and the copilot. */
@Injectable()
export class ReservationService {
  constructor(private readonly reservations: ReservationRepository) {}

  /** Holds of unpaid orders that end within `withinMinutes`, soonest first (overdue ones included). */
  listExpiring(db: Tx, scope: OrgScope, withinMinutes: number, now = new Date()): Promise<ExpiringReservation[]> {
    const until = new Date(now.getTime() + withinMinutes * 60_000);
    return this.reservations.listExpiring(db, scope, until, EXPIRING_LIMIT);
  }
}
