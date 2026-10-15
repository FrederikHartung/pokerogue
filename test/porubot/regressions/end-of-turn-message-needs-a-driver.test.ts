import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { advanceCombatAfterAction } from "#test/porubot/harness/battle-command-advance";
import { installSingleDriverPhaseInterceptor } from "#test/porubot/harness/single-driver-phase-interceptor";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for a pokeRogueBot strategic-collector timeout
 * (`step_timeout:advance_combat_after_action` in MessagePhase/MESSAGE), first
 * seen once real seeds were used (2026-10-15, seed modifier-strategic-eval-s12):
 * when a field effect ends at the end of a turn ("The effects of Water Sport
 * have faded."), a MessagePhase follows TurnEndPhase. `toEndOfTurn()` already
 * resolved, nothing drives that MessagePhase (interceptor "idling"), and the
 * wait loop only kept pressing ACTION on the message. `advanceCombatAfterAction`
 * now runs such phases via `withIdlePhaseDriver`. See the main repo's
 * docs/pokerogue-headless-test-harness-mechanics.md, 3.18.
 */
describe("porubot regression - end-of-turn message needs a phase driver", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    installSingleDriverPhaseInterceptor(game);
    game.override
      .moveset([MoveId.WATER_SPORT, MoveId.SPLASH])
      .ability(AbilityId.BALL_FETCH)
      .battleStyle("single")
      .criticalHits(false)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
  });

  it("reaches the next CommandPhase on the turn Water Sport fades", async () => {
    await game.classicMode.startBattle(SpeciesId.RATTATA);

    game.move.select(MoveId.WATER_SPORT);
    expect(await advanceCombatAfterAction(game, 15000)).toBe("ok");

    // Water Sport lasts 5 turns; its fade message comes after TurnEndPhase of the last one.
    for (let turn = 2; turn <= 6; turn += 1) {
      game.move.select(MoveId.SPLASH);
      expect(await advanceCombatAfterAction(game, 15000)).toBe("ok");
    }

    expect(
      game.textInterceptor.logs.some(message => message.includes("Water Sport") && message.includes("faded")),
    ).toBe(true);
    expect(game.isCurrentPhase("CommandPhase")).toBe(true);
  }, 120_000);
});
