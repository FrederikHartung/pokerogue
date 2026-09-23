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
});
