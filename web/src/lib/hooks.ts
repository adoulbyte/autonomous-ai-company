import { useCallback, useEffect, useRef, useState } from 'react';

/** Load real data; expose loading/error/reload. Optional polling interval (ms). */
export function useData<T>(loader: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader); loaderRef.current = loader;
  const reload = useCallback(async () => {
    try { setError(null); setData(await loaderRef.current()); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { setLoading(true); reload(); /* eslint-disable-next-line */ }, deps);
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, reload]);
  return { data, error, loading, reload, setData };
}
