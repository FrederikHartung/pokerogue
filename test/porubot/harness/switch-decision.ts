import type { GameManager } from "#test/framework/game-manager";

/**
 * Optional decision hook for the two player switch prompts the harness otherwise answers on its own:
 * - "forced_switch": `SwitchPhase` (after a faint), default = first eligible party member.
 * - "check_switch": `CheckSwitchPhase` (switch offer at the start of a wild battle), default = decline.
 *
 * The harness polls these prompts from synchronous loops (`resolveForcedSwitchIfNeeded`,
 * `resolveOptionalCheckSwitchIfNeeded`), while a decision (e.g. a policy worker) is asynchronous. The provider is
 * therefore started once per phase instance and the loops keep polling until its promise has settled. Without a
 * registered provider nothing changes.
 *
 * Provider result: a party index to send out, `"stay"` (check_switch only: decline the offer) or `null` (use the
 * default). A rejected promise also falls back to the default.
 */
export type SwitchDecisionKind = "forced_switch" | "check_switch";
export type SwitchDecisionResult = number | "stay" | null;
export type SwitchDecisionProvider = (game: GameManager, kind: SwitchDecisionKind) => Promise<SwitchDecisionResult>;

export type SwitchDecisionPoll =
  | { status: "none" }
  | { status: "pending" }
  | { status: "resolved"; result: SwitchDecisionResult };

interface DecisionRecord {
  settled: boolean;
  result: SwitchDecisionResult;
}

const providers = new WeakMap<GameManager, SwitchDecisionProvider>();
const decisionsByPhase = new WeakMap<object, DecisionRecord>();
/** Party index accepted at a CheckSwitchPhase; consumed by the SwitchPhase that the accepted offer queues. */
const carriedSlots = new WeakMap<GameManager, number>();

export function setSwitchDecisionProvider(game: GameManager, provider: SwitchDecisionProvider | null): void {
  if (provider) {
    providers.set(game, provider);
  } else {
    providers.delete(game);
  }
}

export function getSwitchDecisionProvider(game: GameManager): SwitchDecisionProvider | undefined {
  return providers.get(game);
}

export function carrySwitchSlotToNextSwitchPhase(game: GameManager, partyIndex: number): void {
  carriedSlots.set(game, partyIndex);
}

/**
 * Returns the decision for the current phase instance (`phase` = `game.scene.phaseManager.getCurrentPhase()`),
 * starting the provider on first call. A slot carried over from an accepted check_switch wins over a new
 * forced_switch decision, so the SwitchPhase queued by the offer sends out the slot that was chosen there.
 */
export function pollSwitchDecision(game: GameManager, kind: SwitchDecisionKind, phase: object): SwitchDecisionPoll {
  const existing = decisionsByPhase.get(phase);
  if (existing) {
    return existing.settled ? { status: "resolved", result: existing.result } : { status: "pending" };
  }

  if (kind === "forced_switch" && carriedSlots.has(game)) {
    const carried = carriedSlots.get(game) ?? null;
    carriedSlots.delete(game);
    decisionsByPhase.set(phase, { settled: true, result: carried });
    return { status: "resolved", result: carried };
  }

  const provider = providers.get(game);
  if (!provider) {
    return { status: "none" };
  }

  const record: DecisionRecord = { settled: false, result: null };
  decisionsByPhase.set(phase, record);
  provider(game, kind)
    .then(result => {
      record.result = result;
    })
    .catch(error => {
      console.log(`[harness-switch-decision] ${kind} provider failed, using default: ${String(error)}`);
      record.result = null;
    })
    .finally(() => {
      record.settled = true;
    });
  return { status: "pending" };
}
