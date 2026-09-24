import { allMoves } from "#data/data-lists";
import { Button } from "#enums/buttons";
import { MoveCategory } from "#enums/move-category";
import { MoveId } from "#enums/move-id";
import { UiMode } from "#enums/ui-mode";
import type { GameManager } from "#test/framework/game-manager";

/**
 * Generic, RL-policy-agnostic phase-/prompt-driving logic shared between:
 * - the pokeRogueBot RL collector (scripts/90-dev/rl/templates/modifier-fixed-seed-collector.test.template.ts
 *   in the main repo, which imports this module), and
 * - regression/replay tests under pokerogue/test/porubot/ (which can exercise
 *   the exact same production code instead of re-implementing it).
 *
 * Scope boundary (see AGENTS.md "Stehende Ausnahme ... harness/"): this file
 * knows nothing about RL policy, DQN inference, checkpoint paths, or JSONL
 * output - only how to reliably wait for/advance through PokeRogue's phase
 * and prompt machinery once an action has already been queued elsewhere.
 * Background on why these situations arise at all is documented centrally in
 * docs/pokerogue-headless-test-harness-mechanics.md (main repo).
 */

/** The subset of a collector's own action-snapshot type this module needs. */
export interface DoubleCombatAdvanceAction {
  action_kind: "move" | "switch";
  acting_field_index: number;
  expects_select_target_phase?: boolean;
}

export type AdvanceStatus = "ok" | "terminal" | "timeout";

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`step_timeout:${label}:${timeoutMs}`)), timeoutMs);
    }),
  ]);
}

function getMoveNameSafe(move: any): string {
  return move?.getName?.() ?? move?.name ?? MoveId[move?.moveId] ?? String(move?.moveId ?? "unknown");
}

function getMoveCategorySafe(move: any): number {
  return move?.category ?? move?.getCategory?.() ?? -1;
}

function getMovePowerSafe(move: any): number {
  return move?.power ?? move?.getPower?.() ?? 0;
}

function getMoveAccuracySafe(move: any): number {
  const accuracy = move?.accuracy ?? move?.getAccuracy?.();
  return typeof accuracy === "number" && accuracy > 0 ? accuracy : 100;
}

function getMovePpSafe(move: any): number {
  return move?.pp ?? move?.getMovePp?.() ?? 0;
}

function getMoveTypeSafe(move: any): number | null {
  return move?.type ?? move?.getType?.() ?? null;
}

function findWeakestMoveIndex(moves: any[], predicate: (move: any) => boolean): number {
  let lowestScore = Number.POSITIVE_INFINITY;
  let weakestIndex = -1;
  moves.forEach((move, index) => {
    if (!move || !predicate(move)) {
      return;
    }
    const score = getMovePowerSafe(move) * getMoveAccuracySafe(move);
    if (score < lowestScore) {
      lowestScore = score;
      weakestIndex = index;
    }
  });
  return weakestIndex;
}

