import type { GameManager } from "#test/framework/game-manager";

/**
 * Drives phases that became "current" without any `phaseInterceptor.to(...)`
 * running them.
 *
 * In the headless harness a phase only starts inside `PhaseInterceptor.run()`
 * (see the main repo's docs/pokerogue-headless-test-harness-mechanics.md, 3.7).
 * When the last `to(...)` call finished normally, the interceptor is in state
 * `"idling"` and the next phase sits there unstarted. Two observed cases:
 *
 * - end-of-turn effects queued after `TurnEndPhase` ("The effects of Water
 *   Sport have faded.", damage from Infestation: MessagePhase, CommonAnimPhase,
 *   DamageAnimPhase). `waitForPromiseOrTerminal` keeps pressing ACTION on the
 *   message instead of noticing that `toEndOfTurn()` already resolved.
 * - a new double battle after a biome switch (ToggleDoublePositionPhase,
 *   CheckSwitchPhase, InitEncounterPhase, PostSummonPhase) inside
 *   `advanceDoubleCombatAfterAction`.
 * - LearnMovePhase after a level-up in a double battle. `resolveLearnMoveIfNeeded`
 *   only answers the prompts of a started LearnMovePhase, so an undriven one
 *   is driven here too (a started one is never "idling").
 *
 * The driver runs next to an advance function and, once a phase has been
 * current and undriven for `IDLE_PHASE_GRACE_MS`, runs exactly that phase with
 * `phaseInterceptor.to(<its name>)`. Phases the harness handles itself (input
 * prompts, switches, battle end) are left alone.
 */
export const IDLE_PHASE_GRACE_MS = 500;

/** Phases the harness services itself or that wait for player input; never driven here. */
export const HARNESS_HANDLED_PHASES = [
  "CommandPhase",
  "TurnInitPhase",
  "SelectModifierPhase",
  "SwitchPhase",
  "SelectTargetPhase",
  "BattleEndPhase",
  "GameOverPhase",
  "PostGameOverPhase",
  "TitlePhase",
] as const;

const POLL_INTERVAL_MS = 50;

/** `true` while the current phase is not being run by any `phaseInterceptor.to(...)`. */
export function isCurrentPhaseUndriven(game: GameManager): boolean {
  const interceptorState = (game.phaseInterceptor as unknown as { state?: string }).state;
  return interceptorState === "idling" && game.scene.phaseManager.getCurrentPhase() !== undefined;
}

/**
 * Runs `advance` and, concurrently, drives phases that stay undriven for longer
 * than `IDLE_PHASE_GRACE_MS`. Each phase instance is driven at most once.
 */
export async function withIdlePhaseDriver<T>(game: GameManager, advance: () => Promise<T>): Promise<T> {
  let finished = false;
  const driver = (async () => {
    let idleSince: number | null = null;
    let lastDriven: unknown = null;
    while (!finished) {
      const phase = game.scene.phaseManager.getCurrentPhase();
      const phaseName = phase?.phaseName;
      const undriven =
        phaseName !== undefined
        && phase !== lastDriven
        && isCurrentPhaseUndriven(game)
        && !HARNESS_HANDLED_PHASES.some(name => game.isCurrentPhase(name));
      if (!undriven) {
        idleSince = null;
      } else if (idleSince === null) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= IDLE_PHASE_GRACE_MS) {
        lastDriven = phase;
        idleSince = null;
        console.error(
          `[harness-idle-phase-driver] wave=${game.scene.currentBattle?.waveIndex ?? "unknown"} phase=${phaseName}`,
        );
        await game.phaseInterceptor.to(phaseName).catch(() => undefined);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();
  try {
    return await advance();
  } finally {
    finished = true;
    await driver;
  }
}
