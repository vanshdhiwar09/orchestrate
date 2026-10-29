export interface CardProps {
  title?: string;
  subtitle?: string;
  headerAction?: HTMLElement | string;
  className?: string;
  bodyContent?: HTMLElement | string;
}

export function renderCard(props: CardProps): HTMLElement {
  const card = document.createElement('div');
  card.className = `card ${props.className ?? ''}`.trim();

  if (props.title || props.subtitle || props.headerAction) {
    const header = document.createElement('div');
    header.className = 'card-header';

    const titleGroup = document.createElement('div');
    titleGroup.style.display = 'flex';
    titleGroup.style.flexDirection = 'column';
    titleGroup.style.gap = '2px';

    if (props.title) {
      const title = document.createElement('h3');
      title.className = 'card-title';
      title.textContent = props.title;
      titleGroup.appendChild(title);
    }

    if (props.subtitle) {
      const subtitle = document.createElement('p');
      subtitle.className = 'card-subtitle';
      subtitle.textContent = props.subtitle;
      titleGroup.appendChild(subtitle);
    }

    header.appendChild(titleGroup);

    if (props.headerAction) {
      const actionSlot = document.createElement('div');
      actionSlot.className = 'card-header-action';
      if (typeof props.headerAction === 'string') {
        actionSlot.innerHTML = props.headerAction;
      } else {
        actionSlot.appendChild(props.headerAction);
      }
      header.appendChild(actionSlot);
    }

    card.appendChild(header);
  }

  if (props.bodyContent) {
    const body = document.createElement('div');
    body.className = 'card-body';
    if (typeof props.bodyContent === 'string') {
      body.innerHTML = props.bodyContent;
    } else {
      body.appendChild(props.bodyContent);
    }
    card.appendChild(body);
  }

  return card;
}
