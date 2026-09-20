import { DomainError, conflict, forbidden } from '../../../platform/errors/domain-error';

/** Copilot failures. Codes are part of the public API contract. */
export const CopilotErrors = {
  /**
   * Also what a session belonging to another tenant looks like: 404, never 403,
   * so the answer does not confirm that the session exists.
   */
  sessionNotFound: () => new DomainError('COPILOT_SESSION_NOT_FOUND', 'Chat session not found.', 404),
  proposalNotFound: () => new DomainError('PROPOSAL_NOT_FOUND', 'Stock adjustment proposal not found.', 404),
  /** Already decided: deciding again would either double-apply or rewrite the record. */
  proposalAlreadyDecided: (status: string) =>
    conflict('PROPOSAL_ALREADY_DECIDED', `This proposal has already been ${status}.`),
  /**
   * The whole point of human-in-the-loop is that a second person looked. The
   * database enforces this as well (`chk_no_self_decision`); this is the readable
   * failure a reviewer gets instead of a constraint violation.
   */
  cannotDecideOwnProposal: () =>
    forbidden('A proposal must be decided by someone other than the person who raised it.'),
} as const;