/**
 * Heuristic for which of 4 known moves to replace when a Pokemon can learn a
 * new one (LearnMovePhase's SUMMARY prompt). Not an RL policy decision - a
 * fixed, deterministic rule the harness needs to answer the prompt at all.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export function decideLearnMoveSlot(game: GameManager): number {
  const currentPhase = game.scene.phaseManager?.getCurrentPhase?.() as any;
  const pokemon = currentPhase?.getPokemon?.() ?? game.scene.getPlayerPokemon?.();
  const moveId = currentPhase?.moveId;
  const newMove = moveId == null ? null : allMoves[moveId];

  if (!pokemon || !newMove) {
    return 4;
  }

  const existingMoves = (pokemon.getMoveset?.() ?? []).filter((move: any) => move != null);
  if (existingMoves.length < 4) {
    return 4;
  }

  const species = pokemon.species;
  const type1 = species?.type1 ?? null;
  const type2 = species?.type2 ?? null;
  const newMoveCategory = getMoveCategorySafe(newMove);
  const newMovePower = getMovePowerSafe(newMove);
  const newMovePp = getMovePpSafe(newMove);
  const newMoveType = getMoveTypeSafe(newMove);
  const newMoveName = getMoveNameSafe(newMove);

  if (newMoveCategory === MoveCategory.STATUS || newMovePp === 5 || newMovePower <= 0 || newMoveName === "Belch") {
    return 4;
  }
  if (type2 != null && newMoveType != null && newMoveType !== type1 && newMoveType !== type2) {
    return 4;
  }

  const statusMoveIndex = existingMoves.findIndex((move: any) => getMoveCategorySafe(move) === MoveCategory.STATUS);
  if (statusMoveIndex >= 0) {
    return statusMoveIndex;
  }

  const countMovesOfType = (targetType: number | null): number =>
    targetType == null ? 0 : existingMoves.filter((move: any) => getMoveTypeSafe(move) === targetType).length;

  if (type2 != null) {
    if (newMoveType !== type1 && newMoveType !== type2) {
      return 4;
    }
    const countOfNewType = countMovesOfType(newMoveType);
    const replaceIndex =
      countOfNewType < 2
        ? findWeakestMoveIndex(existingMoves, move => getMoveTypeSafe(move) !== newMoveType)
        : findWeakestMoveIndex(existingMoves, move => getMoveTypeSafe(move) === newMoveType);
    return replaceIndex >= 0 ? replaceIndex : 4;
  }

  const ownTypeCount = countMovesOfType(type1);
  if (newMoveType === type1) {
    const replaceIndex =
      ownTypeCount < 2
        ? findWeakestMoveIndex(existingMoves, move => getMoveTypeSafe(move) !== type1)
        : findWeakestMoveIndex(existingMoves, move => getMoveTypeSafe(move) === type1);
    return replaceIndex >= 0 ? replaceIndex : 4;
  }

  if (ownTypeCount > 2) {
    const replaceIndex = findWeakestMoveIndex(existingMoves, move => getMoveTypeSafe(move) === type1);
    return replaceIndex >= 0 ? replaceIndex : 4;
  }

  const replaceIndex = findWeakestMoveIndex(existingMoves, move => getMoveTypeSafe(move) !== type1);
  return replaceIndex >= 0 ? replaceIndex : 4;
}

export function resolveLearnMoveIfNeeded(game: GameManager): boolean {
  if (!game.isCurrentPhase("LearnMovePhase")) {
    return false;
  }

  const uiMode = game.scene.ui?.getMode?.();
  if (uiMode === UiMode.CONFIRM || uiMode === UiMode.MESSAGE || uiMode === UiMode.EVOLUTION_SCENE) {
    game.scene.ui.processInput(Button.ACTION);
    return true;
  }

  if (uiMode === UiMode.SUMMARY) {
    const moveSlot = decideLearnMoveSlot(game);
    game.scene.ui.setCursor(moveSlot);
    game.scene.ui.processInput(Button.ACTION);
    return true;
  }

  return false;
}

export function advanceCurrentUiPromptIfPossible(game: GameManager): boolean {
  const uiMode = game.scene.ui?.getMode?.();
  if (uiMode !== UiMode.MESSAGE && uiMode !== UiMode.CONFIRM && uiMode !== UiMode.EVOLUTION_SCENE) {
    return false;
  }
  if (game.isCurrentPhase("SwitchSummonPhase") || game.isCurrentPhase("SwitchPhase")) {
    // A stray button press here can race this phase's own message/
    // continuation flow before its start() has even run (the phase becomes
    // "current" without starting - see docs/pokerogue-headless-test-harness-mechanics.md),
    // permanently wedging it instead of dismissing anything meaningful.
    // SwitchSummonPhase needs no player input at all; SwitchPhase does (the
    // forced-switch party selection), but that is serviced explicitly by
    // resolveForcedSwitchIfNeeded() once its own start() has actually opened
    // the party UI - a blind ACTION press here can fire before that point
    // and prevent it from ever opening.
    return false;
  }

  const handler = game.scene.ui.getHandler() as { processInput?: (button: Button) => boolean } | undefined;
  if (typeof handler?.processInput === "function") {
    handler.processInput(Button.ACTION);
    return true;
  }

  game.scene.ui.processInput(Button.ACTION);
  return true;
}

export function getCommandFieldIndexSafe(game: GameManager): number {
  const currentPhase = game.scene.phaseManager?.getCurrentPhase?.() as { getFieldIndex?: () => number } | undefined;
  if (typeof currentPhase?.getFieldIndex === "function") {
    const fieldIndex = currentPhase.getFieldIndex();
    if (Number.isInteger(fieldIndex)) {
      return fieldIndex;
    }
  }
  return 0;
}

export function getCurrentCommandPhaseFieldIndex(game: GameManager): number | null {
  if (!game.isCurrentPhase("CommandPhase")) {
    return null;
  }
  const currentPhase = game.scene.phaseManager?.getCurrentPhase?.() as { getFieldIndex?: () => number } | undefined;
  if (typeof currentPhase?.getFieldIndex !== "function") {
    return null;
  }
  const fieldIndex = currentPhase.getFieldIndex();
  return Number.isInteger(fieldIndex) ? fieldIndex : null;
}

export function normalizeCommandPhaseUiIfNeeded(game: GameManager): boolean {
  if (!game.isCurrentPhase("CommandPhase")) {
    return false;
  }
  if (game.scene.ui?.getMode?.() !== UiMode.PARTY) {
    return false;
  }
  game.scene.ui.setMode(UiMode.COMMAND, getCommandFieldIndexSafe(game));
  return true;
}

/**
 * Detects a double-battle CommandPhase stuck at `ui_mode: MESSAGE` for the
 * partner field (field index > 0) so callers can attempt a recovery instead
 * of hanging. See docs/pokerogue-headless-test-harness-mechanics.md for the
 * historical incident this guards against.
 */
export function getRecoverableDoublePartnerCommandFieldIndex(game: GameManager): number | null {
  if (!game.scene.currentBattle?.double || !game.isCurrentPhase("CommandPhase")) {
    return null;
  }
  if (game.scene.ui?.getMode?.() !== UiMode.MESSAGE) {
    return null;
  }

  const fieldIndex = getCommandFieldIndexSafe(game);
  if (!Number.isInteger(fieldIndex) || fieldIndex <= 0) {
    return null;
  }

  const currentPhase = game.scene.phaseManager?.getCurrentPhase?.() as { getPokemon?: () => any } | undefined;
  const phasePokemon = typeof currentPhase?.getPokemon === "function" ? currentPhase.getPokemon() : null;
  if (!phasePokemon || phasePokemon.isFainted?.()) {
    return null;
  }

  const activePlayerField = game.scene.getPlayerField(true).filter((pokemon: any) => pokemon?.isActive?.());
  if (activePlayerField.length <= fieldIndex) {
    return null;
  }

  const turnCommands = (game.scene.currentBattle as any)?.turnCommands;
  if (Array.isArray(turnCommands) && turnCommands[fieldIndex]?.skip) {
    return null;
  }

  return fieldIndex;
}

