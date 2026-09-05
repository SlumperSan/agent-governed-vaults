// Transient. Renders this section on its own, so the port can be diffed
// against apps/site/faq.html before src/pages/FaqPage.tsx exists.
import { renderToString } from 'react-dom/server';
import FaqQuestions from '../FaqQuestions';
import classes from '../FaqQuestions.module.css';

export function renderSection(): string {
  return renderToString(<FaqQuestions />);
}

/** local class name -> generated class name, so the preview can rewrite the
 *  stylesheet rather than guess at the hashes. */
export const classMap: Record<string, string> = classes;
