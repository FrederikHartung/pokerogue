import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for a pokeRogueBot RL-collector timeout pattern:
 * a move can faint the player's own active Pokemon as a side effect
 * (independent of the opponent's move or the battle's outcome), forcing
 * a SwitchPhase *in the middle of* the two-step wait that toNextTurn()
 * performs (TurnInitPhase -> CommandPhase), not only before it. A harness
 * that only checks for a pending switch prompt right after selecting a
 * move, then blocks on an "advance to next turn" helper that never
 * re-checks for a further switch, hangs here - even though the battle
 * itself is far from over (the enemy is still alive, more turns follow).
 * See docs/combat-training-wave-library-v2.md and docs/todo-next.md
 * in the main repo (Wave 8 rival incident).
 */
describe("porubot regression - forced switch mid-toNextTurn is not a hang", () => {
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
      .moveset([MoveId.SPLASH, MoveId.MEMENTO])
      .ability(AbilityId.BALL_FETCH)
      .battleStyle("single")
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
  });

  it("services the forced switch inside toNextTurn() and reaches the next CommandPhase", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.MAGIKARP);

    // Memento faints the user as a guaranteed side effect, independent of
    // damage/accuracy - deterministic without relying on lethal damage
    // calculations. The enemy survives, so the battle is not over.
    game.move.select(MoveId.MEMENTO);
    game.doSelectPartyPokemon(1, "SwitchPhase");
    await game.toNextTurn();

    const log = game.phaseInterceptor.log;
    expect(log).toContain("SwitchPhase");
    expect(log).toContain("CommandPhase");
    // The regression: this is a mid-battle forced switch, not a victory -
    // if BattleEndPhase/VictoryPhase showed up here, the scenario setup
    // itself would be wrong (the enemy should still be alive).
    expect(log).not.toContain("BattleEndPhase");
    expect(log).not.toContain("VictoryPhase");

    expect(game.field.getPlayerPokemon().species.speciesId).toBe(SpeciesId.MAGIKARP);
  });
});
