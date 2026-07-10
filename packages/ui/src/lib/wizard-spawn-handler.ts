/**
 * Minimal, testable wizard-spawn handler.
 *
 * Keeps the wizard open while spawning and only closes it once the session
 * is confirmed live and has been opened. Errors/timeouts leave the wizard
 * open and editable.
 */

export interface WizardSpawnHandlerOptions {
  /** Spawn a session and resolve only after it is live. */
  spawnSession: (runnerId: string, cwd: string | undefined) => Promise<string>;
  /** Open the newly spawned session. */
  openSession: (sessionId: string) => void;
  /** Close the wizard. */
  setOpen: (open: boolean) => void;
}

export function createWizardSpawnHandler(options: WizardSpawnHandlerOptions) {
  return async (runnerId: string, cwd: string | undefined): Promise<void> => {
    const sessionId = await options.spawnSession(runnerId, cwd);
    options.openSession(sessionId);
    options.setOpen(false);
  };
}
