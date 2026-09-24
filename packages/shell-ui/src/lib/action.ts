/**
 * One button, one call, one answer — the shape every settings action has.
 *
 * The pages under settings/sections are made of buttons that ask main for
 * something and then say what came back: a spinner while it is in flight, the
 * failure in place when there is one, and nothing optimistic in between
 * (settings/sections/account.tsx says why). Written out by hand that is three
 * pieces of state and a `finally` per button, and a `finally` that is left out
 * is a spinner that never stops.
 *
 * `useAsyncAction` holds those three pieces once. The work answers the failure
 * to show — or null when it succeeded — so both shapes main offers fit without
 * a wrapper: the actions that answer `string | null` are returned directly, and
 * the ones that answer a `Result` are unwrapped in a line. Anything thrown
 * (the handful of `shellApi()` calls that reject rather than resolve) is
 * caught and described by `describe`, so busy always comes back down.
 */

import { useCallback, useState } from "react";

export interface AsyncAction {
  /** In flight: for `loading` on the button and `disabled` on its inputs. */
  busy: boolean;
  /** What the last run failed with, or null. */
  error: string | null;
  /** For clearing the message when a dialog closes or a field is retyped. */
  setError: (message: string | null) => void;
  /** Run the work, and answer whether it succeeded. */
  run: (work: () => Promise<string | null>) => Promise<boolean>;
}

/** What a thrown rejection says when the caller has nothing better. */
export function actionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAsyncAction(describe: (error: unknown) => string = actionMessage): AsyncAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (work: () => Promise<string | null>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const failure = await work();
        setError(failure);
        return failure === null;
      } catch (cause) {
        setError(describe(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [describe],
  );

  return { busy, error, setError, run };
}
