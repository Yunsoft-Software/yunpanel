import { collectionReducer, initialCollection } from './resource-model.js';

export const initialScopedCollection = () => ({ scope: null, run: 0, value: initialCollection() });
const disabled = () => ({ ...initialCollection(), status: 'disabled' });

// Scope identity changes on a new path or enable/disable transition. A run ID
// separately fences overlapping manual refreshes of the same resource.
export function scopedCollectionReducer(state, action) {
  if (action.type === 'begin') {
    return {
      scope: action.scope, run: action.run,
      value: !action.scope.enabled ? disabled()
        : state.scope === action.scope ? state.value : initialCollection(),
    };
  }
  if (!state.scope?.enabled || state.scope !== action.scope || state.run !== action.run) return state;
  return { ...state, value: collectionReducer(state.value, action) };
}

// Mask on the render where props change, before effect cleanup/setup can run.
export function scopedCollectionView(state, scope) {
  if (!scope.enabled) return disabled();
  return state.scope === scope ? state.value : initialCollection();
}
