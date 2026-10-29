export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  onClick?: (event: MouseEvent) => void;
  className?: string;
}

export function renderButton(props: ButtonProps): HTMLButtonElement {
  const btn = document.createElement('button');
  const variant = props.variant ?? 'secondary';
  const size = props.size ?? 'md';

  btn.type = props.type ?? 'button';
  btn.className = `btn btn-${variant} btn-${size} ${props.className ?? ''}`.trim();
  btn.disabled = !!props.disabled;

  let content = '';
  if (props.icon) {
    content += `<span class="btn-icon">${props.icon}</span>`;
  }
  content += `<span class="btn-label">${props.label}</span>`;
  btn.innerHTML = content;

  if (props.onClick) {
    btn.addEventListener('click', props.onClick);
  }

  return btn;
}
