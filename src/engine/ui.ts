import { gsap } from 'gsap';
import type { Director, SceneChange } from './director';
import { reducedMotion } from './palette';

/** Caption, scene dots and keyboard/click navigation. */
export function mountUI(director: Director) {
  const caption = document.getElementById('caption')!;
  const step = caption.querySelector<HTMLElement>('.step')!;
  const title = caption.querySelector<HTMLElement>('.title')!;
  const body = caption.querySelector<HTMLElement>('.body')!;
  const nav = document.getElementById('nav')!;
  const dots = nav.querySelector<HTMLOListElement>('.dots')!;
  const prev = nav.querySelector<HTMLButtonElement>('.prev')!;
  const next = nav.querySelector<HTMLButtonElement>('.next')!;
  const hint = nav.querySelector<HTMLElement>('.hint')!;
  const deckTitle = document.querySelector<HTMLElement>('.deck-title')!;
  const total = director.scenes.length;

  const dotButtons = director.scenes.map((scene, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `Scene ${i + 1}: ${scene.title}`);
    button.addEventListener('click', () => director.go(i));
    li.appendChild(button);
    dots.appendChild(li);
    return button;
  });

  prev.addEventListener('click', () => director.prev());
  next.addEventListener('click', () => director.next());
  document.getElementById('stage')!.addEventListener('click', () => director.next());

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) director.next();
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) director.prev();
    else if (e.key === 'Home') director.go(0);
    else if (e.key === 'End') director.go(total - 1);
    else return;
    e.preventDefault();
  });

  let captionTimeline: gsap.core.Timeline | undefined;
  let firstChange = true;

  director.onChange(({ index, scene, forward, accent }: SceneChange) => {
    history.replaceState(null, '', `#${index + 1}`);
    dotButtons.forEach((b, i) => b.toggleAttribute('aria-current', i === index));
    prev.disabled = index === 0;
    next.disabled = index === total - 1;
    if (index > 0) hint.classList.add('is-gone');
    deckTitle.classList.toggle('is-gone', index > 0);

    const write = () => {
      step.textContent = `${index + 1} of ${total}`;
      title.textContent = scene.title;
      body.innerHTML = withCode(scene.body);
      caption.style.setProperty('--accent', accent ?? 'var(--muted)');
    };

    captionTimeline?.kill();
    const lines = [step, title, body];
    if (firstChange || reducedMotion) {
      write();
      gsap.set(lines, { opacity: 1, y: 0 });
      firstChange = false;
      return;
    }
    const shift = forward ? 12 : -12;
    captionTimeline = gsap
      .timeline()
      .to(lines, { opacity: 0, y: -shift, duration: 0.25, ease: 'power1.in', stagger: 0.03 })
      .add(write)
      // fromTo applies its start value as soon as the timeline is built unless told not
      // to, which snapped the outgoing text down before it faded.
      .fromTo(
        lines,
        { y: shift },
        { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.06, immediateRender: false },
        '+=0.15',
      );
  });
}

/** Escape text, then turn `backticked` spans into <code>. */
function withCode(text: string) {
  const escaped = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}