export function hasRemainingPlayerTeam(game: GameManager): boolean {
  return game.scene.getPlayerParty().some(member => !member.isFainted() && member.isAllowedInBattle());
}

export function isVictorySafe(game: GameManager): boolean {
  const battle = game.scene.currentBattle as any;
  if (!battle || !Array.isArray(battle.enemyParty)) {
    return false;
  }
  return battle.enemyParty.every((pokemon: any) => pokemon.isFainted());
}

export function isCombatTerminalPhase(game: GameManager): boolean {
  return (
    game.isCurrentPhase("GameOverPhase")
    || game.isCurrentPhase("PostGameOverPhase")
    || game.isCurrentPhase("TitlePhase")
    || game.isCurrentPhase("BattleEndPhase")
    || game.isCurrentPhase("SelectModifierPhase")
    || game.isCurrentPhase("EggLapsePhase")
  );
}

export function isGameTerminalPhase(game: GameManager): boolean {
  return (
    game.isCurrentPhase("GameOverPhase")
    || game.isCurrentPhase("PostGameOverPhase")
    || game.isCurrentPhase("TitlePhase")
  );
}

export function isSelectModifierResolutionPhase(game: GameManager): boolean {
  return (
    game.isCurrentPhase("TrainerVictoryPhase")
    || game.isCurrentPhase("MoneyRewardPhase")
    || game.isCurrentPhase("ModifierRewardPhase")
    || game.isCurrentPhase("EggLapsePhase")
  );
}

export function clearStalePromptsForForcedSwitch(game: GameManager): void {
  const interceptor = game.phaseInterceptor as any;
  if (!Array.isArray(interceptor?.prompts) || interceptor.prompts.length === 0) {
    return;
  }
  while (interceptor.prompts.length > 0 && interceptor.prompts[0]?.phaseTarget === "CheckSwitchPhase") {
    interceptor.prompts.shift();
  }
}

