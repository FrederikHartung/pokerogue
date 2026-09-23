import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MOVE_SLOT_TO_REPLACE = 3;

/**
 * Registers the CONFIRM ("learn it?" -> yes) and SUMMARY (pick which move
 * to replace) prompts for exactly one LearnMovePhase occurrence. Must be
 * called again before every further occurrence - prompts are one-shot.
 */
function serviceOneLearnMovePhase(game: GameManager) {
  game.onNextPrompt("LearnMovePhase", UiMode.CONFIRM, () => {
    game.scene.ui.processInput(Button.ACTION);
  });
  game.onNextPrompt("LearnMovePhase", UiMode.SUMMARY, () => {
    game.scene.ui.setCursor(MOVE_SLOT_TO_REPLACE);
    game.scene.ui.processInput(Button.ACTION);
  });
}

/**
 * Regression coverage for a pokeRogueBot RL-collector timeout pattern:
 * when a Pokemon with 4 known moves levels up and can learn a new one,
 * LearnMovePhase does not resolve on its own - it needs a CONFIRM answer
 * ("learn it?") and, if yes, a SUMMARY answer (which of the 4 existing
 * moves to replace). A harness that only waits for the phase to end
 * (or times out on it) instead of actively answering both prompts hangs
 * on every such level-up. A single kill can also cross more than one
 * move-learn threshold at once, queuing several LearnMovePhases back to
 * back - each occurrence needs its own fresh CONFIRM/SUMMARY prompts, so
 * a harness that only services one and then waits for a later phase
 * still hangs on the second. See docs/modifier-dqn-migration-plan.md in
 * the main repo ("LearnMovePhase wird im Harness jetzt aktiv ueber ...
 * bedient").
 */
describe("porubot regression - LearnMovePhase requires active servicing", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.xpMultiplier(50);
  });

  it("resolves every back-to-back occurrence and keeps advancing afterward", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const bulbasaur = game.field.getPlayerPokemon();
    const prevMoveset = [MoveId.SPLASH, MoveId.ABSORB, MoveId.ACID, MoveId.VINE_WHIP];

    game.move.changeMoveset(bulbasaur, prevMoveset);
    game.move.select(MoveId.SPLASH);
    await game.doKillOpponents();

    // A single kill's XP can cross more than one move-learn threshold,
    // queuing several LearnMovePhases in a row - each needs its own fresh
    // prompt registration, since prompts are one-shot. Bounded loop guards
    // against a real hang turning into an actual infinite loop here.
    let learnMovePhaseCount = 0;
    const MAX_LEARN_MOVE_PHASES = 5;
    do {
      serviceOneLearnMovePhase(game);
      await game.phaseInterceptor.to("LearnMovePhase");
      learnMovePhaseCount++;
    } while (
      game.scene.phaseManager.getCurrentPhase().phaseName === "LearnMovePhase"
      && learnMovePhaseCount < MAX_LEARN_MOVE_PHASES
    );

    expect(learnMovePhaseCount).toBeLessThan(MAX_LEARN_MOVE_PHASES);
    expect(bulbasaur.getMoveset()).toHaveLength(4);
    // Whatever was learned last replaced the targeted slot.
    expect(bulbasaur.moveset[MOVE_SLOT_TO_REPLACE]?.moveId).not.toBe(prevMoveset[MOVE_SLOT_TO_REPLACE]);

    // The regression: the run must keep progressing past every
    // LearnMovePhase occurrence instead of hanging on any of them (a
    // naive "wait it out" harness would not get here at all).
    await game.toNextWave();
    expect(game.phaseInterceptor.log).toContain("LearnMovePhase");
    expect(game.phaseInterceptor.log).toContain("NewBattlePhase");
  });
});
