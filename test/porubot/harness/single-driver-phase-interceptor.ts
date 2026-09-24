import type { Phase } from "#app/phase";
import { TEST_TIMEOUT } from "#test/constants";
import type { GameManager } from "#test/framework/game-manager";
import type { PhaseString } from "#types/phase-types";
import { vi } from "vitest";

/**
 * Phases whose "end" is signalled by a UI mode change rather than by the phase
 * itself finishing - mirrors `endBySetMode` in test/helpers/prompt-handler.ts,
 * which is where PhaseInterceptor.checkMode() gets triggered for these.
 */
const END_BY_SET_MODE_PHASES: readonly PhaseString[] = [
  "CommandPhase",
  "TitlePhase",
  "SelectGenderPhase",
  "SelectStarterPhase",
  "SelectModifierPhase",
  "MysteryEncounterPhase",
  "PostMysteryEncounterPhase",
];

/** The private PhaseInterceptor members this module has to reach into. */
interface PhaseInterceptorInternals {
  state: "running" | "interrupted" | "idling";
  target: PhaseString;
  scene: GameManager["scene"];
  run: (phase: Phase) => Promise<void>;
  checkMode: () => void;
  doLog: (...args: unknown[]) => void;
  to: (target: PhaseString, runTarget?: boolean) => Promise<void>;
  __porubotSingleDriverInstalled?: boolean;
}

type DriverStep =
  | "stop"
  | "wait_interrupted"
  | "wait_running"
  | "target_already_running"
  | "target_reached"
  | "run_current";

/** Decides what a single to() call should do on its next poll tick. */
function nextDriverStep(interceptor: PhaseInterceptorInternals, target: PhaseString, superseded: boolean): DriverStep {
  if (superseded) {
    return "stop";
  }
  if (interceptor.state === "interrupted") {
    return "wait_interrupted";
  }
  const isTargetCurrent = interceptor.scene.phaseManager.getCurrentPhase().is(target);
  if (interceptor.state === "running") {
    // Some (now superseded) earlier call is still running this phase -
    // never start() it a second time.
    return isTargetCurrent ? "target_already_running" : "wait_running";
  }
  return isTargetCurrent ? "target_reached" : "run_current";
}

/**
 * Makes `game.phaseInterceptor.to()` safe against overlapping calls.
 *
 * The stock PhaseInterceptor.to() (test/framework/phase-interceptor.ts) assumes
 * there is only ever one caller at a time: all calls share a single `target`
 * field, and each call start()s whatever phase is current without checking
 * whether another call is already running it. The collector harness routinely
 * leaves earlier to() calls pending (an abandoned background toNextTurn(), a
 * superseded recovery pump, ...). Those turn into "zombie" drivers as soon as
 * the phase they were waiting on ends, which then:
 * - start() the same Phase instance a second time - its second end() shifts
 *   the phase queue again and silently skips the next queued phase (observed:
 *   a lost FaintPhase, so a fainted Pokemon never got switched out), and
 * - resolve on another caller's target (the shared `target` field), leaving
 *   the real caller chasing a phase that already ran until it wedges at the
 *   next CommandPhase (observed: step_timeout:advance_combat_after_action).
 * See docs/pokerogue-headless-test-harness-mechanics.md (main repo).
 *
 * After installation, only the most recent to() call drives phases. Any older,
 * still-pending call goes permanently dormant (its promise never settles - it
 * neither falsely reports reaching its target nor rejects), and a phase that is
 * already running is never start()ed again. Idempotent per GameManager.
 */
export function installSingleDriverPhaseInterceptor(game: GameManager): void {
  const interceptor = game.phaseInterceptor as unknown as PhaseInterceptorInternals;
  if (interceptor.__porubotSingleDriverInstalled) {
    return;
  }
  interceptor.__porubotSingleDriverInstalled = true;

  let latestGeneration = 0;

  interceptor.to = async (target: PhaseString, runTarget = true): Promise<void> => {
    const generation = ++latestGeneration;
    const isSuperseded = () => generation !== latestGeneration;
    // Still set for PhaseInterceptor.checkMode(), which only interrupts the
    // phase the (single, current) driver is aiming at.
    interceptor.target = target;
    const phaseManager = interceptor.scene.phaseManager;

    let didLogInterrupted = false;
    let targetAlreadyRunning = false;
    await vi.waitUntil(
      async () => {
        const step = nextDriverStep(interceptor, target, isSuperseded());
        if (step === "wait_interrupted" && !didLogInterrupted) {
          interceptor.doLog("PhaseInterceptor.to: Waiting for phase to end after being interrupted!");
          didLogInterrupted = true;
        }
        if (step === "target_already_running") {
          targetAlreadyRunning = true;
        }
        if (step === "run_current") {
          await interceptor.run(phaseManager.getCurrentPhase());
          return false;
        }
        return step === "stop" || step === "target_reached" || step === "target_already_running";
      },
      { interval: 0, timeout: TEST_TIMEOUT },
    );

    if (isSuperseded()) {
      // A newer to() call owns phase driving now; stay dormant forever.
      return new Promise<void>(() => {});
    }

    if (targetAlreadyRunning) {
      if (END_BY_SET_MODE_PHASES.includes(target)) {
        // Its UI prompt already opened while another call was driving, so the
        // PromptHandler's checkMode() call for it has already passed - replay it.
        interceptor.checkMode();
      } else {
        await vi.waitUntil(() => interceptor.state !== "running", { interval: 50, timeout: TEST_TIMEOUT });
      }
      interceptor.doLog(`PhaseInterceptor.to: Stopping after ${target} (already running when reached)`);
      return;
    }

    if (!runTarget) {
      interceptor.doLog(`PhaseInterceptor.to: Stopping before running ${target}`);
      return;
    }

    await interceptor.run(phaseManager.getCurrentPhase());
    interceptor.doLog(
      `PhaseInterceptor.to: Stopping ${interceptor.state === "interrupted" ? "after being interrupted during" : "on completion of"} ${target}`,
    );
  };
}
