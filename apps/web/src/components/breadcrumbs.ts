export interface BreadcrumbItem {
  label: string;
  path?: string;
  onClick?: (event: MouseEvent) => void;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  separator?: string;
}

export function renderBreadcrumbs(props: BreadcrumbsProps): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'app-breadcrumbs';
  nav.setAttribute('aria-label', 'Breadcrumb');

  const sep = props.separator ?? '>';

  props.items.forEach((item, index) => {
    const isLast = index === props.items.length - 1;

    if (item.path && !isLast) {
      const a = document.createElement('a');
      a.href = item.path;
      a.textContent = item.label;
      if (item.onClick) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          item.onClick!(e);
        });
      }
      nav.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = isLast ? 'current' : 'crumb';
      span.textContent = item.label;
      nav.appendChild(span);
    }

    if (!isLast) {
      const separatorSpan = document.createElement('span');
      separatorSpan.className = 'separator';
      separatorSpan.textContent = sep;
      nav.appendChild(separatorSpan);
    }
  });

  return nav;
}
