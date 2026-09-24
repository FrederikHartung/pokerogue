import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sleep, withTimeout } from "./battle-command-advance";
import { installSingleDriverPhaseInterceptor } from "./single-driver-phase-interceptor";

/**
 * Counts how often the very same Phase instance gets start()ed by the
 * PhaseInterceptor. Each instance must run exactly once - a second start()
 * means a second end(), which shifts the phase queue twice and silently skips
 * whatever phase was queued next (e.g. a FaintPhase).
 */
function trackDoubleStarts(game: GameManager): string[] {
  const doubleStarts: string[] = [];
  const started = new WeakSet<object>();
  const interceptor = game.phaseInterceptor as unknown as { run: (phase: any) => Promise<void> };
  const originalRun = interceptor.run.bind(interceptor);
  interceptor.run = (phase: any) => {
    if (started.has(phase)) {
      doubleStarts.push(phase.phaseName);
    }
    started.add(phase);
    return originalRun(phase);
  };
  return doubleStarts;
}

describe("porubot harness - single-driver-phase-interceptor", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle("single")
      .moveset([MoveId.SPLASH])
      .ability(AbilityId.BALL_FETCH)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
  });

  /**
   * Reproduces the root cause behind the fresh-data collector timeouts: a
   * PhaseInterceptor.to() call that is still pending (here: aimed at the
   * already-reached CommandPhase, exactly like an abandoned background
   * toNextTurn()/waitForCommandPhaseAfterModifierAction() in the collector)
   * turns into a second, "zombie" phase driver as soon as that CommandPhase
   * ends. On the stock interceptor it then either start()s the same phase
   * instances a second time, or resolves on toEndOfTurn()'s target (the two
   * share one `target` field), leaving toEndOfTurn() itself chasing a
   * TurnEndPhase that already ran until it wedges at the next CommandPhase.
   * Both variants fail here without installSingleDriverPhaseInterceptor().
   */
  for (const actionKind of ["move", "switch"] as const) {
    it(`keeps a pending earlier to() call from double-driving phases (${actionKind} action)`, async () => {
      await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE);
      installSingleDriverPhaseInterceptor(game);
      const doubleStarts = trackDoubleStarts(game);

      // Abandoned drivers, never awaited - mirrors the collector's orphaned
      // calls. The short pause lets each one enter its own wait loop, as the
      // collector's DQN inference round-trip always does in practice.
      for (let i = 0; i < 2; i++) {
        // biome-ignore lint/complexity/noVoid: intentionally abandoned, exactly like the collector's orphaned calls this test reproduces
        void game.phaseInterceptor.to("CommandPhase");
        await sleep(30);
      }

      if (actionKind === "move") {
        game.move.select(MoveId.SPLASH);
      } else {
        game.doSwitchPokemon(1);
      }
      await withTimeout(game.toEndOfTurn(), 5000, "to_end_of_turn_with_pending_driver");

      expect(doubleStarts).toEqual([]);
      expect(game.phaseInterceptor.log.filter(phase => phase === "TurnEndPhase")).toHaveLength(1);
    });
  }

  it("still lets a normal to() sequence reach the next turn", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);
    installSingleDriverPhaseInterceptor(game);
    const startingTurn = game.scene.currentBattle.turn;

    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();

    expect(game.isCurrentPhase("CommandPhase")).toBe(true);
    expect(game.scene.currentBattle.turn).toBe(startingTurn + 1);
  });
});
