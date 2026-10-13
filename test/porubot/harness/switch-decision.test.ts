import { AbilityId } from "#enums/ability-id";
import { BattleStyle } from "#enums/battle-style";
import { BattleType } from "#enums/battle-type";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  advanceCombatAfterAction,
  resolveForcedSwitchIfNeeded,
  resolveOptionalCheckSwitchIfNeeded,
  sleep,
  withTimeout,
} from "./battle-command-advance";
import { installSingleDriverPhaseInterceptor } from "./single-driver-phase-interceptor";
import { type SwitchDecisionKind, type SwitchDecisionResult, setSwitchDecisionProvider } from "./switch-decision";

/**
 * Self-test for the optional switch decision hook (switch-decision.ts): with a provider the harness waits for its
 * asynchronous answer inside its existing polling loops; without one (or on `null`) it keeps its default behaviour.
 */
describe("porubot harness - switch decision hook", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    installSingleDriverPhaseInterceptor(game);
  });

  function delayedProvider(calls: SwitchDecisionKind[], answer: SwitchDecisionResult) {
    return async (_game: GameManager, kind: SwitchDecisionKind): Promise<SwitchDecisionResult> => {
      calls.push(kind);
      // Simulates a policy worker round trip; the harness loops must keep polling meanwhile.
      await sleep(150);
      return answer;
    };
  }

  function setUpFaintOnFirstTurn() {
    game.override
      .battleStyle("single")
      .startingLevel(1)
      .enemyLevel(100)
      .moveset([MoveId.SPLASH])
      .ability(AbilityId.BALL_FETCH)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.TACKLE);
  }

  it("sends out the party member chosen by the provider after a faint", async () => {
    setUpFaintOnFirstTurn();
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);
    const calls: SwitchDecisionKind[] = [];
    setSwitchDecisionProvider(game, delayedProvider(calls, 2));

    game.move.select(MoveId.SPLASH);
    const status = await advanceCombatAfterAction(game, 8000);

    expect(status).toBe("ok");
    expect(calls).toEqual(["forced_switch"]);
    expect(game.scene.getPlayerPokemon()?.species.speciesId).toBe(SpeciesId.BULBASAUR);
  });

  it("falls back to the first eligible party member when the provider returns null", async () => {
    setUpFaintOnFirstTurn();
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);
    setSwitchDecisionProvider(game, delayedProvider([], null));

    game.move.select(MoveId.SPLASH);
    const status = await advanceCombatAfterAction(game, 8000);

    expect(status).toBe("ok");
    expect(game.scene.getPlayerPokemon()?.species.speciesId).toBe(SpeciesId.SQUIRTLE);
  });

  async function startWildBattleWithSwitchOffer(answer: SwitchDecisionResult): Promise<SwitchDecisionKind[]> {
    game.override
      .battleStyle("single")
      .battleType(BattleType.WILD)
      .startingWave(2)
      .moveset([MoveId.SPLASH])
      .ability(AbilityId.BALL_FETCH)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
    game.settings.battleStyle(BattleStyle.SWITCH);
    const calls: SwitchDecisionKind[] = [];
    setSwitchDecisionProvider(game, delayedProvider(calls, answer));
    await game.classicMode.runToSummon(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);

    let reachedCommand = false;
    const pump = withTimeout(game.phaseInterceptor.to("CommandPhase"), 8000, "check_switch_to_command").then(() => {
      reachedCommand = true;
    });
    const startedAt = Date.now();
    while (!reachedCommand && Date.now() - startedAt < 8000) {
      resolveOptionalCheckSwitchIfNeeded(game);
      resolveForcedSwitchIfNeeded(game);
      await sleep(25);
    }
    await pump;
    return calls;
  }

  it("accepts the switch offer with the provider's party member", async () => {
    const calls = await startWildBattleWithSwitchOffer(2);

    expect(calls).toEqual(["check_switch"]);
    expect(game.phaseInterceptor.log).toContain("CheckSwitchPhase");
    expect(game.scene.getPlayerPokemon()?.species.speciesId).toBe(SpeciesId.BULBASAUR);
  });

  it("declines the switch offer when the provider answers stay", async () => {
    const calls = await startWildBattleWithSwitchOffer("stay");

    expect(calls).toEqual(["check_switch"]);
    expect(game.scene.getPlayerPokemon()?.species.speciesId).toBe(SpeciesId.FEEBAS);
  });
});
