import { useCallback, useMemo, useReducer } from "react";
import type { NavigationAction, NavigationParams, NavigationState, Screen } from "./types";

export function navigationReducer(state: NavigationState, action: NavigationAction): NavigationState {
  switch (action.type) {
    case "NAVIGATE":
      return {
        current: action.screen,
        params: action.params,
        history: [...state.history, { screen: state.current, params: state.params }],
      };
    case "GO_BACK": {
      if (state.history.length === 0) return state;
      const previous = state.history[state.history.length - 1];
      return { current: previous.screen, params: previous.params, history: state.history.slice(0, -1) };
    }
    case "RESET":
      return { current: action.screen, params: action.params, history: [] };
  }
}

export function useNavigation() {
  const [state, dispatch] = useReducer(navigationReducer, {
    current: "Workspaces" as Screen,
    params: undefined,
    history: [],
  });

  const navigate = useCallback((screen: Screen, params?: Record<string, unknown>) => {
    dispatch({ type: "NAVIGATE", screen, params });
  }, []);
  const goBack = useCallback(() => { dispatch({ type: "GO_BACK" }); }, []);
  const reset = useCallback((screen: Screen, params?: Record<string, unknown>) => {
    dispatch({ type: "RESET", screen, params });
  }, []);

  // Stable identity, so effects that depend on the navigation object (the push
  // response listener among them) do not resubscribe on every render.
  return useMemo(() => ({
    currentScreen: state.current,
    currentParams: state.params as NavigationParams[Screen] | undefined,
    canGoBack: state.history.length > 0,
    navigate,
    goBack,
    reset,
  }), [state, navigate, goBack, reset]);
}