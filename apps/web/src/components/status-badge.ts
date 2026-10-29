export type StatusBadgeVariant =
  | 'VERIFIED'
  | 'CLAIMED'
  | 'FAILED'
  | 'BLOCKED_NEEDS_HUMAN'
  | 'UNVERIFIED'
  | 'IN PROGRESS'
  | 'INFERRED'
  | 'ACTIVE';

export interface StatusBadgeProps {
  status: StatusBadgeVariant | string;
  label?: string;
  className?: string;
}

export function renderStatusBadge(props: StatusBadgeProps): HTMLElement {
  const badge = document.createElement('span');
  const normalized = (props.status || '').toUpperCase();

  let cssClass = 'unverified';
  let icon = '○';
  let defaultLabel = props.status;

  switch (normalized) {
    case 'VERIFIED':
      cssClass = 'verified';
      icon = '✓';
      defaultLabel = 'Verified';
      break;
    case 'CLAIMED':
      cssClass = 'claimed';
      icon = '◔';
      defaultLabel = 'Claimed';
      break;
    case 'FAILED':
      cssClass = 'failed';
      icon = '✕';
      defaultLabel = 'Failed';
      break;
    case 'BLOCKED_NEEDS_HUMAN':
    case 'BLOCKED':
      cssClass = 'blocked';
      icon = '!';
      defaultLabel = 'Blocked · needs human';
      break;
    case 'IN PROGRESS':
    case 'IN_PROGRESS':
      cssClass = 'in-progress';
      icon = '⋯';
      defaultLabel = 'In Progress';
      break;
    case 'INFERRED':
      cssClass = 'inferred';
      icon = '✦';
      defaultLabel = 'Inferred';
      break;
    case 'ACTIVE':
      cssClass = 'active';
      icon = '●';
      defaultLabel = 'Active';
      break;
    default:
      cssClass = 'unverified';
      icon = '○';
      defaultLabel = props.status || 'Unverified';
      break;
  }

  badge.className = `status-badge ${cssClass} ${props.className ?? ''}`.trim();
  badge.innerHTML = `<span class="badge-icon">${icon}</span> <span class="badge-text">${props.label ?? defaultLabel}</span>`;
  return badge;
}
