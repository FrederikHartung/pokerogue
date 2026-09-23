import { AbilityId } from "#enums/ability-id";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advanceCombatAfterAction, advanceDoubleCombatAfterAction } from "./battle-command-advance";

/**
 * Self-test for the extracted collector harness (see AGENTS.md "Stehende
 * Ausnahme ... harness/"). Exercises the exact production functions the
 * main-repo collector imports, using plain `game.move.select()` instead of
 * DQN-driven action selection, so it needs no Python/torch dependency.
 */
describe("porubot harness - battle-command-advance", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  it("advanceCombatAfterAction resolves to a stable CommandPhase after a single-battle move", async () => {
    game.override
      .battleStyle("single")
      .moveset([MoveId.SPLASH])
      .ability(AbilityId.BALL_FETCH)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    game.move.select(MoveId.SPLASH);
    const status = await advanceCombatAfterAction(game, 15000);

    expect(status).toBe("ok");
    expect(game.isCurrentPhase("CommandPhase")).toBe(true);
  });

  it("advanceDoubleCombatAfterAction resolves to a stable CommandPhase after both double-battle slots act", async () => {
    game.override
      .battleStyle("double")
      .moveset([MoveId.SPLASH])
      .ability(AbilityId.BALL_FETCH)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.MAGIKARP);

    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER);
    const fieldZeroStatus = await advanceDoubleCombatAfterAction(
      game,
      { action_kind: "move", acting_field_index: 0, expects_select_target_phase: false },
      15000,
    );
    expect(fieldZeroStatus).toBe("ok");

    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER_2);
    const fieldOneStatus = await advanceDoubleCombatAfterAction(
      game,
      { action_kind: "move", acting_field_index: 1, expects_select_target_phase: false },
      15000,
    );
    expect(fieldOneStatus).toBe("ok");
    expect(game.isCurrentPhase("CommandPhase")).toBe(true);
  });

  /**
   * Regression coverage for a real bug found and fixed in this harness:
   * a phase becomes "current" via PhaseManager.shiftPhase without its own
   * start() ever running - only an explicit phaseInterceptor.to() call
   * actually drives that in this test framework (see the comment on the
   * SelectTargetPhase branch of waitForDoubleTargetPhaseOrImmediateFollowup).
   * Every other advance path here pairs its polling with a concurrent
   * toNextTurn()/toEndOfTurn() pump; the needsTargetSelection path used to be
   * the one exception, so it hung forever whenever a single-target move had
   * more than one legal candidate in a double battle (a very common case -
   * see docs/pokerogue-headless-test-harness-mechanics.md section 3.5). This
   * test would time out on the unfixed harness.
   */
  it("advanceDoubleCombatAfterAction resolves an ambiguous single-target move via SelectTargetPhase", async () => {
    game.override
      .battleStyle("double")
      .enemyLevel(100)
      .startingLevel(100)
      .moveset([MoveId.TACKLE])
      .ability(AbilityId.BALL_FETCH)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE);

    // TACKLE is single-target, but with 2 live enemies this is still
    // ambiguous - the engine pushes SelectTargetPhase regardless of the
    // explicit target passed to move.select().
    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    const status = await advanceDoubleCombatAfterAction(
      game,
      { action_kind: "move", acting_field_index: 0, expects_select_target_phase: true },
      15000,
    );

    expect(status).toBe("ok");
  });
});
