import { AbilityId } from "#enums/ability-id";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for a pokeRogueBot RL-collector timeout pattern:
 * when every move slot has 0 PP left and no legal switch exists, a
 * harness does not need any special "no valid action" termination logic.
 * `CommandPhase.handleFightCommand` (src/phases/command-phase.ts) already
 * detects that no moveset slot `isUsable(...)` and substitutes
 * `MoveId.STRUGGLE` automatically - the harness only has to queue any
 * one of the (now-exhausted) move slots as normal, exactly as it would
 * for a regular move. Inventing custom no-valid-action fallback logic
 * instead of relying on this produced `no_valid_double_action` /
 * `no_valid_combat_action` collector terminations in the past. See
 * docs/modifier-strategic-fixed-seed-pipeline.md in the main repo
 * ("Wiederverwendbare Loesung fuer Double-Battle-Timeouts", part 3).
 *
 * Note: `GameManager`'s own `move.select()`/`move.use()` test helpers
 * deliberately refuse to queue a move with 0 PP left (their internal
 * `getMovePosition` filters on `ppUsed < getMovePp()`), since normally a
 * test shouldn't accidentally select an unusable move. That guard is
 * exactly what the real collector must NOT replicate, so this test
 * drives the FIGHT menu input directly instead of via that helper.
 */
describe("porubot regression - Struggle fallback needs no special harness logic", () => {
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
      .moveset([MoveId.TACKLE])
      .ability(AbilityId.BALL_FETCH)
      .battleStyle("single")
      .criticalHits(false)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
  });

  it("resolves to STRUGGLE when the only move slot is queued with 0 PP left", async () => {
    await game.classicMode.startBattle(SpeciesId.RATTATA);
    const player = game.field.getPlayerPokemon();

    // Exhaust the only move's PP - no special "Struggle" API is needed;
    // the harness just queues the same (now unusable) move slot as always.
    player.moveset[0].ppUsed = player.moveset[0].getMovePp();
    const movePosition = player.getMoveset().findIndex(m => m.moveId === MoveId.TACKLE);
    expect(movePosition).toBeGreaterThanOrEqual(0);

    game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
      game.scene.ui
        .setMode(UiMode.FIGHT, (game.scene.phaseManager.getCurrentPhase() as CommandPhase).getFieldIndex())
        .catch(() => {});
    });
    game.onNextPrompt("CommandPhase", UiMode.FIGHT, () => {
      (game.scene.phaseManager.getCurrentPhase() as CommandPhase).handleCommand(
        Command.FIGHT,
        movePosition,
        MoveUseMode.NORMAL,
      );
    });

    await game.phaseInterceptor.to("BerryPhase");

    expect(player).toHaveUsedMove(MoveId.STRUGGLE);
  });
});
