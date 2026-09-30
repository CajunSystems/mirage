import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useNavigate, useParams } from "react-router";
import type { Action, DataResult, DataSource } from "@mirage/core";
import { MirageRuntime, httpCallTool, type CallTool } from "./runtime.js";

export type UseMirageOptions = {
  route: string;
  data?: Record<string, DataSource>;
  state?: Record<string, unknown>;
  callTool?: CallTool;
};

/**
 * The runtime behind an ejected page: same data sources, state and actions as the spec,
 * with the resolution done by hand in JSX.
 */
export function useMirage({ route, data, state, callTool }: UseMirageOptions) {
  const params = useParams() as Record<string, string>;
  const navigate = useNavigate();
  const ref = useRef<MirageRuntime | null>(null);
  const options = { params, navigate, callTool: callTool ?? httpCallTool(route, params) };
  if (!ref.current) ref.current = new MirageRuntime(options);
  const runtime = ref.current;
  runtime.options = options;
  const paramsKey = JSON.stringify(params);
  useEffect(() => runtime.update(data, state), [runtime, paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const version = useSyncExternalStore(runtime.subscribe, runtime.getVersion, runtime.getVersion);
  return useMemo(
    () => ({
      /** For `z.ref()` props. */
      ref: (binding: unknown): DataResult => runtime.resolveRef(binding),
      /** For any other bound value. */
      value: <T = unknown>(binding: unknown) => runtime.resolve(binding) as T,
      /** For `z.action()` props. */
      action: (action: Action) => (event?: unknown) => runtime.dispatch(action, event),
      runtime,
    }),
    [runtime, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
}
