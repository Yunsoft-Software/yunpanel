import { panelRequest } from '../api.js';

export function getPanelSettings() {
  return panelRequest('/panel/settings');
}

export function updatePanelSettings(patch) {
  return panelRequest('/panel/settings', {
    method: 'PATCH',
    body: patch,
  });
}
