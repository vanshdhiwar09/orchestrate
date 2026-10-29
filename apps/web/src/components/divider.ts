export function renderDivider(className?: string): HTMLElement {
  const hr = document.createElement('hr');
  hr.className = `divider ${className ?? ''}`.trim();
  return hr;
}
