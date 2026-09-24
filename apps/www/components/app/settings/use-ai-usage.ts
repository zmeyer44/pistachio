"use client";

/**
 * The account's model meter, read once on mount and replaced whenever a
 * page moves the cap. Shared by the usage and billing pages so both say
 * the same thing about the same month.
 */

import { useCallback, useEffect, useState } from "react";
import { type AiUsageSummary, getAiUsage, useSession } from "@pistachio/web-account";

export function useAiUsage(): {
  usage: AiUsageSummary | null;
  error: string | null;
  setUsage: (next: AiUsageSummary) => void;
} {
  const { token } = useSession();
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (token === null) return;
    try {
      setUsage(await getAiUsage(token));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The meter could not be read.");
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { usage, error, setUsage };
}