export function resolveOptionalCheckSwitchIfNeeded(game: GameManager): "not_check_switch" | "skipped" {
  if (!game.isCurrentPhase("CheckSwitchPhase")) {
    return "not_check_switch";
  }
  if (game.scene.ui?.getMode?.() !== UiMode.CONFIRM) {
    return "not_check_switch";
  }
  game.setMode(UiMode.MESSAGE);
  game.endPhase();
  clearStalePromptsForForcedSwitch(game);
  return "skipped";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export function resolveForcedSwitchIfNeeded(game: GameManager): "not_switch_phase" | "selected" | "no_candidate" {
  const battle = game.scene.currentBattle as any;
  if (!game.isCurrentPhase("SwitchPhase")) {
    if (battle && Object.hasOwn(battle, "__collectorForcedSwitchQueued")) {
      // biome-ignore lint/performance/noDelete: must remove the property (not just set it to undefined) so the Object.hasOwn presence-check above stays accurate
      delete battle.__collectorForcedSwitchQueued;
    }
    return "not_switch_phase";
  }

  clearStalePromptsForForcedSwitch(game);
  const party = game.scene.getPlayerParty();
  const nextIndex = party.findIndex(member => !member.isFainted() && !member.isOnField() && member.isAllowedInBattle());
  if (nextIndex < 0) {
    return "no_candidate";
  }

  if (game.scene.ui?.getMode?.() === UiMode.PARTY) {
    const handler = game.scene.ui.getHandler() as any;
    if (typeof handler?.setCursor === "function") {
      handler.setCursor(nextIndex);
    }
    if (
      typeof handler?.processInput === "function"
      && Number.isInteger(handler?.cursor)
      && handler.cursor !== nextIndex
    ) {
      const direction = handler.cursor < nextIndex ? Button.DOWN : Button.UP;
      for (let attempts = 0; attempts < 8 && handler.cursor !== nextIndex; attempts += 1) {
        handler.processInput(direction);
      }
    }
    if (typeof handler?.processInput === "function") {
      handler.processInput(Button.ACTION);
      if (handler.optionsMode === true) {
        handler.processInput(Button.ACTION);
      }
    }
  } else if (battle?.__collectorForcedSwitchQueued !== nextIndex) {
    game.doSelectPartyPokemon(nextIndex);
    if (battle) {
      battle.__collectorForcedSwitchQueued = nextIndex;
    }
  }

  return "selected";
}

export function hasLoggedTerminalPhaseSince(game: GameManager, fromIndex: number): boolean {
  const phaseLog = Array.isArray(game.phaseInterceptor.log) ? game.phaseInterceptor.log : [];
  const terminalPhaseNames = [
    "GameOverPhase",
    "PostGameOverPhase",
    "TitlePhase",
    "BattleEndPhase",
    "SelectModifierPhase",
    "EggLapsePhase",
  ];
  for (let index = Math.max(0, fromIndex); index < phaseLog.length; index += 1) {
    if (terminalPhaseNames.includes(String(phaseLog[index]))) {
      return true;
    }
  }
  return false;
}

export function hasLoggedAnyPhaseSince(game: GameManager, fromIndex: number, phaseNames: string[]): boolean {
  const phaseLog = Array.isArray(game.phaseInterceptor.log) ? game.phaseInterceptor.log : [];
  const wanted = new Set(phaseNames);
  for (let index = Math.max(0, fromIndex); index < phaseLog.length; index += 1) {
    if (wanted.has(String(phaseLog[index]))) {
      return true;
    }
  }
  return false;
}

/**
 * Waits for `promise` to settle while keeping the game unstuck (answering
 * learn-move/message/confirm prompts, resolving forced switches) in the
 * meantime, until `isSuccessfulState` says we can stop early, a terminal
 * phase is reached, or `timeoutMs` elapses. Also reused as its own inner
 * `timeoutMs` bound if a TurnInitPhase message gets stuck long enough to
 * attempt a CommandPhase-recovery.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export async function waitForPromiseOrTerminal(
  game: GameManager,
  promise: Promise<unknown>,
  timeoutMs: number,
  isSuccessfulState?: (game: GameManager) => boolean,
  terminalPhaseLogStartIndex?: number,
): Promise<AdvanceStatus> {
  let resolved = false;
  let failed = false;
  let stuckTurnInitMessageSince: number | null = null;

  promise
    .then(() => {
      resolved = true;
    })
    .catch(() => {
      failed = true;
    });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const loggedTerminal =
      terminalPhaseLogStartIndex != null && hasLoggedTerminalPhaseSince(game, terminalPhaseLogStartIndex);
    if (resolveLearnMoveIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (normalizeCommandPhaseUiIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (game.isCurrentPhase("TurnInitPhase") && game.scene.ui?.getMode?.() === UiMode.MESSAGE) {
      if (stuckTurnInitMessageSince == null) {
        stuckTurnInitMessageSince = Date.now();
      } else if (Date.now() - stuckTurnInitMessageSince >= 250) {
        console.error(
          `[modifier-fixed-seed-promise-wait-recover-turn-init] wave=${game.scene.currentBattle?.waveIndex ?? "unknown"} turn=${game.scene.currentBattle?.turn ?? "unknown"}`,
        );
        const recoverPromise = withTimeout(
          game.phaseInterceptor.to("CommandPhase"),
          timeoutMs,
          "promise_wait_command_phase_recover",
        );
        let recoverResolved = false;
        let recoverFailed = false;
        recoverPromise
          .then(() => {
            recoverResolved = true;
          })
          .catch(() => {
            recoverFailed = true;
          });
        const recoverStartedAt = Date.now();
        while (Date.now() - recoverStartedAt < timeoutMs) {
          const recoverLoggedTerminal =
            terminalPhaseLogStartIndex != null && hasLoggedTerminalPhaseSince(game, terminalPhaseLogStartIndex);
          if (resolveLearnMoveIfNeeded(game)) {
            await sleep(25);
            continue;
          }
          if (normalizeCommandPhaseUiIfNeeded(game)) {
            await sleep(25);
            continue;
          }
          if (advanceCurrentUiPromptIfPossible(game)) {
            await sleep(25);
            continue;
          }
          resolveOptionalCheckSwitchIfNeeded(game);
          const recoverForcedSwitchStatus = resolveForcedSwitchIfNeeded(game);
          if (recoverForcedSwitchStatus === "no_candidate") {
            return "terminal";
          }
          if (isCombatTerminalPhase(game) || recoverLoggedTerminal) {
            return "terminal";
          }
          if (isSuccessfulState?.(game) === true) {
            return "ok";
          }
          if (game.isCurrentPhase("CommandPhase") && game.scene.ui?.getMode?.() === UiMode.COMMAND) {
            return "ok";
          }
          if (recoverResolved) {
            return "ok";
          }
          if (recoverFailed) {
            return isCombatTerminalPhase(game) || recoverLoggedTerminal ? "terminal" : "timeout";
          }
          await sleep(25);
        }
        return isCombatTerminalPhase(game)
          || (terminalPhaseLogStartIndex != null && hasLoggedTerminalPhaseSince(game, terminalPhaseLogStartIndex))
          ? "terminal"
          : "timeout";
      }
    } else {
      stuckTurnInitMessageSince = null;
    }
    if (isVictorySafe(game) && game.isCurrentPhase("SwitchPhase") && game.scene.ui?.getMode?.() === UiMode.MESSAGE) {
      const battle = game.scene.currentBattle as any;
      if (battle && Object.hasOwn(battle, "__collectorForcedSwitchQueued")) {
        // biome-ignore lint/performance/noDelete: must remove the property (not just set it to undefined) so the Object.hasOwn presence-check above stays accurate
        delete battle.__collectorForcedSwitchQueued;
      }
      game.endPhase();
      await sleep(25);
      continue;
    }
    if (advanceCurrentUiPromptIfPossible(game)) {
      await sleep(25);
      continue;
    }
    resolveOptionalCheckSwitchIfNeeded(game);
    const forcedSwitchStatus = resolveForcedSwitchIfNeeded(game);
    if (forcedSwitchStatus === "no_candidate") {
      return "terminal";
    }
    if (isCombatTerminalPhase(game) || loggedTerminal) {
      return "terminal";
    }
    if (isSuccessfulState?.(game) === true) {
      return "ok";
    }
    if (resolved) {
      return "ok";
    }
    if (failed) {
      return isCombatTerminalPhase(game) || loggedTerminal ? "terminal" : "timeout";
    }
    await sleep(25);
  }

  return isCombatTerminalPhase(game)
    || (terminalPhaseLogStartIndex != null && hasLoggedTerminalPhaseSince(game, terminalPhaseLogStartIndex))
    ? "terminal"
    : "timeout";
}

export function isStableCommandInputState(game: GameManager): boolean {
  return game.isCurrentPhase("CommandPhase") && game.scene.ui?.getMode?.() === UiMode.COMMAND;
}

export function hasAdvancedToFreshBattleCommandState(game: GameManager, startingWaveIndex: number): boolean {
  if (!isStableCommandInputState(game)) {
    return false;
  }
  const currentWaveIndex = game.scene.currentBattle?.waveIndex ?? startingWaveIndex;
  if (currentWaveIndex <= startingWaveIndex) {
    return false;
  }
  return getCommandFieldIndexSafe(game) === 0;
}

export function hasAdvancedToStableCommandState(
  game: GameManager,
  startingWaveIndex: number,
  startingTurn: number,
): boolean {
  if (!isStableCommandInputState(game)) {
    return false;
  }
  const currentWaveIndex = game.scene.currentBattle?.waveIndex ?? startingWaveIndex;
  const currentTurn = game.scene.currentBattle?.turn ?? startingTurn;
  return currentWaveIndex > startingWaveIndex || currentTurn > startingTurn;
}

export function hasAdvancedToStableSingleBattleCommandState(
  game: GameManager,
  startingWaveIndex: number,
  startingTurn: number,
  phaseLogStartIndex: number,
): boolean {
  if (hasAdvancedToStableCommandState(game, startingWaveIndex, startingTurn)) {
    return true;
  }
  if (!isStableCommandInputState(game)) {
    return false;
  }
  return hasLoggedAnyPhaseSince(game, phaseLogStartIndex, ["SwitchSummonPhase", "PostSummonPhase", "TurnInitPhase"]);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export async function waitForCommandOrTerminalAfterForcedSwitch(
  game: GameManager,
  timeoutMs: number,
): Promise<AdvanceStatus> {
  const startedAt = Date.now();
  let stuckSwitchMessageSince: number | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (resolveLearnMoveIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (normalizeCommandPhaseUiIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (game.isCurrentPhase("SwitchPhase") && game.scene.ui?.getMode?.() === UiMode.MESSAGE) {
      const battle = game.scene.currentBattle as any;
      if (battle && Object.hasOwn(battle, "__collectorForcedSwitchQueued")) {
        if (isVictorySafe(game)) {
          // biome-ignore lint/performance/noDelete: must remove the property (not just set it to undefined) so the Object.hasOwn presence-check above stays accurate
          delete battle.__collectorForcedSwitchQueued;
        }
        game.endPhase();
        await sleep(25);
        continue;
      }
      if (stuckSwitchMessageSince == null) {
        stuckSwitchMessageSince = Date.now();
      } else if (Date.now() - stuckSwitchMessageSince >= 250) {
        console.error(
          `[modifier-fixed-seed-forced-switch-restart] wave=${game.scene.currentBattle?.waveIndex ?? "unknown"} turn=${game.scene.currentBattle?.turn ?? "unknown"}`,
        );
        (game.scene.phaseManager.getCurrentPhase() as { start?: () => void } | undefined)?.start?.();
        await sleep(25);
        continue;
      }
    } else {
      stuckSwitchMessageSince = null;
    }
    if (isVictorySafe(game) && game.isCurrentPhase("SwitchPhase") && game.scene.ui?.getMode?.() === UiMode.MESSAGE) {
      const battle = game.scene.currentBattle as any;
      if (battle && Object.hasOwn(battle, "__collectorForcedSwitchQueued")) {
        // biome-ignore lint/performance/noDelete: must remove the property (not just set it to undefined) so the Object.hasOwn presence-check above stays accurate
        delete battle.__collectorForcedSwitchQueued;
      }
      game.endPhase();
      await sleep(25);
      continue;
    }
    if (advanceCurrentUiPromptIfPossible(game)) {
      await sleep(25);
      continue;
    }
    resolveOptionalCheckSwitchIfNeeded(game);
    const forcedSwitchStatus = resolveForcedSwitchIfNeeded(game);
    if (forcedSwitchStatus === "no_candidate") {
      return "terminal";
    }
    if (isCombatTerminalPhase(game)) {
      return "terminal";
    }
    if (game.isCurrentPhase("CommandPhase")) {
      return "ok";
    }
    await sleep(25);
  }
  return isCombatTerminalPhase(game) ? "terminal" : "timeout";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export async function waitForPostVictoryForcedSwitchResolution(
  game: GameManager,
  startingWaveIndex: number,
  timeoutMs: number,
): Promise<AdvanceStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (resolveLearnMoveIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (normalizeCommandPhaseUiIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (game.isCurrentPhase("SwitchPhase") && game.scene.ui?.getMode?.() === UiMode.MESSAGE) {
      const battle = game.scene.currentBattle as any;
      if (battle && Object.hasOwn(battle, "__collectorForcedSwitchQueued")) {
        // biome-ignore lint/performance/noDelete: must remove the property (not just set it to undefined) so the Object.hasOwn presence-check above stays accurate
        delete battle.__collectorForcedSwitchQueued;
      }
      game.endPhase();
      await sleep(25);
      continue;
    }
    if (advanceCurrentUiPromptIfPossible(game)) {
      await sleep(25);
      continue;
    }
    resolveOptionalCheckSwitchIfNeeded(game);
    const forcedSwitchStatus = resolveForcedSwitchIfNeeded(game);
    if (forcedSwitchStatus === "no_candidate") {
      return "terminal";
    }
    if (isGameTerminalPhase(game)) {
      return "terminal";
    }
    if (
      game.isCurrentPhase("BattleEndPhase")
      || isSelectModifierResolutionPhase(game)
      || game.isCurrentPhase("SelectModifierPhase")
    ) {
      return "ok";
    }
    if (hasAdvancedToFreshBattleCommandState(game, startingWaveIndex)) {
      return "ok";
    }
    await sleep(25);
  }
  return isGameTerminalPhase(game) ? "terminal" : "timeout";
}

/**
 * Advances the game after a single-battle combat action has already been
 * queued, until the next stable CommandPhase, a terminal phase, or
 * `stepTimeoutMs` elapses. See docs/pokerogue-headless-test-harness-mechanics.md
 * for the phase-ordering surprises this accounts for (post-victory switch,
 * forced switch mid-toNextTurn, LearnMovePhase, Struggle fallback).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export async function advanceCombatAfterAction(game: GameManager, stepTimeoutMs: number): Promise<AdvanceStatus> {
  const terminalPhasesForTurnAdvance = [
    "GameOverPhase",
    "PostGameOverPhase",
    "TitlePhase",
    "BattleEndPhase",
    "SelectModifierPhase",
    "EggLapsePhase",
  ];
  const startingWaveIndex = game.scene.currentBattle?.waveIndex ?? 0;
  const startingTurn = game.scene.currentBattle?.turn ?? 0;
  const endOfTurnPhaseLogStart = Array.isArray(game.phaseInterceptor.log) ? game.phaseInterceptor.log.length : 0;
  const endOfTurnStatus = await waitForPromiseOrTerminal(
    game,
    withTimeout(game.toEndOfTurn(), stepTimeoutMs, "end of turn"),
    stepTimeoutMs,
    currentGame =>
      hasAdvancedToStableSingleBattleCommandState(currentGame, startingWaveIndex, startingTurn, endOfTurnPhaseLogStart),
    endOfTurnPhaseLogStart,
  );

  if (endOfTurnStatus === "timeout" && game.isCurrentPhase("SwitchPhase")) {
    return waitForCommandOrTerminalAfterForcedSwitch(game, stepTimeoutMs);
  }
  if (
    endOfTurnStatus === "timeout"
    && (game.isCurrentPhase("BattleEndPhase")
      || isSelectModifierResolutionPhase(game)
      || game.isCurrentPhase("SelectModifierPhase"))
  ) {
    return "ok";
  }
  if (endOfTurnStatus !== "ok") {
    return endOfTurnStatus;
  }
  if (isCombatTerminalPhase(game)) {
    return "terminal";
  }

  const switchResolveStatus = resolveForcedSwitchIfNeeded(game);
  if (switchResolveStatus === "no_candidate") {
    return "terminal";
  }
  if (!hasRemainingPlayerTeam(game)) {
    return "terminal";
  }
  if (isVictorySafe(game)) {
    return waitForPostVictoryForcedSwitchResolution(game, startingWaveIndex, stepTimeoutMs);
  }
  if (hasAdvancedToStableSingleBattleCommandState(game, startingWaveIndex, startingTurn, endOfTurnPhaseLogStart)) {
    return "ok";
  }

  const phaseLogStart = Array.isArray(game.phaseInterceptor.log) ? game.phaseInterceptor.log.length : 0;
  let nextTurnResolved = false;
  let nextTurnTerminal = false;
  let nextTurnFailed = false;
  let stuckTurnInitMessageSince: number | null = null;
  const nextTurnPromise = game
    .toNextTurn(terminalPhasesForTurnAdvance)
    .then(result => {
      if (result === "terminal") {
        nextTurnTerminal = true;
      } else {
        nextTurnResolved = true;
      }
    })
    .catch(() => {
      nextTurnFailed = true;
    });

  const startedAt = Date.now();
  while (Date.now() - startedAt < stepTimeoutMs) {
    if (resolveLearnMoveIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (normalizeCommandPhaseUiIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (game.isCurrentPhase("TurnInitPhase") && game.scene.ui?.getMode?.() === UiMode.MESSAGE) {
      if (stuckTurnInitMessageSince == null) {
        stuckTurnInitMessageSince = Date.now();
      } else if (Date.now() - stuckTurnInitMessageSince >= 250) {
        console.error(
          `[modifier-fixed-seed-single-followup-recover-turn-init] wave=${game.scene.currentBattle?.waveIndex ?? "unknown"} turn=${game.scene.currentBattle?.turn ?? "unknown"}`,
        );
        const recoverStatus = await waitForPromiseOrTerminal(
          game,
          withTimeout(game.phaseInterceptor.to("CommandPhase"), stepTimeoutMs, "single_followup_command_phase_recover"),
          stepTimeoutMs,
        );
        if (recoverStatus !== "ok") {
          return recoverStatus;
        }
        await sleep(25);
        continue;
      }
    } else {
      stuckTurnInitMessageSince = null;
    }
    if (isVictorySafe(game) && game.isCurrentPhase("SwitchPhase") && game.scene.ui?.getMode?.() === UiMode.MESSAGE) {
      const battle = game.scene.currentBattle as any;
      if (battle && Object.hasOwn(battle, "__collectorForcedSwitchQueued")) {
        // biome-ignore lint/performance/noDelete: must remove the property (not just set it to undefined) so the Object.hasOwn presence-check above stays accurate
        delete battle.__collectorForcedSwitchQueued;
      }
      game.endPhase();
      await sleep(25);
      continue;
    }
    if (advanceCurrentUiPromptIfPossible(game)) {
      await sleep(25);
      continue;
    }
    resolveOptionalCheckSwitchIfNeeded(game);
    const forcedSwitchStatus = resolveForcedSwitchIfNeeded(game);
    if (forcedSwitchStatus === "no_candidate") {
      return "terminal";
    }
    if (nextTurnTerminal || isCombatTerminalPhase(game) || hasLoggedTerminalPhaseSince(game, phaseLogStart)) {
      return "terminal";
    }
    if (hasAdvancedToStableSingleBattleCommandState(game, startingWaveIndex, startingTurn, phaseLogStart)) {
      return "ok";
    }
    if (nextTurnResolved) {
      return "ok";
    }
    if (nextTurnFailed) {
      return isCombatTerminalPhase(game) || hasLoggedTerminalPhaseSince(game, phaseLogStart) ? "terminal" : "timeout";
    }
    await sleep(25);
  }

  if (isCombatTerminalPhase(game) || hasLoggedTerminalPhaseSince(game, phaseLogStart)) {
    return "terminal";
  }
  // biome-ignore lint/complexity/noVoid: intentionally marks nextTurnPromise as fire-and-forget once its own timeout window has elapsed
  void nextTurnPromise;
  return "timeout";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export async function waitForDoubleTargetPhaseOrImmediateFollowup(
  game: GameManager,
  action: DoubleCombatAdvanceAction,
  startingWaveIndex: number,
  startingTurn: number,
  timeoutMs: number,
): Promise<"select_target" | AdvanceStatus> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (resolveLearnMoveIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (normalizeCommandPhaseUiIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    resolveOptionalCheckSwitchIfNeeded(game);
    const forcedSwitchStatus = resolveForcedSwitchIfNeeded(game);
    if (forcedSwitchStatus === "no_candidate") {
      return "terminal";
    }
    if (isCombatTerminalPhase(game)) {
      return "terminal";
    }
    if (game.isCurrentPhase("SelectTargetPhase")) {
      // In this test framework, a phase becomes "current" (via PhaseManager.shiftPhase)
      // without its own start() ever running - only an explicit phaseInterceptor.to()
      // call actually drives that (PhaseInterceptor overrides
      // PhaseManager["startCurrentPhase"] to a no-op, see
      // docs/pokerogue-headless-test-harness-mechanics.md). Every other advance path in
      // this module is paired with a concurrent toNextTurn()/toEndOfTurn() pump, but
      // nothing pumps SelectTargetPhase specifically, so it can sit as "current" forever
      // without its UI ever reaching TARGET_SELECT. Since the target it names is already
      // the current phase, this call only starts and awaits that one phase - it does not
      // run any later, unrelated phases. Deliberately NOT wrapped in
      // waitForPromiseOrTerminal: its concurrent prompt/forced-switch polling interferes
      // with PhaseInterceptor's own internal timing here and reintroduces the hang.
      if (game.scene.ui?.getMode?.() !== UiMode.TARGET_SELECT) {
        try {
          await withTimeout(
            game.phaseInterceptor.to("SelectTargetPhase"),
            Math.max(1, timeoutMs - (Date.now() - startedAt)),
            "select_target_phase_start_pump",
          );
        } catch {
          return isCombatTerminalPhase(game) ? "terminal" : "timeout";
        }
      }
      return "select_target";
    }
    if (isStableCommandInputState(game)) {
      const fieldIndex = getCommandFieldIndexSafe(game);
      const currentWaveIndex = game.scene.currentBattle?.waveIndex ?? startingWaveIndex;
      const currentTurn = game.scene.currentBattle?.turn ?? startingTurn;
      if (
        fieldIndex > action.acting_field_index
        || currentTurn > startingTurn
        || currentWaveIndex > startingWaveIndex
      ) {
        console.error(
          `[modifier-fixed-seed-double-target-shortcut] wave=${game.scene.currentBattle?.waveIndex ?? "unknown"} start_wave=${startingWaveIndex} field=${action.acting_field_index} next_field=${fieldIndex} turn=${currentTurn}`,
        );
        return "ok";
      }
    }
    if (advanceCurrentUiPromptIfPossible(game)) {
      await sleep(25);
      continue;
    }
    await sleep(25);
  }

  return isCombatTerminalPhase(game) ? "terminal" : "timeout";
}

export async function waitForDoubleTargetSelectionResolution(
  game: GameManager,
  timeoutMs: number,
): Promise<AdvanceStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isCombatTerminalPhase(game)) {
      return "terminal";
    }
    if (game.isCurrentPhase("SelectTargetPhase") && advanceCurrentUiPromptIfPossible(game)) {
      await sleep(25);
      continue;
    }
    if (!game.isCurrentPhase("SelectTargetPhase") && game.scene.ui.getMode() !== UiMode.TARGET_SELECT) {
      return "ok";
    }
    await sleep(25);
  }
  return isCombatTerminalPhase(game) ? "terminal" : "timeout";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export async function waitForDoubleFieldZeroFollowup(
  game: GameManager,
  startingWaveIndex: number,
  startingTurn: number,
  timeoutMs: number,
): Promise<"partner_command" | "turn_progressed" | "terminal" | "timeout"> {
  const startedAt = Date.now();
  let stuckCommandMessageSince: number | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (resolveLearnMoveIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    if (normalizeCommandPhaseUiIfNeeded(game)) {
      await sleep(25);
      continue;
    }
    resolveOptionalCheckSwitchIfNeeded(game);
    const forcedSwitchStatus = resolveForcedSwitchIfNeeded(game);
    if (forcedSwitchStatus === "no_candidate") {
      return "terminal";
    }
    if (isCombatTerminalPhase(game)) {
      return "terminal";
    }

    if (isStableCommandInputState(game)) {
      const fieldIndex = getCommandFieldIndexSafe(game);
      const currentWaveIndex = game.scene.currentBattle?.waveIndex ?? startingWaveIndex;
      if (currentWaveIndex > startingWaveIndex) {
        return "turn_progressed";
      }
      if (fieldIndex > 0) {
        return "partner_command";
      }
      const currentTurn = game.scene.currentBattle?.turn ?? startingTurn;
      if (currentTurn > startingTurn) {
        return "turn_progressed";
      }
    }

    if (game.isCurrentPhase("CommandPhase") && game.scene.ui.getMode() === UiMode.MESSAGE) {
      if (stuckCommandMessageSince == null) {
        stuckCommandMessageSince = Date.now();
      } else if (Date.now() - stuckCommandMessageSince >= 250) {
        const recoverableDoublePartnerFieldIndex = getRecoverableDoublePartnerCommandFieldIndex(game);
        if (recoverableDoublePartnerFieldIndex != null) {
          const currentCommandPhaseFieldIndex = getCurrentCommandPhaseFieldIndex(game);
          console.error(
            `[modifier-fixed-seed-double-followup-recover-command] wave=${game.scene.currentBattle?.waveIndex ?? "unknown"} field=${recoverableDoublePartnerFieldIndex} phaseField=${currentCommandPhaseFieldIndex ?? "unknown"}`,
          );
          const recoverStatus = await waitForPromiseOrTerminal(
            game,
            withTimeout(game.phaseInterceptor.to("CommandPhase"), timeoutMs, "double_followup_command_phase_recover"),
            timeoutMs,
          );
          if (recoverStatus !== "ok") {
            return recoverStatus;
          }
          await sleep(25);
          continue;
        }
      }
    } else {
      stuckCommandMessageSince = null;
    }

    if (
      game.isCurrentPhase("EnemyCommandPhase")
      || game.isCurrentPhase("TurnStartPhase")
      || game.isCurrentPhase("MovePhase")
      || game.isCurrentPhase("TurnEndPhase")
      || game.isCurrentPhase("TurnInitPhase")
    ) {
      return "turn_progressed";
    }

    if (advanceCurrentUiPromptIfPossible(game)) {
      await sleep(25);
      continue;
    }
    await sleep(25);
  }

  return isCombatTerminalPhase(game) ? "terminal" : "timeout";
}

/**
 * Advances the game after a double-battle combat action has already been
 * queued for `action.acting_field_index`, until the next stable CommandPhase,
 * a terminal phase, or `stepTimeoutMs` elapses. This is the exact function
 * behind the historical `step_timeout:advance_double_combat_after_action`
 * collector timeouts - see docs/pokerogue-headless-test-harness-mechanics.md.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verbatim move from the production collector template; restructuring risks changing behavior, see AGENTS.md harness/ exception
export async function advanceDoubleCombatAfterAction(
  game: GameManager,
  action: DoubleCombatAdvanceAction,
  stepTimeoutMs: number,
): Promise<AdvanceStatus> {
  const startingWaveIndex = game.scene.currentBattle?.waveIndex ?? 0;
  const startingTurn = game.scene.currentBattle?.turn ?? 0;
  const needsTargetSelection = action.action_kind === "move" && action.expects_select_target_phase === true;

  if (needsTargetSelection) {
    const targetStatus = await waitForDoubleTargetPhaseOrImmediateFollowup(
      game,
      action,
      startingWaveIndex,
      startingTurn,
      stepTimeoutMs,
    );
    if (targetStatus === "ok") {
      return "ok";
    }
    if (targetStatus !== "select_target") {
      return targetStatus;
    }
    const targetResolutionStatus = await waitForDoubleTargetSelectionResolution(game, stepTimeoutMs);
    if (targetResolutionStatus !== "ok") {
      return targetResolutionStatus;
    }
    if (action.acting_field_index === 0 && isStableCommandInputState(game)) {
      const fieldIndex = getCommandFieldIndexSafe(game);
      const currentWaveIndex = game.scene.currentBattle?.waveIndex ?? startingWaveIndex;
      const currentTurn = game.scene.currentBattle?.turn ?? startingTurn;
      if (fieldIndex > 0 || currentTurn > startingTurn || currentWaveIndex > startingWaveIndex) {
        return "ok";
      }
    }
  }

  if (isCombatTerminalPhase(game)) {
    return "terminal";
  }

  if (action.acting_field_index === 0) {
    const fieldZeroFollowupStatus = await waitForDoubleFieldZeroFollowup(
      game,
      startingWaveIndex,
      startingTurn,
      stepTimeoutMs,
    );
    if (fieldZeroFollowupStatus === "terminal" || fieldZeroFollowupStatus === "timeout") {
      return fieldZeroFollowupStatus;
    }
    if (fieldZeroFollowupStatus === "partner_command") {
      return isCombatTerminalPhase(game) ? "terminal" : "ok";
    }
    if (hasAdvancedToStableCommandState(game, startingWaveIndex, startingTurn)) {
      return "ok";
    }
    const nextTurnStatus = await waitForPromiseOrTerminal(
      game,
      withTimeout(game.toNextTurn(), stepTimeoutMs, "double_field0_to_next_turn"),
      stepTimeoutMs,
      currentGame => hasAdvancedToStableCommandState(currentGame, startingWaveIndex, startingTurn),
    );
    if (nextTurnStatus !== "ok") {
      return nextTurnStatus;
    }
    return "ok";
  }

  const nextTurnStatus = await waitForPromiseOrTerminal(
    game,
    withTimeout(game.toNextTurn(), stepTimeoutMs, "double_to_next_turn"),
    stepTimeoutMs,
    currentGame => hasAdvancedToStableCommandState(currentGame, startingWaveIndex, startingTurn),
  );
  if (nextTurnStatus !== "ok") {
    return nextTurnStatus;
  }
  return "ok";
}
